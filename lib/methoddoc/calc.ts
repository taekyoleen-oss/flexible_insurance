/**
 * 산출방법서의 식을 그대로 읽어 계산한다.
 *
 * 이 파일도 앱에 딸리지 않는다(import 는 spec·formulas 뿐) — 다른 앱은 lib/methoddoc 만 가져다
 * `computeSpec(spec, contract)` 를 부르면 산출방법서에 실린 식대로 보험료를 낸다.
 *
 * 핵심: **산출방법서에 싣는 평문 수식 표기가 곧 기계가 읽는 문법이다.**
 *   l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )
 *   N_{x+t}   = Σ_{u≥t} D_{x+u}
 *   P         = PVB / N*
 * 그래서 사용자가 조건 화면에서든 산출방법서(Word·한글)에서든 식을 고치면 계산이 따라 바뀐다.
 * 식을 이 문법으로 읽을 수 없으면 계산하지 않고 그 식만 알려 준다(표시는 그대로) — 자동 식은 늘 이 문법이다.
 *
 * 문법
 *   정의     이름(아래첨자)? = 식            여러 개를 한 줄에: l_x = l′_x = 100,000
 *   아래첨자 x → t=0 · x+t → t · x+t+1 → t+1 · x+m → t=m · t · u · 0 · min(n,20) …
 *              (x+ 를 떼고 남은 것을 t·u·n·m 과 정수의 식으로 읽는다)
 *   식       + − × · / ( ) [ ] ^ · 비교(= ≤ ≥ < >) · if(조건, 참, 거짓) · min · max · round · round₅
 *   합       Σ_{u≥t} 식      (u = t … n)
 *            Σ_{t=0}^{n−1} 식
 *   기호     v 현가율 · i 적용이율 · n 보험기간 · m 납입기간 · k 납입주기 · x 가입나이 · ρ 저해지 비율
 *            α_S α_P β_S β_G β′ γ 사업비 · 위험률 기호(q · r · f · w …)는 담보별 식의 첫 줄에서 정한다
 */
import { benefitModels, isMethodExpenses, waitLabel, withFormulas, type BenefitModel } from "./formulas";
import { benefitAmount, coverYears, rateTable, unitOf, WHOLE_LIFE_AGE, type FormulaSpec, type MethodSpec, type RateRef, type Sex } from "./spec";

// ── 식 읽기 ──────────────────────────────────────────────────────────────────
export type Node =
  | { t: "num"; v: number }
  | { t: "ref"; name: string; idx?: Node }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "neg"; a: Node }
  | { t: "call"; f: string; args: Node[] }
  | { t: "sum"; v: string; from: Node; to: Node; body: Node };

/** 식 하나: 왼쪽 이름(들) = 오른쪽 */
export interface Equation { targets: { name: string; idx?: Node }[]; expr: Node; line: string }

