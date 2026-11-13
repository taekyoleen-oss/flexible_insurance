import { calcSheets, roundDigits, sheetsByUnit, type CalcContract, type CalcSheet, type CalcSheets, type Node } from "./calc";
import { rateTable, type MethodSpec } from "./spec";

/**
 * 보험료 계산 → 파이썬 코드(셀 단위). 산출 과정을 **단계마다 주석과 함께** 적어 그대로 실행할 수 있다.
 *
 * 엑셀(calc-xlsx.ts)과 같은 원천 — 읽어 둔 식(CalcColumn.eq)의 AST 를 파이썬 식으로 옮긴다:
 *   l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )   →   l[t+1] = (l[t]*(1-Q[t]))
 *   N_{x+t}   = Σ_{u≥t} D_{x+u}             →   N[t] = sum(D[u] for u in range(t, n+1))
 *   P         = PVB / N*                    →   P = (PVB/Nstar)
 * 값(위험률·계약·기초율)만 자료이고 나머지는 식이다 — 파이썬이 낸 값이 앱·엑셀과 같아야 한다(tests/calc-py.test.ts 가 파이썬을 돌려 확인한다).
 * 브라우저에서는 Pyodide 로 셀을 하나씩 실행한다(components/PythonPanel.tsx).
 */
/** module — 산출 흐름(calc-flow.ts)의 모듈 id. 셀 하나가 모듈 하나다 */
export interface PyCell { title: string; code: string; module: string }

/** 기호 → 파이썬 이름. 그리스 문자·프라임·별표·첨자·한글 이름을 알파벳 이름으로 */
const NAME_MAP: Record<string, string> = {
  "l′": "lp", "D′": "Dp", "N′": "Np", "N*": "Nstar", "PVB′": "PVB_p", "G₁": "G1", "G_10만": "G_100k", "V_10만": "V_100k",
  "P_β": "P_beta", "W^{표준}": "W_std", "V^{표준}": "V_std", "V^{결산}": "V_acc", "α^{공제}": "alpha_ded", "α^{표준}": "alpha_std", 해약공제: "deduction", 납입누계: "paid", 환급률: "refund_rate", "V^{10만}": "V_100k",
  "α_S": "alpha_S", "α_P": "alpha_P", "β_S": "beta_S", "β_G": "beta_G", "β′": "beta_prime", γ: "gamma", α: "alpha", β: "beta", ρ: "rho",
  "v^t": "vt", "v^{t+½}": "vth",
  // 적립형
  "P^{위험}": "P_risk", "E^{체결}": "E_acq", "P^{적립}": "P_save", "j^{보증}": "j_guar", "j^{공시}": "j_pub", "α′": "alpha_p", 사망보험금: "death_benefit", 보장금액: "S_won", 기본보험료: "G",
};
export function pyName(sym: string): string {
  if (NAME_MAP[sym]) return NAME_MAP[sym];
  return sym.replace(/′/g, "p").replace(/\*/g, "star").replace(/\^\{\((\d+)\)\}/g, "_$1").replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080))
    .replace(/[{}^]/g, "").replace(/[^A-Za-z0-9_]/g, "_");
}

interface Ctx { series: Set<string>; scalars: Set<string>; known: Set<string> }

const OPS: Record<string, string> = { "+": "+", "−": "-", "×": "*", "/": "/", "=": "==", "≤": "<=", "≥": ">=", "<": "<", ">": ">" };

/** 자리 식 → 파이썬 식 (t · u · n · m 과 수) */
function pyIndex(node: Node): string {
  switch (node.t) {
    case "num": return String(node.v);
    case "ref": return node.name;
    case "neg": return `-(${pyIndex(node.a)})`;
    case "bin": return `(${pyIndex(node.a)}${OPS[node.op] ?? "+"}${pyIndex(node.b)})`;
    case "call": return `${node.f}(${node.args.map(pyIndex).join(", ")})`;
    default: return "0";
  }
}

/** 식(AST) → 파이썬 식. 계열은 리스트 자리, 스칼라는 이름. 0 으로 나누면 0(앱과 같다) */
export function toPython(node: Node, c: Ctx): string {
  switch (node.t) {
    case "num": return String(node.v);
    case "neg": return `-(${toPython(node.a, c)})`;
    case "bin": {
      if (node.op === "^" && node.a.t === "ref" && node.a.name === "v" && !node.a.idx) return `v**(${pyIndex(node.b)})`;
      const a = toPython(node.a, c), b = toPython(node.b, c);
      if (node.op === "^") return `(${a})**(${b})`;
      if (node.op === "/") return `div(${a}, ${b})`;
      if (["=", "≤", "≥", "<", ">"].includes(node.op)) return `(1 if ${a} ${OPS[node.op]} ${b} else 0)`;
      return `(${a}${OPS[node.op]}${b})`;
    }
    case "call": {
      const args = node.args.map((x) => toPython(x, c));
      if (node.f === "if") return `(${args[1]} if ${args[0]} else ${args[2] ?? 0})`;
      if (node.f.startsWith("round")) return `rnd(${args[0]}, ${roundDigits(node.f)})`;
      return `${node.f}(${args.join(", ")})`;
    }
    case "sum": return `sum(${toPython(node.body, c)} for ${node.v} in range(${pyIndex(node.from)}, ${pyIndex(node.to)} + 1))`;
    case "ref": {
      const nm = pyName(node.name);
      if (node.idx === undefined) return c.series.has(node.name) ? `${nm}[0]` : nm;
      if (node.name === "CSV") return "0";                      // 저해지형의 해지급부 현가 — 이 앱은 0 으로 둔다
      return `${nm}[${pyIndex(node.idx)}]`;
    }
  }
}

