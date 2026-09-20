/**
 * 위험률 시트의 미니 수식. Excel과 같은 A1 참조로 상수·다른 열·바로 위 행을 끌어 쓴다.
 * A열은 연령(읽기 전용), B열부터 위험률 열이다. 예: B3 자리에 `=B2` → 위 행 값을 그대로 반복,
 * `=C3*0.5` → 다른 열의 절반, `=0.0012` → 상수, `=IF(A3<65,C3,0)` → 65세부터 0.
 * 지원: + − * / 비교(< <= > >= = <>) 괄호 단항마이너스 · 숫자 · A1 참조 · IF MIN MAX ABS ROUND SUM.
 * 수식은 AST로 한 번 파싱해 캐시하고, IF는 고른 가지만 계산한다(안 고른 가지의 0 나눗셈은 무시).
 */

export type CellError = "#NAME?" | "#REF!" | "#DIV/0!" | "#CIRC!" | "#SYNTAX!";
export const CELL_ERROR_KO: Record<CellError, string> = {
  "#NAME?": "모르는 함수입니다 — IF·MIN·MAX·ABS·ROUND·SUM만 씁니다",
  "#REF!": "표 밖의 칸을 가리킵니다",
  "#DIV/0!": "0으로 나눌 수 없습니다",
  "#CIRC!": "순환 참조입니다 — 수식이 서로를 가리킵니다",
  "#SYNTAX!": "수식을 읽을 수 없습니다",
};
export const isCellError = (v: unknown): v is CellError => typeof v === "string" && v in CELL_ERROR_KO;

/** 0 → A, 25 → Z, 26 → AA */
export function colLetter(i: number): string {
  let s = "";
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) s = String.fromCharCode(65 + (n % 26)) + s;
  return s;
}
/** "A" → 0, "AA" → 26. 알 수 없으면 −1 */
export function colIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) {
    const d = ch.charCodeAt(0) - 64;
    if (d < 1 || d > 26) return -1;
    n = n * 26 + d;
  }
  return n - 1;
}

export const isFormula = (s: string) => s.trim().startsWith("=") && s.trim().length > 1;

/**
 * 수식의 상대 행 참조를 dRow 만큼 민다(채우기용). `$3` 처럼 $가 붙은 행은 고정.
 * 위 행을 가리키는 `=B2`를 아래로 채우면 `=B3`, `=B4` … 가 되어 "앞 값 이어받기"가 된다.
 */
export function shiftRows(formula: string, dRow: number): string {
  if (!isFormula(formula)) return formula;
  return formula.replace(/\$?[A-Za-z]+\$?\d+/g, (m) => {
    const mm = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/.exec(m);
    if (!mm) return m;
    const [, colAbs, col, rowAbs, row] = mm;
    if (rowAbs === "$") return m;
    return `${colAbs}${col}${rowAbs}${Math.max(1, Number(row) + dRow)}`;
  });
}

/** 수식이 가리키는 칸 목록(안내·검증용) */
export function refsOf(formula: string): { r: number; c: number }[] {
  if (!isFormula(formula)) return [];
  const out: { r: number; c: number }[] = [];
  const re = /\$?([A-Za-z]+)\$?(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) {
    const c = colIndex(m[1]), r = Number(m[2]) - 1;
    if (c >= 0 && r >= 0) out.push({ r, c });
  }
  return out;
}

// ── 토크나이저 ───────────────────────────────────────────────────────────────
type Tok = { t: "num" | "ref" | "id" | "op"; s: string };
const TOKEN_RE = /\s*(?:(\$?[A-Za-z]+\$?\d+)|(\d*\.?\d+(?:[eE][+-]?\d+)?)|([A-Za-z]+)|(<=|>=|<>|[()+\-*/,<>=:])|(\S))/g;

class Fail extends Error { constructor(readonly code: CellError) { super(code); } }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null, end = 0;
  while ((m = TOKEN_RE.exec(src))) {
    if (m.index !== end) throw new Fail("#SYNTAX!");
    end = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) out.push({ t: "ref", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "num", s: m[2] });
    else if (m[3] !== undefined) out.push({ t: "id", s: m[3].toUpperCase() });
    else if (m[4] !== undefined) out.push({ t: "op", s: m[4] });
    else throw new Fail("#SYNTAX!");
  }
  if (src.slice(end).trim() !== "") throw new Fail("#SYNTAX!");
  return out;
}