const NUM = /[0-9]/;
/** 이름에 쓰는 글자 — 라틴·그리스·한글·프라임·별표(N*)·아래첨자 숫자(round₅) */
const NAME = /[A-Za-zΑ-Ωα-ω가-힣′*₀-₉]/;
const norm = (s: string) => s.replace(/'/g, "′").replace(/[-‐‑–—]/g, "−").replace(/\s+/g, " ");

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  get eof() { return this.i >= this.s.length; }
  ws() { while (!this.eof && this.s[this.i] === " ") this.i++; }
  peek() { this.ws(); return this.s[this.i]; }
  eat(t: string) { this.ws(); if (this.s.startsWith(t, this.i)) { this.i += t.length; return true; } return false; }
  need(t: string) { if (!this.eat(t)) throw new Error(`"${t}" 가 있어야 합니다 — ${this.s.slice(this.i, this.i + 12)}`); }

  /** 중괄호 안 글자 (짝을 맞춘다) */
  braced(): string {
    this.need("{");
    let d = 1, out = "";
    while (!this.eof && d > 0) {
      const c = this.s[this.i++];
      if (c === "{") d++;
      else if (c === "}") { if (--d === 0) break; }
      out += c;
    }
    if (d > 0) throw new Error("중괄호가 닫히지 않았습니다");
    return out;
  }
  /** 아래·위첨자 한 덩이 — `_{…}` 또는 `_x` 처럼 한 글자 */
  script(): string {
    if (this.s[this.i] === "{") return this.braced();
    let out = "";
    while (!this.eof && (NAME.test(this.s[this.i]) || NUM.test(this.s[this.i]))) out += this.s[this.i++];
    if (!out) throw new Error("첨자가 비었습니다");
    return out;
  }

  expr(): Node { return this.compare(); }
  /** 비교는 사슬로 이을 수 있다 — 40 ≤ x+t ≤ 59 는 두 비교를 곱한 것(둘 다 참일 때 1) */
  private compare(): Node {
    const parts = [this.add()], ops: string[] = [];
    for (;;) {
      const op = ["≤", "≥", "<", ">", "="].find((o) => { this.ws(); return this.s.startsWith(o, this.i); });
      if (!op) break;
      this.i += op.length;
      ops.push(op);
      parts.push(this.add());
    }
    if (!ops.length) return parts[0];
    return ops.map((op, i): Node => ({ t: "bin", op, a: parts[i], b: parts[i + 1] }))
      .reduce((a, b) => ({ t: "bin", op: "×", a, b }));
  }
  private add(): Node {
    let a = this.mul();
    for (;;) {
      if (this.eat("+")) a = { t: "bin", op: "+", a, b: this.mul() };
      else if (this.eat("−")) a = { t: "bin", op: "−", a, b: this.mul() };
      else return a;
    }
  }
  private mul(): Node {
    let a = this.pow();
    for (;;) {
      if (this.eat("×") || this.eat("·")) a = { t: "bin", op: "×", a, b: this.pow() };
      else if (this.eat("/") || this.eat("÷")) a = { t: "bin", op: "/", a, b: this.pow() };
      else return a;
    }
  }
  private pow(): Node {
    const a = this.unary();
    this.ws();
    if (this.s[this.i] === "^") { this.i++; return { t: "bin", op: "^", a, b: new Reader(this.script()).whole() }; }
    return a;
  }
  private unary(): Node {
    if (this.eat("−")) return { t: "neg", a: this.unary() };
    if (this.eat("+")) return this.unary();
    return this.primary();
  }
  private primary(): Node {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) throw new Error("식이 끊겼습니다");
    if (c === "(" || c === "[") {
      this.i++;
      const e = this.expr();
      this.need(c === "(" ? ")" : "]");
      return e;
    }
    if (c === "Σ") { this.i++; return this.sigma(); }
    if (c === "½") { this.i++; return { t: "num", v: 0.5 }; }
    if (NUM.test(c)) {
      let out = "";
      while (!this.eof && (NUM.test(this.s[this.i]) || this.s[this.i] === "." || (this.s[this.i] === "," && NUM.test(this.s[this.i + 1] ?? "")))) out += this.s[this.i++];
      return { t: "num", v: Number(out.replace(/,/g, "")) };
    }
    if (!NAME.test(c)) throw new Error(`읽을 수 없는 글자 "${c}"`);
    let name = "";
    while (!this.eof && (NAME.test(this.s[this.i]) || (name && NUM.test(this.s[this.i])))) name += this.s[this.i++];
    // 이름에 붙는 위첨자 — q^{(1)} · α^공제 · V^{10만} 처럼 괄호·한글이 들어 있으면 거듭제곱이 아니라 이름의 일부다
    for (;;) {
      const m = this.s[this.i] === "^" ? /^\^(?:\{([^}]*)\}|([가-힣]+))/.exec(this.s.slice(this.i)) : null;
      const inner = m ? (m[1] ?? m[2]) : undefined;
      if (inner === undefined || !/[(가-힣]/.test(inner)) break;
      this.i += m![0].length; name += `^{${inner}}`;
    }
    // 아래첨자가 자리(x · t · u · 수)면 계열의 자리, 그 밖(α_S · P_base · P_β)이면 이름의 일부다
    while (this.s[this.i] === "_") {
      this.i++;
      const sub = this.script();
      if (isIndex(sub)) {
        // 자리 뒤에 붙은 이름 위첨자 — Word·한글은 r^{(1)}_{x+t} 를 r_{x+t}^{(1)} 순서로 돌려준다. 거듭제곱이 아니라 이름이다
        const m = this.s[this.i] === "^" ? /^\^\{([^{}]*)\}/.exec(this.s.slice(this.i)) : null;
        if (m && /[(가-힣]/.test(m[1])) { this.i += m[0].length; name += `^{${m[1]}}`; }
        return { t: "ref", name, idx: indexNode(sub) };
      }
      name += `_${sub}`;
    }
    if (this.peek() === "(" && (FUNCS.has(name) || ROUND_N.test(name))) {
      this.need("(");
      const args = [this.expr()];
      while (this.eat(",")) args.push(this.expr());
      this.need(")");
      return { t: "call", f: name, args };
    }
    return { t: "ref", name };
  }
  /** Σ_{u≥t} … · Σ_{t=0}^{n−1} … */
  private sigma(): Node {
    if (this.s[this.i] !== "_") throw new Error("Σ 다음에는 _{…} 가 있어야 합니다");
    this.i++;
    const spec = this.script();
    let to: Node = { t: "ref", name: "n" };
    if (this.s[this.i] === "^") { this.i++; to = new Reader(this.script()).whole(); }
    const m = /^([A-Za-z])\s*(≥|=|>)\s*(.+)$/.exec(norm(spec));
    if (!m) throw new Error(`Σ 의 범위를 읽을 수 없습니다 — ${spec}`);
    const from = new Reader(m[3]).whole();
    return { t: "sum", v: m[1], from: m[2] === ">" ? { t: "bin", op: "+", a: from, b: { t: "num", v: 1 } } : from, to, body: this.mul() };
  }
  /** 글자 전체가 하나의 식이어야 한다 */
  whole(): Node {
    const e = this.expr();
    this.ws();
    if (!this.eof) throw new Error(`식 뒤에 남은 글자 "${this.s.slice(this.i)}"`);
    return e;
  }
}
const FUNCS = new Set(["if", "min", "max", "round"]);
/** round₀ … round₉ — 아래첨자 자리수로 반올림 (round₅ · round₆) */
const ROUND_N = /^round[₀-₉]$/;
export const roundDigits = (f: string) => (ROUND_N.test(f) ? f.charCodeAt(5) - 0x2080 : 0);

/** 자리로 읽을 아래첨자인지 — x · t · u · 수로 시작하는 것만. α_S · P_base · W^표준 은 이름이다 */
const isIndex = (sub: string) => /^([xtu]([+−].*)?|[0-9]+)$/.test(norm(sub).trim());

/** 아래첨자 → 자리(index) 식. "x" → 0 · "x+t+1" → t+1 · "min(n,20)" → 그대로 */
function indexNode(sub: string): Node {
  const s = norm(sub).trim();
  const body = s === "x" ? "0" : s.startsWith("x+") ? s.slice(2) : s;
  return new Reader(body).whole();
}

/** "l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )" → 식 하나. 읽을 수 없으면 오류를 던진다 */
export function parseEquation(line: string): Equation {
  const s = norm(line).trim();
  // 맨 위 괄호 밖의 "=" 로만 자른다 — if(t = 0, …) 안의 것은 비교다
  const cut: number[] = [];
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) d--;
    else if (c === "=" && d === 0) cut.push(i);
  }
  if (!cut.length) throw new Error("= 가 없어 정의가 아닙니다");
  const parts = [0, ...cut.map((i) => i + 1)].map((a, k) => s.slice(a, cut[k] ?? s.length).replace(/=$/, "").trim());
  const rhs = parts.pop()!;
  const targets = parts.map((p) => {
    const r = new Reader(p);
    const node = r.whole();
    if (node.t !== "ref") throw new Error(`"${p}" 는 이름이 아닙니다`);
    return { name: node.name, idx: node.idx };
  });
  return { targets, expr: new Reader(rhs).whole(), line: s };
}