const PEOPLE = ["Q", "l", "l′"], PV = ["D", "D′", "H", "N", "N′"], BEN = ["d", "S", "E", "C", "M"];
const RESERVE = ["V", "V^{10만}", "V^{표준}", "V^{결산}", "해약공제", "W^{표준}", "W", "납입누계", "환급률"];
const COVER = ["PVB", "PVB′"], PAY = ["N*"], PREM = ["P", "P_base", "G", "G₁", "G_10만"];
const RES_SC = ["P_β", "α^{표준}", "α^{공제}"];
/** 준비금·환급금 단계의 기호 — 산출 흐름이 경고("V: …")를 그 단계 상자에 붙일 때 쓴다 */
export const RES_SYMS = [...RESERVE, ...RES_SC];
// 적립형 — 보험료의 구성 · 계약자적립액 · 환급금
const SAVE_PARTS = ["j^{보증}", "j", "E^{체결}", "P^{적립}", "s"], SAVE_AV = ["AV"], SAVE_REFUND = ["해약공제", "납입누계", "W", "환급률", "사망보험금"];

/** 앱 · 파이썬 · 엑셀을 맞대어 볼 값(보장마다) — 여기에 담보 보험료 `prem`(적립형은 `만기환급금`)이 붙는다. 열쇠는 `<보장 id>.<기호>` */
export const COMPARE_SYMS = ["N*", "PVB", "P", "G₁", "G_10만"];
export const SAVINGS_COMPARE = ["N*", "PVB", "P", "P^{위험}"];