// ── AST ─────────────────────────────────────────────────────────────────────
type Node =
  | { k: "num"; v: number }
  | { k: "ref"; r: number; c: number }
  | { k: "range"; r0: number; c0: number; r1: number; c1: number }
  | { k: "neg"; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "fn"; name: string; args: Node[] };

const cellOf = (s: string): { r: number; c: number } => {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(s);
  if (!m) throw new Fail("#REF!");
  const c = colIndex(m[1]), r = Number(m[2]) - 1;
  if (c < 0 || r < 0) throw new Fail("#REF!");
  return { r, c };
};

function parse(toks: Tok[]): Node {
  let i = 0;
  const at = () => toks[i];
  const eat = (s: string) => (toks[i]?.s === s ? (i++, true) : false);

  const primary = (): Node => {
    const t = at();
    if (!t) throw new Fail("#SYNTAX!");
    if (eat("-")) return { k: "neg", a: primary() };
    if (eat("+")) return primary();
    if (eat("(")) { const v = compare(); if (!eat(")")) throw new Fail("#SYNTAX!"); return v; }
    if (t.t === "num") { i++; return { k: "num", v: Number(t.s) }; }
    if (t.t === "ref") {
      i++;
      const a = cellOf(t.s);
      if (eat(":")) {
        const t2 = at();
        if (!t2 || t2.t !== "ref") throw new Fail("#SYNTAX!");
        i++;
        const b = cellOf(t2.s);
        return { k: "range", r0: Math.min(a.r, b.r), c0: Math.min(a.c, b.c), r1: Math.max(a.r, b.r), c1: Math.max(a.c, b.c) };
      }
      return { k: "ref", ...a };
    }
    if (t.t === "id") {
      i++;
      if (!eat("(")) throw new Fail("#NAME?");
      const args: Node[] = [];
      if (!eat(")")) {
        do { args.push(compare()); } while (eat(","));
        if (!eat(")")) throw new Fail("#SYNTAX!");
      }
      if (!["IF", "MIN", "MAX", "ABS", "ROUND", "SUM"].includes(t.s)) throw new Fail("#NAME?");
      return { k: "fn", name: t.s, args };
    }
    throw new Fail("#SYNTAX!");
  };

  const term = (): Node => {
    let a = primary();
    for (;;) {
      if (eat("*")) a = { k: "bin", op: "*", a, b: primary() };
      else if (eat("/")) a = { k: "bin", op: "/", a, b: primary() };
      else return a;
    }
  };
  const sum = (): Node => {
    let a = term();
    for (;;) {
      if (eat("+")) a = { k: "bin", op: "+", a, b: term() };
      else if (eat("-")) a = { k: "bin", op: "-", a, b: term() };
      else return a;
    }
  };
  const compare = (): Node => {
    const a = sum();
    for (const op of ["<=", ">=", "<>", "<", ">", "="]) if (eat(op)) return { k: "bin", op, a, b: sum() };
    return a;
  };

  const root = compare();
  if (i !== toks.length) throw new Fail("#SYNTAX!");
  return root;
}

const cache = new Map<string, Node | CellError>();
function ast(src: string): Node {
  let n = cache.get(src);
  if (n === undefined) {
    try { n = parse(tokenize(src)); } catch (e) { n = e instanceof Fail ? e.code : "#SYNTAX!"; }
    cache.set(src, n);
  }
  if (typeof n === "string") throw new Fail(n);
  return n;
}

type Get = (r: number, c: number) => number;