/** 식 줄 여러 개 → 정의 목록. 설명 줄(= 가 없는 줄)은 건너뛴다 */
export function parseLines(text: string): { eqs: Equation[]; skipped: string[] } {
  const eqs: Equation[] = [], skipped: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { eqs.push(parseEquation(line)); }
    catch { skipped.push(line); }
  }
  return { eqs, skipped };
}

// ── 계산 ────────────────────────────────────────────────────────────────────
interface Defs { direct?: Equation; recur?: { eq: Equation; off: number }; points: Map<number, Equation>; scalar?: Equation }

export interface Model {
  /** 이름 → 정의 */
  defs: Map<string, Defs>;
  /** 미리 주는 계열 — 위험률(자리 t 로 이미 옮겨 놓은 값) */
  known: Record<string, number[]>;
  /** 기호 값 — v · n · m · k · x · 사업비 */
  scalar: Record<string, number>;
  n: number;
  /** 이미 센 값 (`이름@자리`) — 모델 하나가 한 번만 센다. 모델은 만든 뒤 바뀌지 않으므로 계속 써도 된다 */
  cache?: Map<string, number>;
}

/** 식 목록 → 이름별 정의. 자리 식에 t 가 들어 있으면 그 오프셋으로 점화식·직접 정의를 가른다 */
export function buildDefs(eqs: Equation[]): Map<string, Defs> {
  const out = new Map<string, Defs>();
  for (const eq of eqs) for (const tg of eq.targets) {
    const d = out.get(tg.name) ?? { points: new Map<number, Equation>() };
    out.set(tg.name, d);
    if (!tg.idx) { d.scalar = eq; continue; }
    const at = (t: number) => plain(tg.idx!, { t, u: t });
    const a = at(0), b = at(1);
    if (a === undefined || b === undefined) continue;
    if (a === b) d.points.set(a, eq);                       // t 가 없는 자리 — 한 점 정의(S_0 = …)
    else if (b - a === 1) { if (a === 0) d.direct = eq; else d.recur = { eq, off: a }; }
    else throw new Error(`자리 "${eq.line}" 를 읽을 수 없습니다`);
  }
  return out;
}