/** 산출 단계(모듈)의 설명 — 파이썬 셀의 머리 주석과 산출 흐름 화면이 같은 글을 쓴다 */
export interface Step { name: string; does: string; takes: string; gives: string; doc: string }
export const STEPS: Record<string, Step> = {
  basis: { name: "계약·기초율", does: "계산에 앞서 정하는 값을 적는다 — 계약 한 점(성별·가입나이·가입금액·납입주기)과 이율·사업비", takes: "산출방법서의 예정기초율 · 화면의 [산출 조건]", gives: "x(가입나이) · k(납입주기) · i(이율) · v(현가율) · 사업비 기호", doc: "1장 가. 예정기초율 — (1) 이율 · (4) 사업비" },
  rates: { name: "위험률 표", does: "연령마다의 연 발생률을 표로 둔다 — 값으로 넣는 것은 이 표와 계약·기초율뿐이고 나머지는 모두 식이다", takes: "산출방법서의 예정위험률 · 별첨 위험률 표", gives: "rates[위험률 이름][연령]", doc: "1장 가.(2) 예정위험률 · 별첨 — 위험률 표" },
  cond: { name: "보장 조건과 위험률 계열", does: "이 보장의 기간(보장기간 n · 납입기간 m)과 보장금액을 정하고, 위험률 표에서 가입나이부터 n 년치를 잘라 온다", takes: "계약·기초율 · 위험률 표", gives: "n · m · 보장금액 · 위험률 계열 · 현가율 v^t · v^{t+½}", doc: "1장 마. 보장 (표) · 개요의 가입 조건" },
  surv: { name: "유지자", does: "기준 인원 100,000명이 해마다 탈퇴 사유(사망·질병)로 줄어드는 모습을 내고, 그 현가 D 와 누계 N 을 구한다. 보험료를 내는 사람([납입] 유지자)의 것은 D′ · N′", takes: "위험률 계열 · 현가율 v^t", gives: "l(유지자수) · D · N — [납입] 유지자는 l′ · D′ · N′", doc: "1장 다. 유지자" },
  ben: { name: "보험금", does: "해마다 보험금을 받는 사람 수 d(유지자수 × 발생률)를 내고, 연도 가운데 시점의 현가 C 와 그 누계 M 을 구한다", takes: "유지자수 l · 위험률 계열 · 현가율 v^{t+½}", gives: "d · S(보장금액의 배수 — 면책·삭감 반영) · C · M", doc: "1장 라. 보험금" },
  cover: { name: "보장 (보험금의 현가)", does: "이 보장이 보험기간 동안 줄 보험금을 지금 가치로 모두 더한다 (보장금액 1원당)", takes: "S · C (보험금)", gives: "PVB", doc: "1장 마. 보장" },
  pay: { name: "납입기수", does: "보험료를 몇 번 내는 셈인지를 지금 가치로 센다 — [납입] 유지자의 현가 누계에서 납입주기(월납 등)를 반영해 연납으로 환산한다", takes: "D′ · N′ ([납입] 유지자) · m · k", gives: "N*", doc: "1장 바. 순보험료 및 영업보험료 — N*" },
  prem: { name: "순보험료·영업보험료", does: "보험금의 현가를 납입기수로 나눠 순보험료를 내고 사업비를 얹어 영업보험료를 만든다 → 1원당 6자리 반올림 → 10만원당 → 이 보장의 보험료(10원 미만 버림)", takes: "PVB · N* · 사업비", gives: "P · G · G₁ · 10만원당 보험료 · 보험료(원)", doc: "1장 바. 순보험료 및 영업보험료" },
  res: { name: "책임준비금·해지환급금", does: "해마다 회사가 쌓아 둘 금액 V 와 해지할 때 돌려줄 금액 W(= V − 해약공제), 낸 보험료 대비 환급률을 낸다", takes: "유지자(D · N) · 보험금(M) · 보험료", gives: "P_β · V · 해약공제 · W · 환급률", doc: "2장 책임준비금 · 3장 해지환급금" },
  total: { name: "합계 — 엑셀과 견줄 값", does: "보장마다의 보험료를 계약 단위(주계약·특약)로 더하고, 앱·엑셀과 맞대어 볼 값을 표로 찍는다", takes: "보장마다의 N* · PVB · P · G₁ · 10만원당 · 보험료", gives: "계약 단위별 보험료 · 합계", doc: "(계산 결과 정리)" },
  // 적립형
  risk: { name: "위험보험료 (유지자 · 보험금 · 순보험료)", does: "사망 보장의 값을 낸다 — 유지자·보험금 기수로 평준 순보험료 P 를 내고 기본보험료 1원당 위험보험료로 바꾼다", takes: "위험률 계열 · 확정이율 i · 보장금액", gives: "l · D · N · C · M → N* · PVB · P · P^{위험}", doc: "1장 다. 유지자 · 라. 보험금 · 마. 보장 · 바. 보험료의 구성" },
  parts: { name: "보험료의 구성", does: "기본보험료 1원에서 계약체결비용·계약관리비용·위험보험료를 떼고 남는 적립보험료를 내고, 해마다 붙는 이율(공시이율과 최저보증이율 가운데 큰 것)을 정한다", takes: "α · α′ · β · P^{위험} · 공시이율 · 최저보증이율", gives: "E^{체결} · P^{적립} · j(적용이율) · s(월 적립 계수)", doc: "1장 바. 보험료의 구성" },
  av: { name: "계약자적립액", does: "적립보험료를 매달 넣고 이율로 불려 해마다 쌓인 금액을 낸다 (기본보험료 1원당)", takes: "P^{적립} · j · s", gives: "AV", doc: "2. 계약자적립액의 계산에 관한 사항" },
  refund: { name: "해약환급금·만기환급금", does: "적립액에서 해약공제를 빼 환급금을 내고, 낸 보험료 대비 환급률과 사망보험금을 낸다", takes: "AV · 해약공제 조건", gives: "해약공제 · W · 납입누계 · 환급률 · 사망보험금", doc: "3. 해약환급금 및 만기환급금의 계산에 관한 사항" },
};
const BAR = `# ${"═".repeat(64)}`;
/** 셀 머리 주석 — 이 단계가 하는 일 · 받는 값 · 내는 값 · 산출방법서의 어느 식 */
const head = (title: string, kind: string) => {
  const s = STEPS[kind];
  return [BAR, `# ■ ${title}`, `#   하는 일    : ${s.does}`, `#   받는 값    : ${s.takes}`, `#   내는 값    : ${s.gives}`, `#   산출방법서 : ${s.doc}`, BAR];
};

const q = (s: string) => JSON.stringify(s);
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(v));

/** 계열 정의 한 줄 → 파이썬 줄들 (주석 = 이름과 뜻 · 산출방법서의 식) */
function seriesLines(col: CalcSheet["cols"][number], c: Ctx): string[] {
  const nm = pyName(col.sym);
  const what = `# ▶ ${nm} — ${col.label}`;
  // 저해지형의 해지급부 현가 — 앱이 0 으로 두므로(표준형 보험료·준비금) 식을 옮기지 않는다
  if (col.sym === "CSV") return [what, `# ${col.formula}`, `${nm} = [0.0] * (n + 1)   # 이 앱은 0 으로 둔다 — 저해지 해지급부의 값은 자유설계보험이 낸다`];
  if (!col.eq) return [what, `${nm} = ${JSON.stringify(col.values)}   # ${col.formula}`];
  const expr = toPython(col.eq.expr, c);
  if (col.offset) {
    // 점화식: 첫 자리는 기준 값, 그 다음부터 앞자리로
    const init = col.init ?? col.values[0] ?? 0;
    return [what, `# ${col.formula}`, `${nm} = [0.0] * (n + 1)`, `${nm}[0] = ${fmt(init)}   # 첫 해(t = 0)의 값에서 시작한다`,
      `for t in range(n):   # 한 해씩 — 앞 해의 값으로 다음 해의 값을 만든다`, `    ${nm}[t + ${col.offset}] = ${expr}`];
  }
  return [what, `# ${col.formula}`, `${nm} = [0.0] * (n + 1)`, `for t in range(n + 1):   # 경과연수 t = 0 … n 마다 (나이 x + t)`, `    ${nm}[t] = ${expr}`];
}

function scalarLines(sc: CalcSheet["scalars"][number], c: Ctx): string[] {
  const nm = pyName(sc.sym);
  if (!sc.eq) return [`# ▶ ${nm} — ${sc.label}`, `${nm} = ${sc.value}   # ${sc.formula}`];
  return [`# ▶ ${nm} — ${sc.label}`, `# ${sc.formula}`, `${nm} = ${toPython(sc.eq.expr, c)}`];
}