function evalNode(n: Node, get: Get): number {
  switch (n.k) {
    case "num": return n.v;
    case "ref": return get(n.r, n.c);
    case "range": throw new Fail("#SYNTAX!");            // 범위는 SUM 안에서만
    case "neg": return -evalNode(n.a, get);
    case "bin": {
      if (n.op === "/") { const d = evalNode(n.b, get); if (d === 0) throw new Fail("#DIV/0!"); return evalNode(n.a, get) / d; }
      const a = evalNode(n.a, get), b = evalNode(n.b, get);
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "<": return a < b ? 1 : 0;
        case "<=": return a <= b ? 1 : 0;
        case ">": return a > b ? 1 : 0;
        case ">=": return a >= b ? 1 : 0;
        case "=": return a === b ? 1 : 0;
        case "<>": return a !== b ? 1 : 0;
        default: throw new Fail("#SYNTAX!");
      }
    }
    case "fn": {
      if (n.name === "IF") {
        if (n.args.length < 2) throw new Fail("#SYNTAX!");
        return evalNode(n.args[0], get) !== 0 ? evalNode(n.args[1], get) : n.args[2] ? evalNode(n.args[2], get) : 0;
      }
      const flat: number[] = [];
      for (const a of n.args) {
        if (a.k === "range") { for (let r = a.r0; r <= a.r1; r++) for (let c = a.c0; c <= a.c1; c++) flat.push(get(r, c)); }
        else flat.push(evalNode(a, get));
      }
      switch (n.name) {
        case "MIN": return flat.length ? Math.min(...flat) : 0;
        case "MAX": return flat.length ? Math.max(...flat) : 0;
        case "SUM": return flat.reduce((s, x) => s + x, 0);
        case "ABS": return Math.abs(flat[0] ?? 0);
        case "ROUND": { const p = 10 ** Math.round(flat[1] ?? 0); return Math.round((flat[0] ?? 0) * p) / p; }
        default: throw new Fail("#NAME?");
      }
    }
  }
}

export interface SheetCells {
  rows: number;
  cols: number;                          // A열(연령) 포함한 열 수
  raw: (r: number, c: number) => string; // 원본 입력. A열은 연령 문자열
}
export interface SheetValues {
  values: number[][];                    // [row][col], 오류 칸은 0
  errors: (CellError | null)[][];
}

/** 시트 전체 평가. 오류 칸은 값 0 + 오류 코드로 남기고 나머지는 계속 계산한다. */
export function evaluateSheet(s: SheetCells): SheetValues {
  const values: number[][] = Array.from({ length: s.rows }, () => new Array<number>(s.cols).fill(0));
  const errors: (CellError | null)[][] = Array.from({ length: s.rows }, () => new Array<CellError | null>(s.cols).fill(null));
  const state = Array.from({ length: s.rows }, () => new Array<0 | 1 | 2>(s.cols).fill(0));   // 0 미방문 1 방문중 2 완료

  const get = (r: number, c: number): number => {
    if (r < 0 || r >= s.rows || c < 0 || c >= s.cols) throw new Fail("#REF!");
    if (state[r][c] === 1) throw new Fail("#CIRC!");
    if (state[r][c] === 2) { const e = errors[r][c]; if (e) throw new Fail(e); return values[r][c]; }
    return calc(r, c);
  };

  const calc = (r: number, c: number): number => {
    state[r][c] = 1;
    let v = 0, err: CellError | null = null;
    const raw = (s.raw(r, c) ?? "").trim();
    try {
      if (raw === "") v = 0;
      else if (isFormula(raw)) v = evalNode(ast(raw.slice(1)), get);
      else {
        const num = Number(raw.replace(/[,\s]/g, ""));
        if (Number.isFinite(num)) v = num; else { v = 0; err = "#SYNTAX!"; }
      }
      if (!Number.isFinite(v)) { v = 0; err = err ?? "#DIV/0!"; }
    } catch (e) {
      v = 0; err = e instanceof Fail ? e.code : "#SYNTAX!";
    }
    values[r][c] = v; errors[r][c] = err; state[r][c] = 2;
    if (err) throw new Fail(err);
    return v;
  };

  for (let r = 0; r < s.rows; r++) {
    for (let c = 0; c < s.cols; c++) {
      if (state[r][c] === 2) continue;
      try { calc(r, c); } catch { /* 오류는 errors에 남았다 */ }
    }
  }
  return { values, errors };
}