/** t·u·n·m 만 들어 있는 간단한 자리 식을 미리 계산 (계열을 참조하면 undefined) */
function plain(node: Node, vars: Record<string, number>): number | undefined {
  try {
    return evalNode(node, { defs: new Map(), known: {}, scalar: { n: 1e9, m: 1e9 }, n: 1e9 }, vars, new Map(), new Set(), true);
  } catch { return undefined; }
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;

function evalNode(node: Node, mo: Model, vars: Record<string, number>, cache: Map<string, number>, busy: Set<string>, bare = false): number {
  const ev = (x: Node, v = vars) => evalNode(x, mo, v, cache, busy, bare);
  switch (node.t) {
    case "num": return node.v;
    case "neg": return -ev(node.a);
    case "bin": {
      const a = ev(node.a), b = ev(node.b);
      switch (node.op) {
        case "+": return a + b;
        case "−": return a - b;
        case "×": return a * b;
        case "/": return b === 0 ? 0 : a / b;
        case "^": return a ** b;
        case "=": return near(a, b) ? 1 : 0;
        case "≤": return a <= b + 1e-12 ? 1 : 0;
        case "≥": return a + 1e-12 >= b ? 1 : 0;
        case "<": return a < b ? 1 : 0;
        default: return a > b ? 1 : 0;
      }
    }
    case "call": {
      const a = node.args;
      if (node.f === "if") return ev(a[0]) ? ev(a[1]) : ev(a[2] ?? { t: "num", v: 0 });
      const xs = a.map((x) => ev(x));
      if (node.f === "min") return Math.min(...xs);
      if (node.f === "max") return Math.max(...xs);
      const p = 10 ** roundDigits(node.f);
      return Math.round(xs[0] * p) / p;
    }
    case "sum": {
      const from = Math.round(ev(node.from)), to = Math.round(ev(node.to));
      let s = 0;
      for (let u = from; u <= to; u++) s += ev(node.body, { ...vars, [node.v]: u });
      return s;
    }
    case "ref": {
      if (node.idx === undefined) {
        if (vars[node.name] !== undefined) return vars[node.name];
        if (mo.scalar[node.name] !== undefined) return mo.scalar[node.name];
        if (bare) throw new Error(`기호 ${node.name}`);
        return series(node.name, 0, mo, cache, busy);
      }
      const i = Math.round(ev(node.idx));
      if (bare) throw new Error(`계열 ${node.name}`);
      return series(node.name, i, mo, cache, busy);
    }
  }
}

/** 계열 한 값 — 점화식이면 앞자리를 먼저 구한다(기억해 둔다) */
function series(name: string, i: number, mo: Model, cache: Map<string, number>, busy: Set<string>): number {
  const known = mo.known[name];
  if (known) return known[i] ?? 0;
  const key = `${name}@${i}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const d = mo.defs.get(name);
  if (!d) throw new Error(`알 수 없는 기호 ${name}`);
  if (busy.has(key)) throw new Error(`${name} 의 정의가 스스로를 돌아 참조합니다`);
  busy.add(key);
  try {
    const point = d.points.get(i);
    const eq = point ?? (d.recur && i >= d.recur.off ? d.recur.eq : d.direct ?? d.scalar);
    if (!eq) return 0;
    const t = point || eq === d.direct || eq === d.scalar ? i : i - d.recur!.off;
    const v = evalNode(eq.expr, mo, { t, u: t }, cache, busy);
    cache.set(key, v);
    return v;
  } finally { busy.delete(key); }
}

/** 자리 식(t · u · n · m 과 수)의 값 — 엑셀 수식으로 옮길 때 줄 번호를 구한다 */
export const evalIndex = (node: Node, vars: Record<string, number>): number =>
  evalNode(node, { defs: new Map(), known: {}, scalar: vars, n: vars.n ?? 0 }, vars, new Map(), new Set(), true);

/**
 * 이름 하나의 값 — 자리를 주면 계열, 안 주면 스칼라.
 * 캐시는 **모델에 둔다** — 되돌이 정의(`l_{x+t+1} = l_{x+t} × …`)라서 칸마다 새로 세면 한 열이 O(n²) 이 된다
 * (계산 표는 담보마다 72줄 × 열 19개라 0.7초씩 멈췄다). `busy`(제 자리 되참조 막기)는 부를 때마다 새로 둔다.
 */
export function valueOf(mo: Model, name: string, i?: number): number {
  const cache = (mo.cache ??= new Map<string, number>());
  return i === undefined && mo.scalar[name] !== undefined ? mo.scalar[name] : series(name, i ?? 0, mo, cache, new Set());
}


// ── 조건 → 계산 ─────────────────────────────────────────────────────────────
/** 계산할 계약 한 점 — 산출방법서의 정보가 아니라 계산하는 앱의 입력이다(spec.contract 와 같은 뜻). sumAssured 는 보험가입금액(원) */
export interface CalcContract { age: number; sex?: Sex; payYears: number; freq: number; termYears?: number; sumAssured?: number }
export const CALC_DEFAULT: CalcContract = { age: 40, sex: "M", payYears: 20, freq: 12, sumAssured: 1e8 };
export const SUM_ASSURED_DEFAULT = 1e8;
/** 납입방법 — k(연 납입횟수)와 이름 */
export const PAY_METHODS: [number, string][] = [[12, "월납"], [4, "3개월납"], [2, "6개월납"], [1, "연납"]];

export interface BenefitResult {
  id: string; name: string;
  /** 계약 단위(주계약·특약 이름) · 이 담보의 유지자 집단 · 보험료(N*)에 쓰는 납입자 */
  unit: string; group: string; payer: string;
  /** 이 담보의 보장기간(년) · 납입기간(년) */
  n: number; m: number;
  /** 보장금액(원) = 가입금액 × 배수 */
  amount: number;
  pvb: number; nStar: number; net: number; base: number; gross: number;
  /** 1원당 영업보험료(소수 여섯 자리) · 10만원당 영업보험료(원, 반올림) · 이 담보의 보험료(원) */
  gross6: number; per100k: number; premium: number;
  /** 못 읽은 줄(설명 줄은 빼고) */
  skipped: string[];
  error?: string;
}
export interface CalcResult {
  contract: CalcContract;
  benefits: BenefitResult[];
  /** 담보 보험료의 합(원) */
  premium: number;
  /** 값 표가 없어 0 으로 둔 위험률 */
  missingRates: string[];
  errors: string[];
}

/** 위험률 → 자리(t) 별 값. 값 표가 없으면 0 */
function rateSeries(r: RateRef, c: CalcContract, len: number): { values: number[]; ok: boolean } {
  const t = rateTable(r, c.sex);
  if (!t?.ages.length) return { values: new Array(len).fill(0), ok: false };
  const by = new Map(t.ages.map((a, i) => [a, t.values[i]]));
  return { values: Array.from({ length: len }, (_, i) => by.get(c.age + i) ?? 0), ok: true };
}

const expenseOf = (spec: MethodSpec, symbol: string) => {
  const e = spec.expenses.find((x) => x.symbol === symbol || (symbol === "β′" && x.symbol === "β'"));
  return e?.rate ?? e?.times ?? 0;
};

/** 이 담보의 계산에 쓰는 식 — 그 담보의 유지자수 · 그 계약 단위의 납입자수(하나), 그 담보의 보험금, 담보마다 같은 현가·보험료·준비금·환급금 */
const KEYS_OF = (m: BenefitModel) => (f: FormulaSpec) =>
  !!f.key && ([`group:${m.group.id}`, `pay:${m.payer.id}`, `benefit:${m.b.id}`].includes(f.key) || /^(pv|premium|reserve|surrender):/.test(f.key));

/**
 * 담보 하나를 계산할 준비 — 기간·위험률 계열·기호 값·식 목록. computeSpec 과 계산 표(calcSheets)가 같은 것을 쓴다.
 * 모델까지 만든다: 해약공제 기준 신계약비의 표준기초율 값(α^표준)은 같은 식을 표준이율로 한 번 더 계산해 기호 값으로 준다.
 */
function prepare(spec: MethodSpec, m: BenefitModel, contract: CalcContract, formulas: FormulaSpec[]) {
  const b = m.b;
  const n = Math.max(1, Math.min(contract.termYears ?? 999, coverYears(b.endAge, contract.age)));
  const pay = Math.min(contract.payYears, n);
  const sumAssured = contract.sumAssured ?? SUM_ASSURED_DEFAULT;
  const amount = benefitAmount(b, sumAssured);
  const known: Record<string, number[]> = {};
  const label: Record<string, string> = { ...SYM_LABEL };
  const missing: string[] = [];
  for (const { sym, rate } of [...m.group.syms, ...m.payer.syms, ...(m.event ? [m.event] : [])]) {
    label[sym] = rate.name;
    if (known[sym]) continue;
    const { values, ok } = rateSeries(rate, contract, n + 1);
    known[sym] = values;
    if (!ok) missing.push(rate.name);
  }
  if (m.group.lapseRate !== undefined) known.w = Array.from({ length: n + 1 }, (_, t) => (t < pay ? m.group.lapseRate! : 0));
  const low = m.group.lapseRate !== undefined && spec.basis.lowRatio !== undefined;
  // 저해지형의 해지급부 현가 CSV 는 표준형 환급금과 맞물려 되풀이 계산이라 이 앱은 0 으로 둔다(표준형 보험료·준비금) — 그 값은 자유설계보험이 낸다
  if (low) known.CSV = new Array(n + 1).fill(0);
  const meth = isMethodExpenses(spec);
  const i = spec.basis.interest ?? 0;
  const scalar: Record<string, number> = {
    n, m: pay, k: contract.freq, x: contract.age, i, v: 1 / (1 + i), ρ: spec.basis.lowRatio ?? 0,
    ...(meth ? {
      "α_S": expenseOf(spec, "α_S"), "α_P": (expenseOf(spec, "α_P") * Math.min(n, 20)) / 20,
      "β_S": expenseOf(spec, "β_S"), "β_G": expenseOf(spec, "β_G"), "β′": expenseOf(spec, "β′"), γ: expenseOf(spec, "γ"),
    } : { α: expenseOf(spec, "α"), β: expenseOf(spec, "β"), γ: expenseOf(spec, "γ"), "β′": 0 }),
  };
  const text = formulas.filter(KEYS_OF(m)).map((f) => f.text).join("\n");
  return { n, pay, amount, sumAssured, known, scalar, label, missing, text, meth, low };
}

/**
 * 식 읽기는 글자가 같으면 결과도 같다 — 조건이 그대로인데 계약(나이·주기·가입금액)만 바뀔 때마다 다시 읽지 않는다.
 * 시산 줄이 납입방법 넷을 한꺼번에 세우므로(computeByPayMethod) 이것이 없으면 한 글자 고칠 때마다 식을 여덟 번 읽었다.
 */
const PARSED = new Map<string, ReturnType<typeof parseLines>>();
function parseCached(text: string) {
  const hit = PARSED.get(text);
  if (hit) return hit;
  if (PARSED.size > 64) PARSED.clear();
  const r = parseLines(text);
  PARSED.set(text, r);
  return r;
}

/** 식 목록 → 모델. 표준이율이 있으면 같은 식을 표준이율로 한 번 더 세워 α^표준(해약공제 기준)을 기호 값으로 둔다 */
function buildModel(spec: MethodSpec, eqs: Equation[], known: Record<string, number[]>, scalar: Record<string, number>, n: number, meth: boolean, withStd = true): Model {
  const defs = buildDefs(eqs);
  const mo: Model = { defs, known, scalar, n };
  // 표준기초율 신계약비는 해약공제(3장)에만 쓴다 — 보험료만 낼 때(computeSpec)는 세우지 않는다
  if (meth && withStd) {
    const si = spec.basis.standardInterest;
    let alphaStd = Infinity;
    // 표준이율 모델 하나 — α^{표준} 과 V^{표준} 이 같은 캐시를 쓴다
    const std: Model = si === undefined ? mo : { defs, known, scalar: { ...scalar, i: si, v: 1 / (1 + si) }, n };
    try {
      const base = Math.round(valueOf(std, "P_base") * 1e5) / 1e5;
      alphaStd = scalar["α_S"] + scalar["α_P"] * base;
    } catch { /* P_base 를 못 세우면 표준기초율 한정을 두지 않는다 */ }
    scalar["α^{표준}"] = alphaStd;
    // 표준기초율 책임준비금 V^{표준} — 같은 식(V)을 표준이율로 계산한 값. 회계연도말 적립금 V^{결산} = max(V, V^{표준}) 이 쓴다
    if (si !== undefined && defs.has("V")) {
      try { known["V^{표준}"] = Array.from({ length: n + 1 }, (_, t) => valueOf(std, "V", t)); } catch { /* V 를 못 세우면 결산 적립금 열만 빠진다 */ }
    }
  }
  return mo;
}

/** 1원당 보험료를 여섯째 자리까지 → 10만원당(반올림) → 담보 보험료. 식(G₁ · G_{10만})이 있으면 그 값을, 없으면 같은 규칙으로 */
function premiumOf(mo: Model, amount: number) {
  const gross = valueOf(mo, "G");
  const gross6 = mo.defs.has("G₁") ? valueOf(mo, "G₁") : Math.round(gross * 1e6) / 1e6;
  const per100k = mo.defs.has("G_10만") ? valueOf(mo, "G_10만") : Math.round(gross6 * 1e5);
  return { gross, gross6, per100k, premium: per100k * (amount / 1e5) };
}

/**
 * 산출방법서의 식으로 담보마다 보험료를 낸다 — 조건(위험률·금액·기간)과 식을 함께 쓴다.
 * 쓰는 식은 withFormulas 를 거친 것이라 **사용자가 고친 식이 그대로 계산에 반영된다.**
 * 담보 하나를 독립된 소형 상품으로 본다(자유설계보험 computePlan 과 같은 규칙):
 * 보장기간 n = min(계약 보험기간, 만기 나이 − 가입나이) — 100세 만기면 99세까지(종신은 표 끝 나이의 해까지, coverYears), 납입기간 m = min(납입기간, n).
 * 보장금액 = 가입금액 × 배수는 맨 뒤(담보 보험료)에서만 곱한다 — 그 앞은 모두 1원당이다.
 */
export function computeSpec(spec: MethodSpec, contract: CalcContract = CALC_DEFAULT): CalcResult {
  const formulas = withFormulas(spec).formulas;
  const out: CalcResult = { contract, benefits: [], premium: 0, missingRates: [], errors: [] };
  for (const m of benefitModels(spec)) {
    const b = m.b;
    const { n, pay, amount, known, scalar, missing, text, meth } = prepare(spec, m, contract, formulas);
    for (const name of missing) if (!out.missingRates.includes(name)) out.missingRates.push(name);
    const { eqs, skipped } = parseCached(text);
    const res: BenefitResult = {
      id: b.id, name: b.name, unit: unitOf(b), group: m.group.label, payer: m.payer.label, n, m: pay, amount,
      pvb: 0, nStar: 0, net: 0, base: 0, gross: 0, gross6: 0, per100k: 0, premium: 0, skipped,
    };
    try {
      const mo = buildModel(spec, eqs, known, scalar, n, meth, false);
      res.pvb = valueOf(mo, "PVB");
      res.nStar = valueOf(mo, "N*");
      res.net = valueOf(mo, "P");
      res.base = valueOf(mo, "P_base");
      Object.assign(res, premiumOf(mo, amount));
      out.premium += res.premium;
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      out.errors.push(`${b.name}: ${res.error}`);
    }
    out.benefits.push(res);
  }
  return out;
}

/** 납입방법(월납·3개월납·6개월납·연납)마다 보험료 — 시산보험료 조건 줄이 보인다. 보험금의 현가는 같고 N* 만 다르다 */
export function computeByPayMethod(spec: MethodSpec, contract: CalcContract): { freq: number; label: string; per100k: number; premium: number; errors: string[] }[] {
  return PAY_METHODS.map(([freq, label]) => {
    const r = computeSpec(spec, { ...contract, freq });
    return { freq, label, per100k: r.benefits.reduce((s, b) => s + b.per100k, 0), premium: r.premium, errors: r.errors };
  });
}

/** 식 한 덩이가 이 문법으로 읽히는지 — 조건 화면이 "계산에 쓸 수 있는 식" 인지 알린다 */
export function checkFormula(f: FormulaSpec): { ok: boolean; skipped: string[] } {
  const { eqs, skipped } = parseLines(f.text);
  return { ok: eqs.length > 0, skipped };
}

// ── 계산 표 — 엑셀처럼 한 해 한 줄 ──────────────────────────────────────────
/** 기호의 뜻. 위험률 기호(q · r · f · g)는 조건의 위험률 이름으로 덮어쓴다 */
const SYM_LABEL: Record<string, string> = {
  R: "질병 발생률 (질병끼리 곱 결합)", Q: "탈퇴율", F: "납입면제까지 묶은 질병 발생률 (곱 결합)", "Q′": "납입 탈퇴율", w: "적용해지율", l: "유지자수", "l′": "납입자수", d: "지급자수 (급부 발생자)",
  D: "유지자수의 현가", "D′": "납입자수의 현가", H: "해지자의 현가",
  N: "유지자수 현가의 누계", "N′": "납입자수 현가의 누계",
  S: "보장금액의 배수", E: "생존 지급 배수", C: "급부 발생자의 현가", M: "보험금 현가의 누계", CSV: "해지급부의 현가 (이 앱은 0)",
  "N*": "연납 환산 납입기수", PVB: "보험금의 현가", "PVB′": "해지급부를 더한 보험금의 현가", P: "순보험료 (1원당)", P_base: "기준연납순보험료",
  G: "영업보험료 (1원당)", "G₁": "1원당 영업보험료 (소수 6자리)", "G_10만": "10만원당 보험료 (원)",
  "P_β": "준비금 산출용 순보험료", V: "연말 책임준비금 (1원당)", "V^{10만}": "10만원당 책임준비금 (원)",
  "α^{공제}": "해약공제 기준 신계약비", 해약공제: "해약공제", "W^{표준}": "표준형 해지환급금 (1원당)", W: "해지환급금 (1원당)",
  납입누계: "납입보험료 누계 (1원당)", 환급률: "환급률",
  v: "현가율", i: "적용이율", n: "보장기간(년)", m: "납입기간(년)", k: "납입주기별 계수", x: "가입나이",
};
/** 왼쪽부터 이 순서로 — 위험률 → 사람 수 → 사람 수의 현가·누계 → 보험금 → 준비금 → 환급금 */
const COL_ORDER = ["R", "Q", "l", "F", "Q′", "l′", "d", "D", "D′", "H", "N", "N′", "S", "E", "C", "M", "V", "V^{10만}", "V^{결산}", "해약공제", "W^{표준}", "W", "납입누계", "환급률"];
const DIGITS: Record<string, number> = { R: 8, F: 8, "Q′": 8, l: 2, "l′": 2, d: 4, D: 4, "D′": 4, H: 4, N: 2, "N′": 2, C: 6, M: 4, S: 4, E: 4, Q: 8, w: 6,
  V: 8, "V^{10만}": 0, 해약공제: 8, "W^{표준}": 8, W: 8, 납입누계: 8, 환급률: 4 };
/** 표 아래 한 값으로 나오는 것 — 이 순서로 */
const SCALARS = ["N*", "PVB", "PVB′", "P", "P_base", "G", "G₁", "G_10만", "P_β", "α^{공제}"];

export interface CalcColumn {
  sym: string;
  label: string;
  /** 이 열을 만든 식 (위험률 열은 표에서 온 값이라는 안내) */
  formula: string;
  /** rate 표에서 온 값 · discount 이율에서 나온 현가율 · series 식으로 만든 계열 */
  kind: "rate" | "discount" | "series";
  digits: number;
  values: number[];
  /** 그 자리의 값이 어떤 값들로 나왔는지 (칸을 눌렀을 때) — 식에 나오는 기호와 그 값.
   *  미리 만들지 않는다 — 72줄 × 열 19개를 다 만들면 표 한 장이 그만큼 느려진다 */
  parts: (t: number) => { ref: string; value: number }[];
  /** 읽어 둔 식 — 엑셀·파이썬으로 옮길 때 쓴다(위험률·현가율 열은 없다) */
  eq?: Equation;
  /** 점화식이면 앞자리를 몇 칸 쓰는지 (l_{x+t+1} = … → 1). 그 앞줄은 init */
  offset: number;
  init?: number;
}
/** 보일 것이 없는 열(위험률·현가율) */
const NO_PARTS = () => [];

export interface CalcScalarRow { sym: string; label: string; formula: string; value: number; digits: number; eq?: Equation }
/** 계산에 앞서 정한 값 — 계약 한 점과 기초율. 이것과 위험률만 있으면 나머지는 식으로 나온다 */
export interface CalcInput {
  label: string;
  /** 엑셀에서 쓸 이름 (없으면 값만) */
  name?: string;
  value: number | string;
  /** 소수 자리 (글자면 없음) */
  digits?: number;
  note?: string;
  /** 다른 입력에서 나오는 값(현가율) — 엑셀에서도 수식으로 */
  formula?: string;
  /** 담보마다 다른 값(보장기간·배수·면책) — 계약 단위 한 장에 여러 담보가 들어갈 때 담보 칸에 둔다 */
  perBenefit?: boolean;
}
export interface CalcSheet {
  id: string; name: string; unit: string; group: string;
  n: number; m: number;
  /** 줄마다 경과기간 t 와 그때의 나이 */
  ages: number[];
  /** 왼쪽에 늘어놓는 계약·기초율 — 내려받은 파일만으로 다시 세울 수 있게 */
  inputs: CalcInput[];
  cols: CalcColumn[];
  /** 표 아래 — 한 값으로 나오는 것(N* · PVB · P · G · P_β …) */
  scalars: CalcScalarRow[];
  /** 보장금액(원) = 가입금액 × 배수 */
  amount: number;
  multiple?: number;
  per100k: number;
  premium: number;
  /** 식으로 세우지 못한 열·값 (그 열만 빠진다) */
  warnings: string[];
  error?: string;
}
export interface CalcSheets {
  contract: CalcContract;
  sheets: CalcSheet[];
  /** 담보 보험료의 합(원) · 10만원당 합 */
  premium: number;
  per100k: number;
  missingRates: string[];
}

/** 식에 나오는 계열·기호를 자리순으로 (팝업에서 "이 값들로 나왔다" 를 보이려고) */
function refsOf(node: Node, out: { name: string; idx?: Node }[] = []): { name: string; idx?: Node }[] {
  switch (node.t) {
    case "ref": if (node.idx) refsOf(node.idx, out); out.push({ name: node.name, idx: node.idx }); break;
    case "bin": refsOf(node.a, out); refsOf(node.b, out); break;
    case "neg": refsOf(node.a, out); break;
    case "call": node.args.forEach((a) => refsOf(a, out)); break;
    case "sum": refsOf(node.from, out); refsOf(node.to, out); refsOf(node.body, out); break;
  }
  return out;
}

/**
 * 산출방법서의 식을 한 해 한 줄의 표로 — 엑셀에서 세로로 늘어놓고 보던 그 모양.
 * 열마다 그 열을 만든 식을 달고, 줄마다 그 값이 어떤 값들로 나왔는지도 담는다(화면이 팝업으로 보인다).
 * 열 하나를 세우지 못해도(예: 고친 식이 모르는 기호를 가리킴) 그 열만 빼고 나머지는 낸다.
 */
export function calcSheets(spec: MethodSpec, contract: CalcContract = CALC_DEFAULT): CalcSheets {
  const formulas = withFormulas(spec).formulas;
  const out: CalcSheets = { contract, sheets: [], premium: 0, per100k: 0, missingRates: [] };
  for (const bm of benefitModels(spec)) {
    const b = bm.b;
    const { n, pay, amount, sumAssured, known, scalar, label, missing, text, meth } = prepare(spec, bm, contract, formulas);
    for (const name of missing) if (!out.missingRates.includes(name)) out.missingRates.push(name);
    // 지급자수 d 는 문서의 C 식에서 v^{t+½} 를 뺀 부분이다 — 표에서만 따로 보여 준다
    const { eqs } = parseCached(`${text}\n${bm.payout}`);
    const sheet: CalcSheet = {
      id: b.id, name: b.name, unit: unitOf(b), group: bm.group.label, n, m: pay,
      ages: Array.from({ length: n + 1 }, (_, t) => contract.age + t),
      // 계산에 앞서 정한 값 — 이것과 위험률만 값이고 나머지는 모두 식에서 나온다
      inputs: [
        { label: "가입나이 x", name: "x_age", value: contract.age, digits: 0, note: "세" },
        { label: "성별", value: contract.sex === "F" ? "여" : "남" },
        { label: "보험가입금액", name: "sum_assured", value: sumAssured, digits: 0, note: "원" },
        { label: "보장기간 n", name: "n_term", value: n, digits: 0, note: (b.endAge ?? WHOLE_LIFE_AGE) >= WHOLE_LIFE_AGE ? `년 — 종신: ${b.endAge ?? WHOLE_LIFE_AGE}세 + 1 − 가입나이 (표 끝 나이의 해까지)` : `년 — ${b.endAge}세 만기 − 가입나이 (${b.endAge! - 1}세까지)`, perBenefit: true },
        { label: "납입기간 m", name: "m_pay", value: pay, digits: 0, note: "년 — min(납입기간, n)", perBenefit: true },
        { label: "납입주기 k", name: "k_freq", value: contract.freq, digits: 0, note: "연 납입횟수" },
        { label: "적용이율 i", name: "i_rate", value: scalar.i, digits: 6 },
        { label: "현가율 v", name: "v_disc", value: scalar.v, digits: 10, formula: "v = 1 / ( 1 + i )" },
        ...(spec.basis.standardInterest !== undefined ? [{ label: "표준이율", name: "i_std", value: spec.basis.standardInterest, digits: 6, note: "해약공제 기준 신계약비의 표준기초율 값에" }] : []),
        ...(b.multiple !== undefined ? [{ label: "보장금액 배수", name: "S_mult", value: b.multiple, digits: 2, note: "가입금액 대비", perBenefit: true }] : []),
        { label: "보장금액", name: "S_amt", value: amount, digits: 0, note: b.multiple !== undefined ? "원 = 가입금액 × 배수" : "원", perBenefit: true, ...(b.multiple !== undefined ? { formula: "S = 가입금액 × 배수" } : {}) },
        ...(b.waitDays ? [{ label: "면책·삭감", value: waitLabel(b), note: "보장금액의 배수 S 에 반영", perBenefit: true }] : []),
        ...(meth
          ? ([["α_S", "alphaS"], ["α_P", "alphaP"], ["β_S", "betaS"], ["β_G", "betaG"], ["β′", "betaPrime"], ["γ", "gamma"]] as const)
            .map(([sym, name]) => ({ label: sym === "α_P" ? "α_P (적용값)" : sym, name, value: scalar[sym] ?? 0, digits: 8,
              ...(sym === "α_P" ? { perBenefit: true, ...(n < 20 ? { note: `보장기간이 20년보다 짧아 × ${n}/20` } : {}) } : {}) }))
          : ([["α", "alpha"], ["β", "beta"], ["γ", "gamma"]] as const).map(([sym, name]) => ({ label: sym, name, value: scalar[sym] ?? 0, digits: 8 }))),
      ],
      cols: [], scalars: [], amount, multiple: b.multiple, per100k: 0, premium: 0, warnings: [],
    };
    try {
      const mo = buildModel(spec, eqs, known, scalar, n, meth);
      const at = (name: string, t: number) => valueOf(mo, name, t);
      const rateSyms = [...new Set([...bm.group.syms, ...bm.payer.syms, ...(bm.event ? [bm.event] : [])].map((x) => x.sym))];
      const sourceOf = (sym: string) => [...bm.group.syms, ...bm.payer.syms, ...(bm.event ? [bm.event] : [])].find((x) => x.sym === sym)?.rate;
      for (const sym of [...rateSyms, ...(known.w ? ["w"] : [])]) {
        const r = sourceOf(sym);
        sheet.cols.push({
          sym, label: label[sym] ?? sym, kind: "rate", digits: 8, values: known[sym] ?? [], parts: NO_PARTS, offset: 0,
          formula: sym === "w" ? "조건 1.3. 적용해지율 — 납입기간 중" : `위험률 표에서 온 값${r?.source ? ` — ${r.source}` : ""}`,
        });
      }
      // 현가율 — 위험률 바로 오른쪽. 값이 아니라 적용이율에서 나오는 식이다(D 는 v^t 를, C 는 v^{t+½} 를 쓴다)
      for (const [sym, why] of [["v^t", "그 해 초의 현가율 — 유지자수·납입자수의 현가 D·D′ 에 쓴다"],
        ["v^{t+½}", "그 해 가운데의 현가율 — 급부는 연도 중앙에 생긴다고 보아 C 에 쓴다"]] as const) {
        const half = sym.includes("½") ? 0.5 : 0;
        sheet.cols.push({
          sym, label: "현가율", kind: "discount", digits: 10, offset: 0, parts: NO_PARTS,
          formula: `${sym} = ( 1 / ( 1 + i ) )^{t${half ? "+½" : ""}} — ${why}`,
          values: Array.from({ length: n + 1 }, (_, t) => scalar.v ** (t + half)),
        });
      }
      const names = [...COL_ORDER.filter((x) => mo.defs.has(x)), ...[...mo.defs.keys()].filter((x) => !COL_ORDER.includes(x) && isSeries(mo, x))];
      for (const sym of names) {
        // 표준기초율 책임준비금 — 식이 아니라 같은 식(V)을 표준이율로 세운 값(buildModel). 결산 적립금 바로 앞에 둔다
        if (sym === "V^{결산}" && known["V^{표준}"]) sheet.cols.push({ sym: "V^{표준}", label: "표준기초율 책임준비금", kind: "series", digits: 8, values: known["V^{표준}"], parts: NO_PARTS, offset: 0,
          formula: "V^{표준}_t — 같은 식(V)을 표준이율로 계산한 값 (앱이 계산)" });
        const d = mo.defs.get(sym)!;
        const eq = d.direct ?? d.recur?.eq ?? [...d.points.values()][0];
        if (!eq) continue;
        const refs = refsOf(eq.expr).filter((r) => r.name !== "v" && (mo.known[r.name] || isSeries(mo, r.name)));
        const off = d.recur?.off ?? 0;
        let values: number[];
        try { values = Array.from({ length: n + 1 }, (_, t) => at(sym, t)); }
        catch (e) { sheet.warnings.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`); continue; }
        sheet.cols.push({
          sym, label: label[sym] ?? sym, kind: "series", digits: DIGITS[sym] ?? 4, formula: eq.line, eq, offset: off,
          ...(off && d.points.has(0) ? { init: at(sym, 0) } : {}),
          values,
          parts: (t: number) => {
            const base = t >= off ? t - off : t;
            return refs.map((r) => {
              const i = r.idx ? Math.round(evalNode(r.idx, mo, { t: base, u: base }, new Map(), new Set())) : base;
              return { ref: `${r.name}${r.idx ? `(${contract.age + i})` : ""}`, value: at(r.name, i) };
            });
          },
        });
      }
      for (const sym of [...SCALARS.filter((x) => mo.defs.has(x)), ...[...mo.defs.keys()].filter((x) => !SCALARS.includes(x) && !isSeries(mo, x) && !!mo.defs.get(x)?.scalar)]) {
        // 표준기초율 신계약비 — 식이 아니라 같은 식을 표준이율로 한 번 더 세워 얻은 값(buildModel). 해약공제 신계약비 바로 앞에 둔다(엑셀·파이썬이 이 값을 먼저 쓴다)
        if (sym === "α^{공제}" && Number.isFinite(scalar["α^{표준}"])) sheet.scalars.push({ sym: "α^{표준}", label: "표준기초율 신계약비 (표준이율로 P_base 를 다시 계산)", formula: "α^{표준} = α_S + α_P·round₅( P_base^{표준} ) — P_base^{표준} 은 표준이율 i_std 로 같은 식을 계산한 값", value: scalar["α^{표준}"], digits: 8 });
        const d = mo.defs.get(sym)!;
        const eq = d.scalar ?? d.direct;
        try {
          sheet.scalars.push({ sym, label: label[sym] ?? sym, formula: eq?.line ?? "", value: valueOf(mo, sym), digits: sym === "N*" ? 2 : sym === "G_10만" ? 0 : sym === "G₁" ? 6 : 8, eq });
        } catch (e) { sheet.warnings.push(`${sym}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const p = premiumOf(mo, amount);
      sheet.per100k = p.per100k;
      sheet.premium = p.premium;
      out.premium += sheet.premium;
      out.per100k += sheet.per100k;
    } catch (e) {
      sheet.error = e instanceof Error ? e.message : String(e);
    }
    out.sheets.push(sheet);
  }
  return out;
}

/** 자리를 가진 계열인지 (스칼라 정의만 있는 것은 표의 열이 아니다) */
const isSeries = (mo: Model, sym: string) => {
  const d = mo.defs.get(sym);
  return !!d && (!!d.direct || !!d.recur || d.points.size > 0);
};

/** 계산 표를 계약 단위(주계약·특약)로 묶는다 — 엑셀은 단위마다 한 장, 화면은 단위 탭 */
export function sheetsByUnit(calc: CalcSheets): { unit: string; sheets: CalcSheet[]; premium: number; per100k: number }[] {
  const units = [...new Set(calc.sheets.map((s) => s.unit))];
  return units.map((unit) => {
    const sheets = calc.sheets.filter((s) => s.unit === unit);
    return { unit, sheets, premium: sheets.reduce((a, s) => a + s.premium, 0), per100k: sheets.reduce((a, s) => a + s.per100k, 0) };
  });
}