/** 식이 가리키는 이름들 */
function refsOf(node: Node, out = new Set<string>()): Set<string> {
  if (node.t === "ref") { out.add(node.name); if (node.idx) refsOf(node.idx, out); }
  else if (node.t === "bin") { refsOf(node.a, out); refsOf(node.b, out); }
  else if (node.t === "neg") refsOf(node.a, out);
  else if (node.t === "call") node.args.forEach((x) => refsOf(x, out));
  else if (node.t === "sum") { refsOf(node.from, out); refsOf(node.to, out); refsOf(node.body, out); }
  return out;
}
type Col = CalcSheet["cols"][number];
const refsOfCol = (col: Col) => (col.eq ? refsOf(col.eq.expr) : new Set<string>());
/** 앞의 계열을 쓰는 계열이 뒤에 오게 — 사용자가 더한 식(F · R …)도 쓰이기 전에 정의된다 */
function inOrder(cols: Col[]): Col[] {
  const out: Col[] = [], left = [...cols];
  while (left.length) {
    const i = left.findIndex((c) => [...refsOfCol(c)].every((r) => r === c.sym || !left.some((x) => x.sym === r)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

type Sc = CalcSheet["scalars"][number];
/**
 * 계산 표 한 장의 열·값을 산출 단계(모듈)로 가른다 — 파이썬 셀과 산출 흐름 화면(calc-flow.ts)이 같은 가름을 쓴다.
 * 보장성: surv 유지자 · ben 보험금 · cover 보장 · pay 납입기수 · prem 보험료 · res 준비금·환급금
 * 적립형: risk 위험보험료 · parts 보험료의 구성 · av 계약자적립액 · refund 환급금
 */
export function sheetParts(s: CalcSheet): { rates: Col[]; discount: Col[]; steps: Record<string, { cols: Col[]; scalars: Sc[] }> } {
  const series = s.cols.filter((x) => x.kind === "series");
  const pick = (syms: string[]) => syms.map((sym) => series.find((x) => x.sym === sym)).filter((x): x is Col => !!x);
  const sc = (syms: string[]) => s.scalars.filter((x) => syms.includes(x.sym));
  const rates = s.cols.filter((x) => x.kind === "rate"), discount = s.cols.filter((x) => x.kind === "discount");
  if (s.savings) {
    const save = [...SAVE_PARTS, ...SAVE_AV, ...SAVE_REFUND];
    // 차례는 적립형 계열 전체에서 한 번 정하고 단계로 가른다
    const ordered = inOrder(series.filter((x) => save.includes(x.sym)));
    const of = (syms: string[]) => ({ cols: ordered.filter((x) => syms.includes(x.sym)), scalars: [] });
    return { rates, discount, steps: { risk: { cols: inOrder(series.filter((x) => !save.includes(x.sym))), scalars: s.scalars }, parts: of(SAVE_PARTS), av: of(SAVE_AV), refund: of(SAVE_REFUND) } };
  }
  // 유지자 lx(k) 의 계열(l^{(k)} · Q^{(k)} · R^{(k)} · D^{(k)} · N^{(k)}) — 유지자 단계에서 lx · Dx · Nx 까지 낸다
  const survSyms = [...series.filter((x) => /\^\{\(\d+\)\}$/.test(x.sym)).map((x) => x.sym), ...PEOPLE, ...PV];
  const rest = series.filter((x) => ![...survSyms, ...BEN, ...RESERVE].includes(x.sym));
  // 유지자 단계가 쓰는 덧붙은 계열(납입자수의 F …)은 그 단계로 당겨 온다 — 나머지(급부 발생률 R …)는 보험금 단계에
  const early = new Set<string>();
  const pull = (col: Col) => { for (const r of refsOfCol(col)) { const x = rest.find((y) => y.sym === r); if (x && !early.has(r)) { early.add(r); pull(x); } } };
  pick(survSyms).forEach(pull);
  return { rates, discount, steps: {
    surv: { cols: inOrder([...rest.filter((x) => early.has(x.sym)), ...pick(survSyms)]), scalars: [] },
    ben: { cols: inOrder([...pick(BEN), ...rest.filter((x) => !early.has(x.sym))]), scalars: [] },
    cover: { cols: [], scalars: sc(COVER) }, pay: { cols: [], scalars: sc(PAY) }, prem: { cols: [], scalars: sc(PREM) },
    res: { cols: pick(RESERVE), scalars: sc(RES_SC) },
  } };
}

/** 담보 하나의 셀들 — 단계(모듈)마다 한 셀 */
function benefitCells(s: CalcSheet, bi: number): PyCell[] {
  const c: Ctx = { series: new Set(s.cols.map((x) => x.sym)), scalars: new Set(s.scalars.map((x) => x.sym)), known: new Set() };
  const { steps } = sheetParts(s);
  // 적용해지율 w 는 위험률 표가 아니라 조건(basis.lapse)에서 온다 — 아래 유지자 단계에서 값으로 둔다
  const rates = s.cols.filter((x) => x.kind === "rate" && x.sym !== "w");
  const input = (name: string) => s.inputs.find((x) => x.name === name);
  const tag = `담보 ${bi + 1}. ${s.name}`;
  const rateName = (sym: string) => s.cols.find((x) => x.sym === sym)?.label ?? sym;
  const lines = (kind: string) => [...steps[kind].scalars.flatMap((sc) => [...scalarLines(sc, c), ""]), ...steps[kind].cols.flatMap((col) => [...seriesLines(col, c), ""])];
  const cell = (kind: string, title: string, body: string[]): PyCell => ({ title: `${tag} — ${title}`, module: `${s.id}:${kind}`, code: [...head(`${STEPS[kind].name} — ${tag}`, kind), ...body].join("\n") });
  const has = (sym: string) => s.cols.some((x) => x.sym === sym);
  const cells: PyCell[] = [];
  cells.push(cell("cond", "조건과 위험률 계열", [
    `# ── ${tag} (유지자: ${s.group}) ──`,
    `# 담보 하나를 독립된 소형 상품으로 본다 — 보장기간 n 과 납입기간 m 은 이 담보의 것`,
    `n = ${s.n}          # 보장기간(년) = min(보험기간, ${input("n_term")?.note ?? ""})`,
    `m = ${s.m}          # 납입기간(년) = min(납입기간, n)`,
    `S_mult = ${s.multiple ?? "None"}   # 보장금액 배수 (${s.base ? "보험료 대비" : "가입금액 대비"})`,
    `S_amt = ${s.multiple !== undefined && !s.base ? "sum_assured * S_mult" : String(s.amount)}   # 보장금액(원)${s.base ? " — 이 계약 단위 정액 보장의 1회 보험료 합 × 배수" : ""}`,
    `alpha_P = ${input("alphaP")?.value ?? 0}   # α_P 적용값 — 보장기간이 20년보다 짧으면 × n/20`,
    ...(s.inputs.some((x) => x.label === "면책·삭감") ? [`# 면책·삭감: ${s.inputs.find((x) => x.label === "면책·삭감")?.value ?? ""} — 보장금액의 배수 S 에 반영된다`] : []),
    "",
    `# 위험률 계열 — 표에서 이 담보의 기간만큼 잘라 온다 (자리 t = 0 … n, 나이 x + t). 표에 없는 나이는 0`,
    ...rates.map((r) => `${pyName(r.sym)} = [rates[${q(rateName(r.sym))}].get(x + t, 0.0) for t in range(n + 1)]   # ${r.sym}: ${r.label}`),
    "",
    `# 현가율 — 그 해 초(v^t)와 그 해 가운데(v^{t+½}, 급부는 연중앙에 생긴다고 본다)`,
    `vt  = [v ** t for t in range(n + 1)]`,
    `vth = [v ** (t + 0.5) for t in range(n + 1)]`,
    `print(f"${tag}: n={n} m={m} 보장금액={S_amt:,.0f}원")`,
  ]));
  const w = s.cols.find((x) => x.sym === "w");
  cells.push(cell("surv", "유지자", [
    `# 이 담보의 유지자: ${s.group}`,
    ...(w ? [`w = ${JSON.stringify(w.values)}   # 적용해지율 (납입기간 중)`] : []),
    ...lines("surv"),
    ...(has("l") ? [`print("t, 나이, 유지자수 l (처음 5줄)")`, `for t in range(min(5, n + 1)): print(t, x + t, round(l[t], 2))`] : []),
    ...(has("D") && has("N") ? [`print(f"D[0]={D[0]:,.4f}  N[0]={N[0]:,.2f}")`] : []),
  ]));
  cells.push(cell("ben", "보험금", [
    ...lines("ben"),
    ...(has("d") ? [`print("t, 나이, 지급자수 d (처음 5줄)")`, `for t in range(min(5, n + 1)): print(t, x + t, round(d[t], 4))`] : []),
    ...(has("M") ? [`print(f"M[0]={M[0]:,.4f}")`] : []),
  ]));
  cells.push(cell("cover", "보장 (보험금의 현가)", [...lines("cover"), `print(f"PVB={PVB:,.8f}  (보장금액 1원당 보험금의 현가)")`]));
  cells.push(cell("pay", "납입기수", [...lines("pay"), `print(f"N*={Nstar:,.6f}  (연납으로 환산한 납입 횟수의 현가)")`]));
  const cmp = COMPARE_SYMS.filter((sym) => s.scalars.some((x) => x.sym === sym));
  cells.push(cell("prem", "보험료", [
    `# 순보험료 P → 기준연납순보험료 → 영업보험료 G → 1원당 6자리 → 10만원당 → 담보 보험료`,
    ...lines("prem"),
    `# ▶ premium — 담보 보험료(원) = 10만원당 × (보장금액 ÷ 10만), 10원 미만 버림`,
    `premium = math.floor(G_100k * S_amt / 1000000 + 1e-9) * 10`,
    `# 이 셀만 다시 실행해도 같은 보장이 두 번 더해지지 않게 — 앞서 적은 것을 지우고 다시 적는다`,
    `results[:] = [r for r in results if r["id"] != ${q(s.id)}]`,
    `results.append({"id": ${q(s.id)}, "name": ${q(s.name)}, "unit": ${q(s.unit)}, "n": n, "m": m, "Nstar": Nstar, "PVB": PVB, "P": P, "G1": G1, "per100k": G_100k, "premium": premium})`,
    `# 앱 · 엑셀과 맞대어 볼 값을 적어 둔다`,
    `compare.update({${[...cmp.map((sym) => `${q(`${s.id}.${sym}`)}: ${pyName(sym)}`), `${q(`${s.id}.prem`)}: premium`].join(", ")}})`,
    `print(f"N*={Nstar:,.2f}  PVB={PVB:,.4f}  P={P:.10f}  G={G:.10f}  G₁={G1:.6f}  10만원당={G_100k:,.0f}원  담보 보험료={premium:,.0f}원")`,
  ]));
  if (steps.res.cols.length) cells.push(cell("res", "책임준비금·해지환급금", [
    `# 준비금 산출용 순보험료 P_β → 연말 책임준비금 V → 해약공제 → 해지환급금 W → 환급률`,
    ...lines("res"),
    // 식으로 세우지 못한 열(경고)이 있으면 그 열을 찍지 않는다 — 없는 이름을 찍다 멈추면 뒤의 합계까지 돌지 않는다
    ...(has("V^{10만}") && has("W") && has("환급률") ? [
      `print("t, V(10만원당), W(10만원당), 환급률")`,
      `for t in (1, 3, 5, 10, 20, 30):`,
      `    if t <= n: print(t, V_100k[t], round(W[t] * 100000), f"{refund_rate[t]:.1%}")`,
    ] : [`print("준비금·환급금의 일부 열을 식으로 세우지 못해 표를 찍지 않는다 — 2·3장의 식을 확인한다")`]),
  ]));
  return cells;
}

/** 코딩을 모르는 사람이 코드를 읽는 법 — 첫 셀에 싣는다 */
const HOW_TO_READ = [
  `# ── 읽는 법 ──`,
  `#   · "#" 뒤는 설명(주석)이다. 실행되지 않는다. "# ▶ 이름 — 뜻" 다음 줄이 산출방법서의 식, 그 다음이 같은 식을 옮긴 코드다.`,
  `#   · X[t] 는 가입 후 t 년 지난 해의 값이다(나이 x + t). 예: l[3] = 3년 뒤의 유지자수.`,
  `#   · for t in range(n + 1): 은 "t = 0, 1, …, n 마다 아래 줄을 되풀이"한다는 뜻이다.`,
  `#   · sum(… for u in range(a, b + 1)) 은 산출방법서의 Σ(u = a 부터 b 까지 더하기)다.`,
  `#   · 셀을 위에서부터 차례로 실행한다 — 앞 셀이 만든 값을 뒤 셀이 쓴다.`,
];
const HELPERS = [
  `import math, json`,
  `def div(a, b):  # 0 으로 나누면 0 (산출방법서 계산기와 같다 — V 의 D_{x+n} = 0, 환급률의 납입누계_0 = 0)`,
  `    return 0 if b == 0 else a / b`,
  `def rnd(x, d=0):  # 반올림 — .5 는 올린다(엑셀 ROUND 와 같다. 파이썬 round() 는 짝수로 가서 162.5 → 162 가 된다)`,
  `    p = 10 ** d`,
  `    return math.floor(x * p + 0.5) / p if d else float(math.floor(x + 0.5))`,
];

/** 지금 조건·계약의 계산을 파이썬 셀로 — 산출 단계(모듈)마다 한 셀. 첫 셀이 공통 입력, 마지막 셀이 합계와 견줄 값 */
export function calcPython(spec: MethodSpec, contract: CalcContract, calc: CalcSheets = calcSheets(spec, contract)): PyCell[] {
  if (spec.savings) return savingsPython(spec, contract, calc.sheets);
  const units = sheetsByUnit(calc);
  const first = calc.sheets[0];
  const sex = contract.sex === "F" ? "F" : "M";
  const input = (name: string) => first?.inputs.find((x) => x.name === name);
  const usedRates = new Set(calc.sheets.flatMap((s) => s.cols.filter((x) => x.kind === "rate" && x.sym !== "w").map((x) => x.label)));
  const tables = spec.rates.filter((r) => usedRates.has(r.name)).map((r) => {
    const t = rateTable(r, sex);
    const pairs = t ? t.ages.map((a, i) => `${a}: ${t.values[i]}`).join(", ") : "";
    return `    ${q(r.name)}: {${pairs}},   # ${r.source ?? ""}`;
  });
  const cells: PyCell[] = [{ title: "계약·기초율", module: "basis", code: [
    `# ${spec.meta.productName || "상품"} — 산출방법서의 식을 그대로 파이썬으로 옮긴 일괄 산출`,
    `# 값은 계약·기초율과 위험률뿐이고 나머지는 모두 식이다 — 값을 바꾸고 다시 돌리면 보험료가 바뀐다.`,
    ...HOW_TO_READ,
    ...head(STEPS.basis.name, "basis"),
    ...HELPERS,
    ``,
    `x = ${contract.age}            # 가입나이`,
    `sex = ${q(sex === "F" ? "여" : "남")}`,
    `sum_assured = ${contract.sumAssured ?? 1e8}   # 보험가입금액(원) — 담보 보장금액 = 가입금액 × 배수`,
    `k = ${contract.freq}            # 납입주기별 계수 (연 납입횟수: 월납 12 · 3개월납 4 · 6개월납 2 · 연납 1)`,
    `i = ${input("i_rate")?.value ?? 0}        # 적용이율`,
    `v = 1 / (1 + i)   # 현가율 — 1년 뒤의 1원을 지금 가치로`,
    ...(input("i_std") ? [`i_std = ${input("i_std")!.value}   # 표준이율 — 해약공제 기준 신계약비의 표준기초율 값에`] : []),
    `rho = ${spec.basis.lowRatio ?? 0}   # 저해지·무해지 — 납입기간 중 해지환급금 비율 (표준형 0)`,
    `# 사업비 (산출방법서형)`,
    ...(first?.inputs ?? []).filter((x) => x.name && /^(alphaS|betaS|betaG|betaPrime|gamma|alpha|beta)$/.test(x.name)).map((x) => `${pyName({ alphaS: "α_S", betaS: "β_S", betaG: "β_G", betaPrime: "β′", gamma: "γ", alpha: "α", beta: "β" }[x.name!] ?? x.name!)} = ${x.value}   # ${x.label}`),
    `results = []      # 보장마다의 결과를 모은다`,
    `compare = {}      # 앱 · 엑셀과 맞대어 볼 값`,
    `print(f"계약: {sex} {x}세 · 가입금액 {sum_assured:,.0f}원 · k={k} · i={i}")`,
  ].join("\n") }, { title: "위험률 표", module: "rates", code: [
    ...head(STEPS.rates.name, "rates"),
    `# 연령 → 연 발생률 (${sex === "F" ? "여" : "남"}자 표). 조건의 위험률 표(별첨)와 같다`,
    `rates = {`, ...tables, `}`,
    `print("위험률:", ", ".join(f"{k}({len(v)}행)" for k, v in rates.items()))`,
  ].join("\n") }];
  calc.sheets.forEach((s, bi) => { if (!s.error) cells.push(...benefitCells(s, bi)); });
  cells.push({ title: "합계", module: "total", code: [
    ...head(STEPS.total.name, "total"),
    `print("── 엑셀과 견줄 값 (보장마다) ──")`,
    `print("보장 | N* | PVB | P | G₁ | 10만원당 | 보험료(원)")`,
    `for r in results:`,
    `    print(f"{r['name']} | {r['Nstar']:,.6f} | {r['PVB']:,.8f} | {r['P']:.10f} | {r['G1']:.6f} | {r['per100k']:,.0f} | {r['premium']:,.0f}")`,
    `# ── 담보 보험료의 합 (계약 단위마다) ──`,
    `for unit in dict.fromkeys(r["unit"] for r in results):`,
    `    rows = [r for r in results if r["unit"] == unit]`,
    `    print(f"{unit}: 10만원당 {sum(r['per100k'] for r in rows):,.0f}원 · ${contract.freq === 12 ? "월" : "회당"} 보험료 {sum(r['premium'] for r in rows):,.0f}원  (" + ", ".join(f"{r['name']} {r['premium']:,.0f}" for r in rows) + ")")`,
    `total = sum(r["premium"] for r in results)`,
    `compare["합계.prem"] = total`,
    `print(f"합계 {total:,.0f}원")`,
    ...(units.length > 1 ? [`# 주계약과 특약을 더한 것이 이 계약의 보험료다`] : []),
    `# 아래 두 줄은 기계가 읽는 줄이다 — 앱의 값 · 엑셀의 값과 맞대어 본다`,
    `print("RESULT", json.dumps(results, ensure_ascii=False))`,
    `print("COMPARE", json.dumps(compare, ensure_ascii=False))`,
  ].join("\n") });
  return cells;
}

/**
 * 적립형 — 공시이율 예시마다 위험보험료 → 보험료의 구성 → 계약자적립액 → 환급금. 마지막 줄 RESULT 에 해마다 W(원)를 찍는다(앱과 맞대어 본다)
 */
function savingsPython(spec: MethodSpec, contract: CalcContract, sheets: CalcSheet[]): PyCell[] {
  const first = sheets[0];
  const input = (name: string) => first?.inputs.find((x) => x.name === name)?.value;
  const sex = contract.sex === "F" ? "F" : "M";
  const tables = spec.rates.map((r) => {
    const t = rateTable(r, sex);
    return `    ${q(r.name)}: {${t ? t.ages.map((a, i) => `${a}: ${t.values[i]}`).join(", ") : ""}},   # ${r.source ?? ""}`;
  });
  const cells: PyCell[] = [{ title: "계약·기초율", module: "basis", code: [
    `# ${spec.meta.productName || "상품"} — 적립형(공시이율형). 산출방법서의 식을 그대로 파이썬으로 옮긴 일괄 산출`,
    `# 값은 모두 월 기본보험료 1원당이다 — 원 단위는 맨 뒤에 기본보험료 G 를 곱한다.`,
    ...HOW_TO_READ,
    ...head(STEPS.basis.name, "basis"),
    ...HELPERS,
    ``,
    `x = ${contract.age}            # 가입나이`,
    `sex = ${q(sex === "F" ? "여" : "남")}`,
    `G = ${input("base_premium") ?? 300000}   # 월 기본보험료(원)`,
    `n = ${first?.n ?? 10}            # 보험기간(년) — 전기납 월납`,
    `m = n             # 납입기간 = 보험기간`,
    `k = 12            # 월납`,
    `i = ${input("i_rate") ?? 0}        # 보장부분 확정이율 — 유지자·보험금 기수의 현가(위험보험료)`,
    `v = 1 / (1 + i)   # 현가율`,
    `S_won = ${input("S_won") ?? 0}   # 보장금액(원) — 위험보험료를 내는 보장`,
    `alpha = ${input("alpha") ?? 0}   # α 계약체결비용 (기본보험료 대비, 매월)`,
    `alpha_p = ${input("alphaPrime") ?? 0}   # α′ 계약체결비용 (그 뒤)`,
    `beta = ${input("beta") ?? 0}   # β 계약관리비용`,
    `results = {}      # 예시마다 해마다의 환급금(원)`,
    `compare = {}      # 앱 · 엑셀과 맞대어 볼 값`,
    `print(f"계약: {sex} {x}세 · 월 기본보험료 {G:,.0f}원 · {n}년 만기(전기납)")`,
  ].join("\n") }, { title: "위험률 표", module: "rates", code: [
    ...head(STEPS.rates.name, "rates"),
    `# 연령 → 연 발생률 (${sex === "F" ? "여" : "남"}자 표). 조건의 위험률 표(별첨)와 같다`,
    `rates = {`, ...tables, `}`,
    `print("위험률:", ", ".join(f"{k}({len(v)}행)" for k, v in rates.items()))`,
  ].join("\n") }];
  for (const s of sheets) {
    if (s.error) continue;
    const c: Ctx = { series: new Set(s.cols.map((x) => x.sym)), scalars: new Set(s.scalars.map((x) => x.sym)), known: new Set() };
    const { rates, steps } = sheetParts(s);
    const lines = (kind: string) => [...steps[kind].cols.flatMap((col) => [...seriesLines(col, c), ""]), ...steps[kind].scalars.flatMap((sc) => [...scalarLines(sc, c), ""])];
    const cell = (kind: string, body: string[]): PyCell => ({ title: `${s.name} — ${STEPS[kind].name}`, module: `${s.id}:${kind}`, code: [...head(`${STEPS[kind].name} — 예시: ${s.name}`, kind), ...body].join("\n") });
    cells.push(cell("risk", [
      `# ── ${s.name} — 공시이율 j^{공시} 만 바꿔 같은 식으로 ──`,
      `j_pub = ${s.inputs.find((x) => x.name === "j_pub")?.value ?? 0}   # 이 예시의 공시이율 (최저보증이율 예시는 0 — 최저보증이율만 적용된다)`,
      ...rates.map((r) => `${pyName(r.sym)} = [rates[${q(r.label)}].get(x + t, 0.0) for t in range(n + 1)]   # ${r.sym}: ${r.label}`),
      "",
      ...lines("risk"),
      `print(f"N*={Nstar:,.6f}  PVB={PVB:,.8f}  P={P:.10f}  위험보험료(월)={P_risk * G:,.0f}원")`,
    ]));
    cells.push(cell("parts", [...lines("parts"), `print(f"첫해 적립보험료(월) = {P_save[0] * G:,.0f}원 · 적용이율 = {j[0]:.4%}")`]));
    cells.push(cell("av", [...lines("av"), `print("t, 계약자적립액(원)")`, `for t in range(1, n + 1): print(t, round(AV[t] * G))`]));
    const cmp = SAVINGS_COMPARE.filter((sym) => s.scalars.some((x) => x.sym === sym));
    cells.push(cell("refund", [
      ...lines("refund"),
      `results[${q(s.id)}] = [round(W[t] * G) for t in range(n + 1)]`,
      `# 앱 · 엑셀과 맞대어 볼 값을 적어 둔다`,
      `compare.update({${[...cmp.map((sym) => `${q(`${s.id}.${sym}`)}: ${pyName(sym)}`), `${q(`${s.id}.만기환급금`)}: round(W[n] * G)`].join(", ")}})`,
      `print(${q(s.name)}, "— t, 납입누계, 계약자적립액, 환급금, 환급률")`,
      `for t in range(1, n + 1): print(t, round(paid[t] * G), round(AV[t] * G), round(W[t] * G), f"{refund_rate[t]:.1%}")`,
    ]));
  }
  cells.push({ title: "합계", module: "total", code: [
    ...head("예시별 만기환급금 — 엑셀과 견줄 값", "total"),
    `print("── 예시마다 만기환급금(원) ──")`,
    `for name, rows in results.items(): print(name, f"{rows[-1]:,.0f}원")`,
    `# 아래 두 줄은 기계가 읽는 줄이다 — 앱의 값 · 엑셀의 값과 맞대어 본다`,
    `print("RESULT", json.dumps(results, ensure_ascii=False))`,
    `print("COMPARE", json.dumps(compare, ensure_ascii=False))`,
  ].join("\n") });
  return cells;
}

/** 셀들을 한 파일로 — 내려받기·바깥 파이썬으로 돌리기 */
export const pythonScript = (cells: PyCell[]) => cells.map((c) => `# %% ${c.title}\n${c.code}`).join("\n\n\n") + "\n";
