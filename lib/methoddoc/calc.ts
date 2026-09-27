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
import { benefitModels, waitMonths, withFormulas, type BenefitModel } from "./formulas";
import { rateTable, type FormulaSpec, type MethodSpec, type RateRef, type Sex } from "./spec";

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
    // 이름에 붙는 위첨자 — q^{(1)} · α^공제 처럼 괄호·한글이면 거듭제곱이 아니라 이름의 일부다
    while (this.s[this.i] === "^" && /^\{?[(가-힣]/.test(this.s.slice(this.i + 1))) { this.i++; name += `^{${this.script()}}`; }
    // 아래첨자가 자리(x · t · u · 수)면 계열의 자리, 그 밖(α_S · P_base · P_β)이면 이름의 일부다
    while (this.s[this.i] === "_") {
      this.i++;
      const sub = this.script();
      if (isIndex(sub)) return { t: "ref", name, idx: indexNode(sub) };
      name += `_${sub}`;
    }
    if (this.peek() === "(" && FUNCS.has(name)) {
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
const FUNCS = new Set(["if", "min", "max", "round", "round₅"]);

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
      if (node.f === "round₅") return Math.round(xs[0] * 1e5) / 1e5;
      return Math.round(xs[0]);
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

/** 이름 하나의 값 — 자리를 주면 계열, 안 주면 스칼라 */
export function valueOf(mo: Model, name: string, i?: number): number {
  const cache = new Map<string, number>(), busy = new Set<string>();
  return i === undefined && mo.scalar[name] !== undefined ? mo.scalar[name] : series(name, i ?? 0, mo, cache, busy);
}

// ── 조건 → 계산 ─────────────────────────────────────────────────────────────
/** 계산할 계약 한 점 — 산출방법서의 정보가 아니라 계산하는 앱의 입력이다(spec.contract 와 같은 뜻) */
export interface CalcContract { age: number; sex?: Sex; payYears: number; freq: number; termYears?: number }
export const CALC_DEFAULT: CalcContract = { age: 40, sex: "M", payYears: 20, freq: 12 };

export interface BenefitResult {
  id: string; name: string;
  /** 이 담보가 속한 집단 이름 */
  group: string;
  /** 이 담보의 보장기간(년) · 납입기간(년) */
  n: number; m: number;
  amount?: number;
  pvb: number; nStar: number; net: number; base: number; gross: number;
  /** 10만원당 영업보험료(원, 반올림) · 이 담보의 보험료(원) */
  per100k: number; premium: number;
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

/** 담보 하나를 계산할 준비 — 기간·위험률 계열·기호 값·식 목록. computeSpec 과 계산 표(calcSheets)가 같은 것을 쓴다 */
function prepare(spec: MethodSpec, m: BenefitModel, contract: CalcContract, formulas: FormulaSpec[]) {
  const b = m.b;
  const n = Math.max(1, Math.min(contract.termYears ?? 999, (b.endAge ?? 110) + 1 - contract.age));
  const pay = Math.min(contract.payYears, n);
  const known: Record<string, number[]> = {};
  const label: Record<string, string> = { ...SYM_LABEL };
  const missing: string[] = [];
  for (const { sym, rate } of [...m.group.syms, ...m.group.waivers, ...(m.event ? [m.event] : [])]) {
    label[sym] = rate.name;
    if (known[sym]) continue;
    const { values, ok } = rateSeries(rate, contract, n + 1);
    known[sym] = values;
    if (!ok) missing.push(rate.name);
  }
  if (m.group.lapseRate !== undefined) known.w = Array.from({ length: n + 1 }, (_, t) => (t < pay ? m.group.lapseRate! : 0));
  const scalar: Record<string, number> = {
    n, m: pay, k: contract.freq, x: contract.age,
    i: spec.basis.interest ?? 0, v: 1 / (1 + (spec.basis.interest ?? 0)), ρ: spec.basis.lowRatio ?? 0,
    "α_S": expenseOf(spec, "α_S"), "α_P": (expenseOf(spec, "α_P") * Math.min(n, 20)) / 20,
    "β_S": expenseOf(spec, "β_S"), "β_G": expenseOf(spec, "β_G"), "β′": expenseOf(spec, "β′"),
    γ: expenseOf(spec, "γ"), α: expenseOf(spec, "α"), β: expenseOf(spec, "β"),
  };
  const text = formulas
    .filter((f) => f.key && [`group:${m.group.id}`, `benefit:${b.id}`].includes(f.key) || /^(pv:|premium:(P|base|G)$)/.test(f.key ?? ""))
    .map((f) => f.text).join("\n");
  return { n, pay, known, scalar, label, missing, text };
}

/**
 * 산출방법서의 식으로 담보마다 보험료를 낸다 — 조건(위험률·금액·기간)과 식을 함께 쓴다.
 * 쓰는 식은 withFormulas 를 거친 것이라 **사용자가 고친 식이 그대로 계산에 반영된다.**
 * 담보 하나를 독립된 소형 상품으로 본다(자유설계보험 computePlan 과 같은 규칙):
 * 보장기간 n = min(계약 보험기간, 보장 종료 나이 + 1 − 가입나이), 납입기간 m = min(납입기간, n).
 */
export function computeSpec(spec: MethodSpec, contract: CalcContract = CALC_DEFAULT): CalcResult {
  const formulas = withFormulas(spec).formulas;
  const out: CalcResult = { contract, benefits: [], premium: 0, missingRates: [], errors: [] };
  for (const m of benefitModels(spec)) {
    const b = m.b;
    const { n, pay, known, scalar, missing, text } = prepare(spec, m, contract, formulas);
    for (const name of missing) if (!out.missingRates.includes(name)) out.missingRates.push(name);
    const { eqs, skipped } = parseLines(text);
    const res: BenefitResult = {
      id: b.id, name: b.name, group: m.group.label, n, m: pay, amount: b.amount,
      pvb: 0, nStar: 0, net: 0, base: 0, gross: 0, per100k: 0, premium: 0, skipped,
    };
    try {
      const mo: Model = { defs: buildDefs(eqs), known, scalar, n };
      res.pvb = valueOf(mo, "PVB");
      res.nStar = valueOf(mo, "N*");
      res.net = valueOf(mo, "P");
      res.base = valueOf(mo, "P_base");
      res.gross = valueOf(mo, "G");
      res.per100k = Math.round(res.gross * 1e5);
      res.premium = res.per100k * ((b.amount ?? 0) / 1e5);
      out.premium += res.premium;
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      out.errors.push(`${b.name}: ${res.error}`);
    }
    out.benefits.push(res);
  }
  return out;
}

/** 식 한 덩이가 이 문법으로 읽히는지 — 조건 화면이 "계산에 쓸 수 있는 식" 인지 알린다 */
export function checkFormula(f: FormulaSpec): { ok: boolean; skipped: string[] } {
  const { eqs, skipped } = parseLines(f.text);
  return { ok: eqs.length > 0, skipped };
}

// ── 계산 표 — 엑셀처럼 한 해 한 줄 ──────────────────────────────────────────
/** 기호의 뜻. 위험률 기호(q · r · f · g)는 조건의 위험률 이름으로 덮어쓴다 */
const SYM_LABEL: Record<string, string> = {
  Q: "탈퇴율", w: "적용해지율", l: "유지자수", "l′": "납입자수", d: "지급자수 (급부 발생자)",
  D: "유지자수의 현가", "D′": "납입자수의 현가", W: "해지자의 현가",
  N: "유지자수 현가의 누계", "N′": "납입자수 현가의 누계",
  S: "보장금액의 배수", E: "생존 지급 배수", C: "급부 발생자의 현가", M: "보험금 현가의 누계",
  "N*": "연납 환산 납입기수", PVB: "보험금의 현가", P: "순보험료 (1원당)", P_base: "기준연납순보험료", G: "영업보험료 (1원당)",
  v: "현가율", i: "적용이율", n: "보장기간(년)", m: "납입기간(년)", k: "납입주기별 계수", x: "가입나이",
};
/** 왼쪽부터 이 순서로 — 위험률 → 사람 수 → 사람 수의 현가·누계 → 보험금 */
const COL_ORDER = ["Q", "l", "l′", "d", "D", "D′", "W", "N", "N′", "S", "E", "C", "M"];
const DIGITS: Record<string, number> = { l: 2, "l′": 2, d: 4, D: 4, "D′": 4, W: 4, N: 2, "N′": 2, C: 6, M: 4, S: 4, E: 4, Q: 8, w: 6 };

export interface CalcColumn {
  sym: string;
  label: string;
  /** 이 열을 만든 식 (위험률 열은 표에서 온 값이라는 안내) */
  formula: string;
  /** rate 표에서 온 값 · discount 이율에서 나온 현가율 · series 식으로 만든 계열 */
  kind: "rate" | "discount" | "series";
  digits: number;
  values: number[];
  /** 그 자리의 값이 어떤 값들로 나왔는지 (팝업) — 식에 나오는 기호와 그 값 */
  parts: { ref: string; value: number }[][];
  /** 읽어 둔 식 — 엑셀 수식으로 옮길 때 쓴다(위험률·현가율 열은 없다) */
  eq?: Equation;
  /** 점화식이면 앞자리를 몇 칸 쓰는지 (l_{x+t+1} = … → 1). 그 앞줄은 init */
  offset: number;
  init?: number;
}
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
}
export interface CalcSheet {
  id: string; name: string; group: string;
  n: number; m: number;
  /** 줄마다 경과기간 t 와 그때의 나이 */
  ages: number[];
  /** 왼쪽에 늘어놓는 계약·기초율 — 내려받은 파일만으로 다시 세울 수 있게 */
  inputs: CalcInput[];
  cols: CalcColumn[];
  /** 표 아래 — 한 값으로 나오는 것(N* · PVB · P · G) */
  scalars: CalcScalarRow[];
  amount?: number;
  per100k: number;
  premium: number;
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
 */
export function calcSheets(spec: MethodSpec, contract: CalcContract = CALC_DEFAULT): CalcSheets {
  const formulas = withFormulas(spec).formulas;
  const out: CalcSheets = { contract, sheets: [], premium: 0, per100k: 0, missingRates: [] };
  for (const bm of benefitModels(spec)) {
    const b = bm.b;
    const { n, pay, known, scalar, label, missing, text } = prepare(spec, bm, contract, formulas);
    for (const name of missing) if (!out.missingRates.includes(name)) out.missingRates.push(name);
    // 지급자수 d 는 문서의 C 식에서 v^{t+½} 를 뺀 부분이다 — 표에서만 따로 보여 준다
    const { eqs } = parseLines(`${text}\n${bm.payout}`);
    const meth = !spec.expenses.length || spec.expenses.some((e) => /^(α_S|α_P|β_S|β_G)$/.test(e.symbol));
    const sheet: CalcSheet = {
      id: b.id, name: b.name, group: bm.group.label, n, m: pay,
      ages: Array.from({ length: n + 1 }, (_, t) => contract.age + t),
      // 계산에 앞서 정한 값 — 이것과 위험률만 값이고 나머지는 모두 식에서 나온다
      inputs: [
        { label: "가입나이 x", name: "x_age", value: contract.age, digits: 0, note: "세" },
        { label: "성별", value: contract.sex === "F" ? "여" : "남" },
        { label: "보장기간 n", name: "n_term", value: n, digits: 0, note: `년 — min(보험기간, ${b.endAge ?? 110}세 + 1 − 가입나이)` },
        { label: "납입기간 m", name: "m_pay", value: pay, digits: 0, note: "년 — min(납입기간, n)" },
        { label: "납입주기 k", name: "k_freq", value: contract.freq, digits: 0, note: "연 납입횟수" },
        { label: "적용이율 i", name: "i_rate", value: spec.basis.interest ?? 0, digits: 6 },
        { label: "현가율 v", name: "v_disc", value: scalar.v, digits: 10, formula: "v = 1 / ( 1 + i )" },
        { label: "보장금액", name: "S_amt", value: b.amount ?? 0, digits: 0, note: "원" },
        ...(b.waitDays ? [{ label: "면책", value: b.waitDays, digits: 0, note: `일 — 첫해 보험금 × ( 1 − ${waitMonths(b.waitDays)}/12 )` }] : []),
        ...(meth
          ? ([["α_S", "alphaS"], ["α_P", "alphaP"], ["β_S", "betaS"], ["β_G", "betaG"], ["β′", "betaPrime"], ["γ", "gamma"]] as const)
            .map(([sym, name]) => ({ label: sym === "α_P" ? "α_P (적용값)" : sym, name, value: scalar[sym] ?? 0, digits: 8,
              ...(sym === "α_P" && n < 20 ? { note: `보장기간이 20년보다 짧아 × ${n}/20` } : {}) }))
          : ([["α", "alpha"], ["β", "beta"], ["γ", "gamma"]] as const).map(([sym, name]) => ({ label: sym, name, value: scalar[sym] ?? 0, digits: 8 }))),
      ],
      cols: [], scalars: [], amount: b.amount, per100k: 0, premium: 0,
    };
    try {
      const mo: Model = { defs: buildDefs(eqs), known, scalar, n };
      const at = (name: string, t: number) => valueOf(mo, name, t);
      const rateSyms = [...new Set([...bm.group.syms, ...bm.group.waivers, ...(bm.event ? [bm.event] : [])].map((x) => x.sym))];
      const sourceOf = (sym: string) => [...bm.group.syms, ...bm.group.waivers, ...(bm.event ? [bm.event] : [])].find((x) => x.sym === sym)?.rate;
      for (const sym of [...rateSyms, ...(known.w ? ["w"] : [])]) {
        const r = sourceOf(sym);
        sheet.cols.push({
          sym, label: label[sym] ?? sym, kind: "rate", digits: 8, values: known[sym] ?? [], parts: [], offset: 0,
          formula: sym === "w" ? "조건 1.3. 적용해지율 — 납입기간 중" : `위험률 표에서 온 값${r?.source ? ` — ${r.source}` : ""}`,
        });
      }
      // 현가율 — 위험률 바로 오른쪽. 값이 아니라 적용이율에서 나오는 식이다(D 는 v^t 를, C 는 v^{t+½} 를 쓴다)
      for (const [sym, why] of [["v^t", "그 해 초의 현가율 — 유지자수·납입자수의 현가 D·D′ 에 쓴다"],
        ["v^{t+½}", "그 해 가운데의 현가율 — 급부는 연도 중앙에 생긴다고 보아 C 에 쓴다"]] as const) {
        const half = sym.includes("½") ? 0.5 : 0;
        sheet.cols.push({
          sym, label: "현가율", kind: "discount", digits: 10, offset: 0, parts: [],
          formula: `${sym} = ( 1 / ( 1 + i ) )^{t${half ? "+½" : ""}} — ${why}`,
          values: Array.from({ length: n + 1 }, (_, t) => scalar.v ** (t + half)),
        });
      }
      const names = [...COL_ORDER.filter((x) => mo.defs.has(x)), ...[...mo.defs.keys()].filter((x) => !COL_ORDER.includes(x) && isSeries(mo, x))];
      for (const sym of names) {
        const d = mo.defs.get(sym)!;
        const eq = d.direct ?? d.recur?.eq ?? [...d.points.values()][0];
        if (!eq) continue;
        const refs = refsOf(eq.expr).filter((r) => r.name !== "v" && (mo.known[r.name] || isSeries(mo, r.name)));
        const off = d.recur?.off ?? 0;
        sheet.cols.push({
          sym, label: label[sym] ?? sym, kind: "series", digits: DIGITS[sym] ?? 4, formula: eq.line, eq, offset: off,
          ...(off && d.points.has(0) ? { init: at(sym, 0) } : {}),
          values: Array.from({ length: n + 1 }, (_, t) => at(sym, t)),
          parts: Array.from({ length: n + 1 }, (_, t) => {
            const base = t >= off ? t - off : t;
            return refs.map((r) => {
              const i = r.idx ? Math.round(evalNode(r.idx, mo, { t: base, u: base }, new Map(), new Set())) : base;
              return { ref: `${r.name}${r.idx ? `(${contract.age + i})` : ""}`, value: at(r.name, i) };
            });
          }),
        });
      }
      for (const sym of ["N*", "PVB", "P", "P_base", "G"]) {
        const d = mo.defs.get(sym);
        if (!d) continue;
        const eq = d.scalar ?? d.direct;
        sheet.scalars.push({ sym, label: label[sym] ?? sym, formula: eq?.line ?? "", value: valueOf(mo, sym), digits: sym === "N*" ? 2 : 8, eq });
      }
      sheet.per100k = Math.round(valueOf(mo, "G") * 1e5);
      sheet.premium = sheet.per100k * ((b.amount ?? 0) / 1e5);
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
