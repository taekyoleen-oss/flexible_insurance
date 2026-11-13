import { calcSheets, sheetsByUnit, type CalcColumn, type CalcContract, type CalcSheet, type CalcSheets } from "./calc";
import { calcPython, COMPARE_SYMS, RES_SYMS, SAVINGS_COMPARE, sheetParts, STEPS, type PyCell } from "./calc-py";
import type { MethodSpec } from "./spec";

/**
 * 산출 흐름 — 보험료 산출을 **이어진 모듈**로 나눈다(통계 프로그램의 흐름도처럼).
 * 모듈 차례 = 산출방법서 절 차례: 산출방법서(조건) → 계약·기초율 → 위험률 표 → [보장마다] 조건 → 유지자 → 보험금 → 보장(PVB) · 납입기수(N*) → 보험료 → 준비금·환급금 → 합계.
 * 적립형은 [예시마다] 위험보험료 → 보험료의 구성 → 계약자적립액 → 환급금.
 *
 * **새 계산을 만들지 않는다** — 값은 calcSheets(식을 읽어 낸 표), 코드는 calcPython(같은 식을 옮긴 셀)에서 가져와 묶을 뿐이다.
 * 셀 하나가 모듈 하나라, 모듈의 코드를 차례로 이으면 내려받는 .py 와 같다.
 */
export interface FlowValue { sym: string; label: string; value: number | string; digits?: number; formula?: string }
export interface FlowModule {
  id: string;
  /** 단계 종류 — doc · basis · rates · cond · surv · ben · cover · pay · prem · res · total (적립형: risk · parts · av · refund) */
  kind: string;
  name: string;
  /** 무엇을 · 왜 / 받는 값 / 내는 값 / 산출방법서의 어느 절 */
  desc: string; takes: string; gives: string; section: string;
  /** 계약 단위(주계약 · 특약) · 보장(적립형은 예시) — 공통 모듈은 없다 */
  unit?: string; lane?: string; laneName?: string;
  /** 들어오는 모듈 */
  inputs: string[];
  /** 이 모듈의 식 — 산출방법서와 같은 평문 식 */
  formulas: string[];
  /** 파이썬 코드(그 셀) · 셀 차례(없으면 −1) */
  code: string; cell: number;
  /** 산출 값 — 한 해 한 줄의 열(ages 가 줄) · 한 값 */
  ages: number[]; cols: CalcColumn[]; values: FlowValue[];
  /** 상자에 보일 대표 값 */
  headline: string;
  status: "ok" | "warn" | "error";
  notes: string[];
}
/** 앱 · 파이썬 · 엑셀을 맞대어 볼 값 한 줄 — key 는 파이썬의 compare · 엑셀의 workbookResults 와 같은 열쇠 */
export interface FlowCompareRow { key: string; module: string; group: string; label: string; app: number; digits: number }
export interface CalcFlow { modules: FlowModule[]; links: [string, string][]; cells: PyCell[]; compare: FlowCompareRow[]; calc: CalcSheets; savings: boolean }

const DOC = { name: "산출방법서 (조건)", does: "산출방법서에서 읽은 조건이 계산의 출발점이다 — 상품 · 보장 · 위험률 · 이율 · 사업비와 식", takes: "불러온 산출방법서 · 조건 카드에서 고친 값", gives: "아래 모든 단계가 쓰는 조건과 식", doc: "산출방법서 전체" };
const CMP_LABEL: Record<string, [string, number]> = {
  "N*": ["N* 납입기수", 6], PVB: ["PVB 보험금의 현가", 8], P: ["P 순보험료 (1원당)", 10], "G₁": ["G₁ 1원당 영업보험료 (6자리)", 6], "G_10만": ["10만원당 보험료 (원)", 0],
  prem: ["보험료 (원)", 0], "P^{위험}": ["위험보험료 (기본보험료 1원당)", 10], 만기환급금: ["만기환급금 (원)", 0],
};
/** 그 값이 나오는 단계 */
const CMP_KIND: Record<string, string> = { "N*": "pay", PVB: "cover", P: "prem", "G₁": "prem", "G_10만": "prem", prem: "prem" };
const won = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}원`;
const short = (v: number, d: number) => v.toLocaleString("ko-KR", { maximumFractionDigits: d });

export function calcFlow(spec: MethodSpec, contract: CalcContract): CalcFlow {
  const calc = calcSheets(spec, contract);
  const cells = calcPython(spec, contract, calc);
  const savings = !!spec.savings;
  const modules: FlowModule[] = [], links: [string, string][] = [], compare: FlowCompareRow[] = [];
  const add = (id: string, kind: string, inputs: string[], x: Partial<FlowModule> = {}) => {
    const s = kind === "doc" ? DOC : STEPS[kind];
    const cell = cells.findIndex((c) => c.module === id);
    const cols = x.cols ?? [];
    modules.push({ id, kind, name: s.name, desc: s.does, takes: s.takes, gives: s.gives, section: s.doc, inputs, code: cell < 0 ? "" : cells[cell].code, cell,
      formulas: [...cols.filter((c) => c.kind !== "rate").map((c) => c.formula), ...(x.values ?? []).flatMap((v) => v.formula ? [v.formula] : [])],
      ages: [], cols, values: [], headline: "", status: "ok", notes: [], ...x });
    for (const from of inputs) links.push([from, id]);
  };
  const first = calc.sheets[0];
  const units = sheetsByUnit(calc);

  add("doc", "doc", [], { values: [
    { sym: "", label: "상품", value: spec.meta.productName || "(이름 없음)" },
    { sym: "", label: "계약 단위", value: units.map((u) => u.unit).join(" · ") || "—" },
    { sym: "", label: savings ? "보장" : "보장 (담보)", value: spec.benefits.map((b) => b.name).join(" · ") || "—" },
    { sym: "", label: "위험률", value: spec.rates.map((r) => r.name).join(" · ") || "—" },
  ], headline: spec.meta.productName || "" });
  add("basis", "basis", ["doc"], { values: (first?.inputs ?? []).filter((x) => !x.perBenefit).map((x) => ({ sym: "", label: x.label + (x.note ? ` (${x.note})` : ""), value: x.value, digits: x.digits })),
    headline: first ? `${contract.sex === "F" ? "여" : "남"} ${contract.age}세 · i ${short((first.inputs.find((x) => x.name === "i_rate")?.value as number ?? 0) * 100, 3)}%` : "" });
  add("rates", "rates", ["doc"], { values: spec.rates.map((r) => ({ sym: r.id, label: r.name, value: r.source ?? "" })), headline: `위험률 ${spec.rates.length}개`,
    ...(calc.missingRates.length ? { status: "warn" as const, notes: [`값 표가 없어 0 으로 둔 위험률: ${calc.missingRates.join(", ")} — [위험률 표] 창에서 열을 이으세요`] } : {}) });

  const scal = (xs: CalcSheet["scalars"]) => xs.map((x) => ({ sym: x.sym, label: x.label, value: x.value, digits: x.digits, formula: x.formula }));
  const ends: string[] = [];
  for (const s of calc.sheets) {
    const id = (kind: string) => `${s.id}:${kind}`;
    const lane = { unit: s.unit, lane: s.id, laneName: s.name, ages: s.ages };
    if (s.error) { add(id(savings ? "risk" : "cond"), savings ? "risk" : "cond", ["basis", "rates"], { ...lane, status: "error", notes: [`식으로 계산할 수 없습니다 — ${s.error}`], headline: "계산 못 함" }); continue; }
    const { rates, discount, steps } = sheetParts(s);
    // 경고("V: …")는 그 열이 속한 단계에 — 준비금·환급금의 열이면 그 상자(있을 때), 그 밖은 갈래의 첫 상자
    const warnOf = (ws: string[]) => (ws.length ? { status: "warn" as const, notes: [`식으로 세우지 못한 열 — ${ws.join(" · ")}`] } : {});
    const isRes = (w: string) => !savings && steps.res.cols.length > 0 && RES_SYMS.includes(w.split(":")[0]);
    const warn = warnOf(s.warnings.filter((w) => !isRes(w))), resWarn = warnOf(s.warnings.filter(isRes));
    const val = (sym: string, t = 0) => s.cols.find((c) => c.sym === sym)?.values[t];
    const sc = (sym: string) => s.scalars.find((x) => x.sym === sym)?.value;
    if (savings) {
      add(id("risk"), "risk", ["basis", "rates"], { ...lane, ...warn, cols: [...rates, ...discount, ...steps.risk.cols], values: [...s.inputs.filter((x) => x.perBenefit).map((x) => ({ sym: "", label: x.label, value: x.value, digits: x.digits })), ...scal(steps.risk.scalars)],
        headline: `위험보험료 월 ${won((sc("P^{위험}") ?? 0) * calc.premium)}` });
      add(id("parts"), "parts", [id("risk")], { ...lane, cols: steps.parts.cols, headline: `첫해 적립 ${won((val("P^{적립}") ?? 0) * calc.premium)}` });
      add(id("av"), "av", [id("parts")], { ...lane, cols: steps.av.cols, headline: `만기 적립액 ${won((val("AV", s.n) ?? 0) * calc.premium)}` });
      add(id("refund"), "refund", [id("av")], { ...lane, cols: steps.refund.cols, values: [{ sym: "", label: "만기환급금 (원)", value: s.maturity?.won ?? 0, digits: 0 }, { sym: "", label: "만기 환급률", value: `${((s.maturity?.ratio ?? 0) * 100).toFixed(1)}%` }],
        headline: `만기 ${won(s.maturity?.won ?? 0)} · ${((s.maturity?.ratio ?? 0) * 100).toFixed(1)}%` });
      ends.push(id("refund"));
      for (const sym of SAVINGS_COMPARE) if (sc(sym) !== undefined) compare.push({ key: `${s.id}.${sym}`, module: id("risk"), group: s.name, label: CMP_LABEL[sym][0], app: sc(sym)!, digits: CMP_LABEL[sym][1] });
      compare.push({ key: `${s.id}.만기환급금`, module: id("refund"), group: s.name, label: CMP_LABEL["만기환급금"][0], app: s.maturity?.won ?? 0, digits: 0 });
      continue;
    }
    // 보험료의 배수 보장 — 그 계약 단위 정액 보장의 보험료가 먼저 나와야 보장금액이 정해진다
    const before = s.base === "premium" ? calc.sheets.filter((o) => o.unit === s.unit && !o.base && !o.error).map((o) => `${o.id}:prem`) : [];
    add(id("cond"), "cond", ["basis", "rates", ...before], { ...lane, ...warn, cols: [...rates, ...discount], values: s.inputs.filter((x) => x.perBenefit).map((x) => ({ sym: "", label: x.label + (x.note ? ` (${x.note})` : ""), value: x.value, digits: x.digits })),
      headline: `${s.n}년 보장 · ${s.m}년납` });
    add(id("surv"), "surv", [id("cond")], { ...lane, cols: steps.surv.cols, values: [{ sym: "", label: "이 보장의 유지자", value: s.group }], headline: val("N") !== undefined ? `N ${short(val("N")!, 2)}` : s.group });
    add(id("ben"), "ben", [id("surv")], { ...lane, cols: steps.ben.cols, headline: val("M") !== undefined ? `M ${short(val("M")!, 4)}` : "" });
    add(id("cover"), "cover", [id("ben")], { ...lane, values: scal(steps.cover.scalars), headline: `PVB ${short(sc("PVB") ?? 0, 6)}` });
    add(id("pay"), "pay", [id("surv")], { ...lane, values: scal(steps.pay.scalars), headline: `N* ${short(sc("N*") ?? 0, 4)}` });
    add(id("prem"), "prem", [id("cover"), id("pay")], { ...lane, values: [...scal(steps.prem.scalars),
      { sym: "", label: "10만원당 보험료 (원)", value: s.per100k, digits: 0 },
      { sym: "", label: `이 보장의 보험료 (원) — 10만원당 × 보장금액 ${won(s.amount)} ÷ 10만, 10원 미만 버림`, value: s.premium, digits: 0 }],
      headline: `10만원당 ${s.per100k.toLocaleString("ko-KR")} · ${won(s.premium)}` });
    if (steps.res.cols.length) {
      const r = val("환급률", s.m);
      add(id("res"), "res", [id("prem")], { ...lane, ...resWarn, cols: steps.res.cols, values: scal(steps.res.scalars), headline: r !== undefined ? `${s.m}년 환급률 ${(r * 100).toFixed(1)}%` : "V · W" });
    }
    ends.push(id("prem"));
    for (const sym of COMPARE_SYMS) if (sc(sym) !== undefined) compare.push({ key: `${s.id}.${sym}`, module: id(CMP_KIND[sym]), group: s.name, label: CMP_LABEL[sym][0], app: sc(sym)!, digits: CMP_LABEL[sym][1] });
    compare.push({ key: `${s.id}.prem`, module: id("prem"), group: s.name, label: CMP_LABEL.prem[0], app: s.premium, digits: 0 });
  }
  add("total", "total", ends, savings
    ? { values: calc.sheets.map((s) => ({ sym: "", label: `${s.name} — 만기환급금 (원)`, value: s.maturity?.won ?? 0, digits: 0 })), headline: `월 ${won(calc.premium)} 납입` }
    : { values: [...units.map((u) => ({ sym: "", label: `${u.unit} 보험료 (원)`, value: u.premium, digits: 0 })), { sym: "", label: "합계 보험료 (원)", value: calc.premium, digits: 0 }], headline: `합계 ${won(calc.premium)}` });
  if (!savings) compare.push({ key: "합계.prem", module: "total", group: "합계", label: "보험료 합계 (원)", app: calc.premium, digits: 0 });
  return { modules, links, cells, compare, calc, savings };
}

/** 값이 같은가 — 엑셀·파이썬의 끝자리 오차(1e-9 배)까지는 같다고 본다 */
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));

export interface ComparedRow extends FlowCompareRow { py?: number; xl?: number; diff?: number; ok: boolean }
/**
 * 앱(식) · 파이썬 · 엑셀을 맞댄다. 파이썬·엑셀 값은 있는 것만 견준다(실행 전·올리기 전이면 빈 칸).
 * first = 처음 갈리는 줄(모듈 차례로) — 화면이 그 모듈을 짚는다
 */
export function compareFlow(rows: FlowCompareRow[], py?: Record<string, number>, xl?: Record<string, number>): { rows: ComparedRow[]; first?: ComparedRow } {
  const out = rows.map((r): ComparedRow => {
    const p = py?.[r.key], x = xl?.[r.key];
    const others = [p, x].filter((v): v is number => v !== undefined);
    const diff = others.length ? Math.max(...others.map((v) => Math.abs(v - r.app))) : undefined;
    return { ...r, py: p, xl: x, diff, ok: others.every((v) => same(v, r.app)) };
  });
  return { rows: out, first: out.find((r) => !r.ok) };
}

/** 파이썬 실행 결과(합계 셀의 출력)에서 맞대어 볼 값을 읽는다 — `COMPARE {…}` 줄 */
export function pythonCompare(out: string): Record<string, number> | undefined {
  const line = out.split("\n").find((l) => l.startsWith("COMPARE "));
  if (!line) return undefined;
  try { return JSON.parse(line.slice(8)) as Record<string, number>; } catch { return undefined; }
}
