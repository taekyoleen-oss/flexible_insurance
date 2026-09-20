import { BENEFIT_KINDS, computePlan, getAssumption, planTermYears, type BenefitKind, type Expenses, type PlanCoverage, type PlanCoverageResult, type PlanInput, type PlanPoint, type PlanResult, type PlanStep, type PlanTotals, type Sex } from "@/lib/engine";
import { clamp, pct, won } from "./format";
import {
  columnArray, defaultSheet, deathCols, firstError, MAX_AGE, newColId, presetColumn, rateCoverage, RATE_PRESETS,
  resolveSheet, setAgeRange, sumColumns, waiverCols, type RateColumn, type RateKind, type RateSheet, type ResolvedSheet,
} from "./plan-rates";
import { shiftRows } from "./sheet-formula";
import { COLUMN_RECIPES } from "./sheet-snippets";

export const PLAN_STORAGE_KEY = "fwl:plan:v3";
export const PAY_YEARS = [5, 10, 15, 20, 30] as const;
export const FREQS = [{ v: 12, label: "월납" }, { v: 4, label: "3개월납" }, { v: 2, label: "6개월납" }, { v: 1, label: "연납" }] as const;

export interface PlanCoverageState {
  id: string;
  label: string;
  kind: BenefitKind;
  amount: number;        // 보장금액(원). 일당형은 1일당
  endAge: number;        // 보장 종료 연령
  waitMonths: number;    // 면책기간(개월). 첫해 급부 배율 = 1 − waitMonths/12
  eventColId: string;    // 급부 열(그 탭 시트의 열 id). 생존형은 쓰지 않는다
  exitColIds: string[];  // 탈퇴 열들(합산)
  steps: PlanStep[];     // 연령 구간별 보장금액 배수(증액·감액). 비면 전 기간 1.0
  points: PlanPoint[];   // 생존형 지급 시점
}

/** 주계약에서 상속받되 특약이 다르게 둘 수 있는 조건 */
export interface TabConditions {
  termYears: number; payYears: number; freq: number;
  interest: number; standardInterest: number;
  waiver: boolean;
  low: { on: boolean; ratio: number; lapseRate: number };
  expenses: Expenses;
}
export const TAB_COND_LABEL: Record<keyof TabConditions, string> = {
  termYears: "보험기간", payYears: "납입기간", freq: "납입주기",
  interest: "예정이율", standardInterest: "표준이율", waiver: "납입면제", low: "저해지·무해지", expenses: "사업비",
};
export const TAB_COND_KEYS = Object.keys(TAB_COND_LABEL) as (keyof TabConditions)[];

/** 시트 한 장 = 주계약 또는 특약 하나 */
export interface PlanTab {
  id: string;
  name: string;
  sheet: RateSheet;
  coverages: PlanCoverageState[];
  /** 주계약과 다르게 둔 조건만 담는다. 없는 키는 주계약 값을 쓴다(= 상속) */
  overrides: Partial<TabConditions>;
}

export interface PlanState {
  version: 3;
  productName: string; memo: string;
  sex: Sex; age: number;            // 피보험자는 계약 단위라 탭이 나누지 않는다
  base: TabConditions;              // 주계약 조건 = 모든 탭의 기본값
  tabs: PlanTab[];                  // tabs[0] = 주계약
  active: string;
  open: string[];                   // 펼쳐 놓은 단계 id
  updatedAt: number;
}

const DEFAULT_EXPENSES = getAssumption("default-2026").expenses;
export const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// ── 탭 조건 상속 ─────────────────────────────────────────────────────────────
/** 그 탭에 실제로 적용되는 조건 (주계약 값 + 그 탭이 덮은 값) */
export function tabConditions(s: PlanState, tab: PlanTab): TabConditions {
  return { ...s.base, ...tab.overrides };
}
/** 주계약과 다르게 둔 조건 키 목록 */
export const overriddenKeys = (tab: PlanTab) => TAB_COND_KEYS.filter((k) => tab.overrides[k] !== undefined);
export const isMain = (s: PlanState, tab: PlanTab) => s.tabs[0]?.id === tab.id;
export const activeTab = (s: PlanState): PlanTab => s.tabs.find((t) => t.id === s.active) ?? s.tabs[0];

/** 특약 시트의 열이 주계약과 같은지 — 이름이 같으면 값을 비교한다 */
export type ColumnOrigin = "main-same" | "main-changed" | "own";
export function columnOrigin(main: PlanTab, tab: PlanTab, col: RateColumn): ColumnOrigin {
  if (main.id === tab.id) return "own";
  const m = main.sheet.columns.find((c) => c.name === col.name);
  if (!m) return "own";
  const same = m.kind === col.kind && m.waiver === col.waiver
    && main.sheet.ages.length === tab.sheet.ages.length
    && main.sheet.ages.every((a, i) => a === tab.sheet.ages[i])
    && m.cells.every((v, i) => v === col.cells[i]);
  return same ? "main-same" : "main-changed";
}
export const COLUMN_ORIGIN_LABEL: Record<ColumnOrigin, string> = {
  "main-same": "주계약과 같음", "main-changed": "주계약과 다름", own: "이 탭 전용",
};

// ── 담보 ────────────────────────────────────────────────────────────────────
/** 급부 유형과 급부 열에서 탈퇴 열을 정한다: 사망 열 전부 + (최초발생이면 그 열) */
export function autoExitCols(sheet: RateSheet, kind: BenefitKind, eventColId: string): string[] {
  const base = deathCols(sheet);
  const ev = sheet.columns.find((c) => c.id === eventColId);
  if (kind === "incidence" && ev && ev.kind === "incidence" && !base.includes(ev.id)) return [...base, ev.id];
  return base;
}
/** 급부 유형에 어울리는 열 — 사망형은 사망 열, 진단형은 최초발생 열, 일당형은 반복지급 열 */
export function suggestEventCol(sheet: RateSheet, kind: BenefitKind): string {
  const want: RateKind = kind === "death" ? "death" : kind === "daily" ? "recurring" : "incidence";
  return (sheet.columns.find((c) => c.kind === want) ?? sheet.columns[0])?.id ?? "";
}
export function newCoverage(sheet: RateSheet, kind: BenefitKind, over: Partial<PlanCoverageState> = {}): PlanCoverageState {
  const eventColId = over.eventColId ?? suggestEventCol(sheet, kind);
  return {
    id: newId(), label: "새 담보", kind, amount: 3e7, endAge: 80, waitMonths: 0,
    eventColId, exitColIds: autoExitCols(sheet, kind, eventColId), steps: [], points: [], ...over,
  };
}

/** 시트를 복사한다(열 id는 새로 만들어 탭끼리 섞이지 않게) */
export function cloneSheet(sheet: RateSheet): { sheet: RateSheet; idMap: Record<string, string> } {
  const idMap: Record<string, string> = {};
  const columns = sheet.columns.map((c) => { const id = newColId(); idMap[c.id] = id; return { ...c, id, cells: [...c.cells] }; });
  return { sheet: { ages: [...sheet.ages], columns }, idMap };
}

export function initialPlan(): PlanState {
  const sex: Sex = "M", age = 40;
  const sheet = defaultSheet(sex, age, 80);
  const inc = sheet.columns.find((c) => c.kind === "incidence")!;
  const main: PlanTab = {
    id: newId(), name: "주계약", sheet, overrides: {},
    coverages: [newCoverage(sheet, "incidence", { label: "2대질병 진단", amount: 3e7, endAge: 80, eventColId: inc.id })],
  };
  return {
    version: 3, productName: "2대질병 진단보험", memo: "", sex, age,
    base: {
      termYears: 0, payYears: 20, freq: 12, interest: 0.025, standardInterest: 0.0325,
      waiver: true, low: { on: false, ratio: 0.7, lapseRate: 0.03 }, expenses: DEFAULT_EXPENSES,
    },
    tabs: [main], active: main.id, open: ["contract"], updatedAt: 0,
  };
}

// ── 산출 ────────────────────────────────────────────────────────────────────
export const waitFactorOf = (months: number) => clamp(1 - months / 12, 0, 1);

export function tabPlanInput(s: PlanState, tab: PlanTab, r: ResolvedSheet): { input: PlanInput; coverages: PlanCoverage[] } {
  const c0 = tabConditions(s, tab);
  const coverages: PlanCoverage[] = tab.coverages.map((c) => ({
    id: c.id, label: c.label, kind: c.kind, amount: c.amount, endAge: c.endAge,
    event: c.kind === "survival" ? [] : columnArray(tab.sheet, r, c.eventColId),
    exit: sumColumns(tab.sheet, r, c.exitColIds),
    waitFactor: waitFactorOf(c.waitMonths),
    steps: c.steps, points: c.points,
  }));
  const input: PlanInput = {
    age: s.age, termYears: c0.termYears > 0 ? c0.termYears : planTermYears(s.age, coverages),
    payYears: c0.payYears, freq: c0.freq,
    interest: c0.interest, standardInterest: c0.standardInterest,
    waiverRate: c0.waiver ? sumColumns(tab.sheet, r, waiverCols(tab.sheet)) : [],
    expenses: c0.expenses,
    lowSurrender: c0.low.on ? { ratio: c0.low.ratio, lapseRate: c0.low.lapseRate } : undefined,
  };
  return { input, coverages };
}

export interface TabResult { tab: PlanTab; sheet: ResolvedSheet; result: PlanResult }
export interface ProductResult {
  n: number; payYears: number; freq: number;
  tabs: TabResult[];
  coverages: (PlanCoverageResult & { tabId: string; tabName: string })[];
  benefit: number[]; survival: number[];
  standard: PlanTotals; effective: PlanTotals;
  low?: PlanTotals & { premiumDiscount: number; pvCsv: number };
  anyLow: boolean;
}

const pad = (a: number[], len: number) => Array.from({ length: len }, (_, i) => a[i] ?? 0);
const addInto = (dst: number[], src: number[]) => { for (let i = 0; i < dst.length; i++) dst[i] += src[i] ?? 0; return dst; };

function mergeTotals(parts: PlanTotals[], N: number): PlanTotals {
  const z = () => new Array<number>(N + 1).fill(0);
  const out: PlanTotals = {
    monthlyNet: 0, monthlyGross: 0, totalPaid: 0,
    reserve: z(), reserveStd: z(), deduction: z(), cash: z(), paid: z(), rate: z(),
  };
  for (const p of parts) {
    out.monthlyNet += p.monthlyNet; out.monthlyGross += p.monthlyGross; out.totalPaid += p.totalPaid;
    addInto(out.reserve, pad(p.reserve, N + 1)); addInto(out.reserveStd, pad(p.reserveStd, N + 1));
    addInto(out.deduction, pad(p.deduction, N + 1)); addInto(out.cash, pad(p.cash, N + 1));
    addInto(out.paid, pad(p.paid, N + 1));
  }
  out.rate = out.cash.map((c, t) => (out.paid[t] > 0 ? c / out.paid[t] : 0));
  return out;
}

/** 탭마다 따로 산출하고 합친다 — 탭별로 이율·기간·사업비가 다를 수 있기 때문 */
export function evaluateProduct(s: PlanState): ProductResult {
  const tabs: TabResult[] = s.tabs.map((tab) => {
    const sheet = resolveSheet(tab.sheet);
    const { input, coverages } = tabPlanInput(s, tab, sheet);
    return { tab, sheet, result: computePlan(input, coverages) };
  });
  const N = Math.max(1, ...tabs.map((t) => t.result.n));
  const benefit = new Array<number>(N).fill(0), survival = new Array<number>(N + 1).fill(0);
  const coverages: ProductResult["coverages"] = [];
  for (const t of tabs) {
    addInto(benefit, pad(t.result.benefit, N));
    addInto(survival, pad(t.result.survival, N + 1));
    for (const c of t.result.coverages) coverages.push({ ...c, tabId: t.tab.id, tabName: t.tab.name });
  }
  const standard = mergeTotals(tabs.map((t) => t.result.standard), N);
  const anyLow = tabs.some((t) => t.result.low);
  const effective = anyLow ? mergeTotals(tabs.map((t) => t.result.effective), N) : standard;
  const out: ProductResult = {
    n: N, payYears: Math.max(...tabs.map((t) => t.result.payYears)), freq: s.base.freq,
    tabs, coverages, benefit, survival, standard, effective, anyLow,
  };
  if (anyLow) out.low = {
    ...effective,
    premiumDiscount: standard.monthlyGross > 0 ? (standard.monthlyGross - effective.monthlyGross) / standard.monthlyGross : 0,
    pvCsv: tabs.reduce((a, t) => a + (t.result.low?.pvCsv ?? 0), 0),
  };
  return out;
}

export const kindMeta = (k: BenefitKind) => BENEFIT_KINDS.find((x) => x.kind === k) ?? BENEFIT_KINDS[0];

// ── 단계(모듈) ───────────────────────────────────────────────────────────────
export type StepStatus = "idle" | "editing" | "done" | "error";
export interface PlanStepCard { id: string; code: string; title: string; status: StepStatus; summary: string[]; message?: string; help: string; coverageId?: string; overridden?: boolean }

/** 지금 보고 있는 탭 기준 단계 카드 */
export function planSteps(s: PlanState, p: ProductResult): PlanStepCard[] {
  const tab = activeTab(s);
  const tr = p.tabs.find((t) => t.tab.id === tab.id)!;
  const r = tr.result, sheet = tr.sheet;
  const c0 = tabConditions(s, tab);
  const main = s.tabs[0];
  const err = firstError(tab.sheet, sheet);
  const waiverIds = waiverCols(tab.sheet);
  const ov = (k: keyof TabConditions) => tab.overrides[k] !== undefined;
  const changed = tab.sheet.columns.filter((c) => columnOrigin(main, tab, c) === "main-changed").length;
  const out: PlanStepCard[] = [
    { id: "product", code: "M01", title: "상품 기본정보",
      status: s.productName.trim() ? "done" : "editing",
      summary: [s.productName || "이름 없음", `${s.tabs.length}개 탭`, ...(s.memo ? [s.memo.slice(0, 20)] : [])],
      help: "상품 이름과 메모입니다. 시트 탭은 주계약 1장 + 특약 여러 장으로 두고, 특약은 주계약 조건을 기본값으로 물려받습니다." },
    { id: "contract", code: "M02", title: "계약조건", status: "done",
      overridden: ov("termYears") || ov("payYears") || ov("freq"),
      summary: [`${s.age}세 ${s.sex === "M" ? "남" : "여"}`, `${r.n}년 만기 / ${r.payYears}년납`, FREQS.find((f) => f.v === c0.freq)?.label ?? ""],
      help: "피보험자는 계약 단위라 탭이 나누지 않습니다. 보험기간·납입기간·납입주기는 탭마다 다르게 둘 수 있고, 주계약과 다르면 표시됩니다." },
    { id: "basis", code: "M03", title: "이자율·저해지", status: c0.interest > 0 ? "done" : "error",
      overridden: ov("interest") || ov("standardInterest") || ov("low"),
      summary: [`i = ${pct(c0.interest, 2)}`, `표준 ${pct(c0.standardInterest, 2)}`, ...(c0.low.on ? [`${c0.low.ratio === 0 ? "무해지" : `저해지 ${Math.round(c0.low.ratio * 100)}%`} · 해지율 ${pct(c0.low.lapseRate)}`] : [])],
      help: "예정이율은 보험료·책임준비금에, 표준이율은 표준책임준비금과 해약공제 기준 신계약비에 씁니다. 저해지·무해지형은 적용해지율을 넣어 다시 산출합니다." },
    { id: "rates", code: "M04", title: "위험률 열", status: err ? "error" : tab.sheet.columns.length ? "done" : "editing",
      summary: [...tab.sheet.columns.map((c) => c.name), ...(changed ? [`주계약과 다름 ${changed}개`] : [])],
      message: err ? `${err.cell} 칸: ${err.code}` : undefined,
      help: "이 탭 시트의 열마다 이름·유형(사망·최초발생·반복지급·기타)·납입면제 포함 여부를 정합니다. 특약 탭에서는 주계약과 같은 이름의 열이 값까지 같은지도 표시합니다." },
    { id: "waiver", code: "M05", title: "납입면제", status: c0.waiver && waiverIds.length === 0 ? "error" : "done",
      overridden: ov("waiver"),
      summary: c0.waiver ? (waiverIds.length ? tab.sheet.columns.filter((c) => c.waiver).map((c) => c.name) : ["열 없음"]) : ["미적용"],
      message: c0.waiver && waiverIds.length === 0 ? "납입면제를 켰지만 이 탭에 납입면제 열이 없습니다. M04에서 열을 지정하세요." : undefined,
      help: "납입면제로 표시한 열의 합이 납입자 집단 l′의 탈퇴율 f가 됩니다. 기존 장해율을 불러오거나, 다른 열에서 수식으로 만들거나, Excel에서 붙여넣어 쓸 수 있습니다." },
  ];
  tab.coverages.forEach((c, i) => {
    const row = r.coverages.find((x) => x.id === c.id);
    const cover = rateCoverage(tab.sheet, s.age, Math.min(c.endAge, s.age + r.n - 1));
    const noEvent = c.kind !== "survival" && !tab.sheet.columns.some((x) => x.id === c.eventColId);
    const noPoint = c.kind === "survival" && c.points.length === 0;
    out.push({
      id: `cov:${c.id}`, coverageId: c.id, code: `C${String(i + 1).padStart(2, "0")}`, title: c.label || "담보",
      status: noEvent || noPoint ? "error" : c.amount > 0 ? "done" : "editing",
      summary: [kindMeta(c.kind).label, `${won(c.amount)}${c.kind === "daily" ? "/일" : ""}`, `~${c.endAge}세`, ...(row ? [won(row.monthlyGross)] : [])],
      message: noEvent ? "급부 열이 지정되지 않았습니다." : noPoint ? "생존형인데 지급 시점이 없습니다." : !cover.ok ? `위험률 표가 ${cover.min}~${cover.max}세만 덮습니다 — 밖의 나이는 가장 가까운 값을 씁니다.` : undefined,
      help: "담보 하나를 독립된 소형 상품으로 산출합니다. 급부 열·탈퇴 열·보장금액·만기·면책·증액감액 구간을 정합니다.",
    });
  });
  out.push(
    { id: "expense", code: "M06", title: "사업비", status: "done", overridden: ov("expenses"),
      summary: [c0.expenses.model === "method" ? "산출방법서형" : "3이원 단순형"],
      help: "산출방법서형은 α_S·α_P·β_S·β_G·β′·γ 6개를, 3이원 단순형은 α·β·γ 3개를 씁니다. 보장기간이 20년보다 짧으면 α_P는 n/20배로 줄입니다." },
    { id: "result", code: "M07", title: "산출 결과", status: p.effective.monthlyGross > 0 ? "done" : "error",
      summary: [`이 탭 ${won(r.effective.monthlyGross)}`, `전체 ${won(p.effective.monthlyGross)}`, `환급률 ${pct(p.effective.rate[p.payYears] ?? 0)}`],
      message: p.effective.monthlyGross > 0 ? undefined : "보험료가 0입니다 — 위험률 열과 보장금액을 확인하세요.",
      help: "탭마다 따로 산출해 합칩니다. 아래 그래프와 표에는 전체 합계가 나옵니다." },
  );
  return out;
}

// ── 저장·복원 ───────────────────────────────────────────────────────────────
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string, max = 60) => (typeof v === "string" && v.trim() ? v.slice(0, max) : d);
const RATE_KIND_SET = new Set(["death", "incidence", "recurring", "other"]);

function sanitizeExpenses(raw: unknown, d: Expenses): Expenses {
  const e = (raw ?? {}) as Record<string, unknown>;
  if (e.model === "simple") return { model: "simple", alpha: n(e.alpha, 0.007), beta: n(e.beta, 0.0015), gamma: n(e.gamma, 0.02) };
  if (e.model === "method") return { model: "method", alphaS: n(e.alphaS, 0.01), alphaP: n(e.alphaP, 1), betaS: n(e.betaS, 0.0015), betaG: n(e.betaG, 0.045), betaPrime: n(e.betaPrime, 0.001), gamma: n(e.gamma, 0.025) };
  return d;
}

function sanitizeConditions(raw: unknown, d: TabConditions): TabConditions {
  const c = (raw ?? {}) as Partial<TabConditions>;
  const low = (c.low ?? {}) as Partial<TabConditions["low"]>;
  return {
    termYears: clamp(Math.round(n(c.termYears, d.termYears)), 0, MAX_AGE),
    payYears: clamp(Math.round(n(c.payYears, d.payYears)), 1, 60),
    freq: FREQS.some((f) => f.v === c.freq) ? (c.freq as number) : d.freq,
    interest: clamp(n(c.interest, d.interest), 0, 0.2),
    standardInterest: clamp(n(c.standardInterest, d.standardInterest), 0, 0.2),
    waiver: typeof c.waiver === "boolean" ? c.waiver : d.waiver,
    low: { on: low.on === true, ratio: clamp(n(low.ratio, 0.7), 0, 1), lapseRate: clamp(n(low.lapseRate, 0.03), 0, 0.5) },
    expenses: sanitizeExpenses(c.expenses, d.expenses),
  };
}

function sanitizeSheet(raw: unknown, sex: Sex, age: number): RateSheet {
  const s = (raw ?? {}) as Partial<RateSheet>;
  const ages = (Array.isArray(s.ages) ? s.ages : []).map((a) => clamp(Math.round(n(a, 0)), 0, MAX_AGE));
  if (ages.length === 0) return defaultSheet(sex, age, Math.min(MAX_AGE, age + 40));
  const columns = (Array.isArray(s.columns) ? s.columns : []).slice(0, 20).map((c): RateColumn => {
    const col = (c ?? {}) as Partial<RateColumn>;
    return {
      id: typeof col.id === "string" && col.id ? col.id : newColId(),
      name: str(col.name, "위험률", 40),
      kind: RATE_KIND_SET.has(col.kind as string) ? (col.kind as RateKind) : "other",
      waiver: col.waiver === true,
      cells: ages.map((_, i) => String((Array.isArray(col.cells) ? col.cells[i] : undefined) ?? "0")),
    };
  });
  return { ages, columns: columns.length ? columns : defaultSheet(sex, age, ages[ages.length - 1]).columns };
}

function sanitizeCoverage(raw: unknown, sheet: RateSheet, age: number): PlanCoverageState {
  const c = (raw ?? {}) as Partial<PlanCoverageState>;
  const kind = BENEFIT_KINDS.some((k) => k.kind === c.kind) ? (c.kind as BenefitKind) : "incidence";
  const endAge = clamp(Math.round(n(c.endAge, 80)), age, MAX_AGE);
  const ids = new Set(sheet.columns.map((x) => x.id));
  const eventColId = typeof c.eventColId === "string" && ids.has(c.eventColId) ? c.eventColId : suggestEventCol(sheet, kind);
  const exit = (Array.isArray(c.exitColIds) ? c.exitColIds : []).filter((x) => typeof x === "string" && ids.has(x));
  return {
    id: str(c.id, newId(), 40), label: str(c.label, "담보", 40), kind,
    amount: clamp(n(c.amount, 3e7), 0, 1e11), endAge,
    waitMonths: clamp(Math.round(n(c.waitMonths, 0)), 0, 24),
    eventColId, exitColIds: exit.length ? exit : autoExitCols(sheet, kind, eventColId),
    steps: (Array.isArray(c.steps) ? c.steps : []).map((x) => ({
      fromAge: clamp(Math.round(n(x?.fromAge, age)), 0, MAX_AGE),
      toAge: clamp(Math.round(n(x?.toAge, endAge)), 0, MAX_AGE),
      multiple: clamp(n(x?.multiple, 1), 0, 100),
    })),
    points: (Array.isArray(c.points) ? c.points : []).map((x) => ({
      age: clamp(Math.round(n(x?.age, endAge)), 0, MAX_AGE), multiple: clamp(n(x?.multiple, 1), 0, 100),
    })),
  };
}

/** 저장·공유에서 온 값을 믿지 않는다. 숫자가 아니면 기본값 */
export function sanitizePlan(raw: unknown): PlanState {
  const r = (raw ?? {}) as Partial<PlanState> & { sheet?: unknown; coverages?: unknown; interest?: number };
  const def = initialPlan();
  const sex: Sex = r.sex === "F" ? "F" : "M";
  const age = clamp(Math.round(n(r.age, def.age)), 0, 90);
  // v2(탭 없음) 저장본도 주계약 한 장으로 읽어 들인다
  const base = sanitizeConditions(r.base ?? r, def.base);
  const rawTabs = Array.isArray(r.tabs) && r.tabs.length ? r.tabs : [{ name: "주계약", sheet: r.sheet, coverages: r.coverages, overrides: {} }];
  const tabs: PlanTab[] = rawTabs.slice(0, 10).map((t, i) => {
    const tt = (t ?? {}) as Partial<PlanTab>;
    const sheet = sanitizeSheet(tt.sheet, sex, age);
    const covs = (Array.isArray(tt.coverages) && tt.coverages.length ? tt.coverages : [newCoverage(sheet, "incidence")]).map((c) => sanitizeCoverage(c, sheet, age)).slice(0, 12);
    const ovRaw = (tt.overrides ?? {}) as Partial<TabConditions>;
    const overrides: Partial<TabConditions> = {};
    if (i > 0) {
      const full = sanitizeConditions({ ...base, ...ovRaw }, base);
      for (const k of TAB_COND_KEYS) if (ovRaw[k] !== undefined) (overrides as Record<string, unknown>)[k] = full[k];
    }
    return { id: str(tt.id, newId(), 40), name: str(tt.name, i === 0 ? "주계약" : `특약${i}`, 30), sheet, coverages: covs, overrides };
  });
  return {
    version: 3,
    productName: str(r.productName, def.productName, 60), memo: str(r.memo, "", 200),
    sex, age, base, tabs,
    active: tabs.some((t) => t.id === r.active) ? (r.active as string) : tabs[0].id,
    open: Array.isArray(r.open) ? r.open.filter((x) => typeof x === "string").slice(0, 20) : def.open,
    updatedAt: n(r.updatedAt, 0),
  };
}

// ── reducer ─────────────────────────────────────────────────────────────────
export type BasePatch = Partial<Pick<PlanState, "productName" | "memo" | "sex" | "age">>;
export type CoveragePatch = Partial<Omit<PlanCoverageState, "id">>;

export type PlanAction =
  | { type: "product"; patch: BasePatch }
  /** 지금 탭의 조건을 바꾼다. 주계약이면 base가, 특약이면 overrides가 바뀐다 */
  | { type: "conditions"; patch: Partial<TabConditions> }
  | { type: "resetOverride"; key: keyof TabConditions }
  | { type: "expenses"; patch: Partial<Record<string, number>> }
  | { type: "expenseModel"; model: Expenses["model"] }
  | { type: "toggleStep"; id: string }
  // 탭
  | { type: "addTab" }
  | { type: "removeTab"; id: string }
  | { type: "renameTab"; id: string; name: string }
  | { type: "selectTab"; id: string }
  | { type: "moveTab"; id: string; dir: -1 | 1 }
  | { type: "copyMainSheet" }
  // 담보(지금 탭)
  | { type: "addCoverage"; kind: BenefitKind }
  | { type: "removeCoverage"; id: string }
  | { type: "moveCoverage"; id: string; dir: -1 | 1 }
  | { type: "coverage"; id: string; patch: CoveragePatch }
  // 시트(지금 탭)
  | { type: "cell"; colId: string; row: number; value: string }
  | { type: "fillDown"; colId: string; row: number }
  | { type: "column"; colId: string; patch: Partial<Omit<RateColumn, "id" | "cells">> }
  | { type: "addColumn"; presetId: string }
  | { type: "addRecipeColumn"; recipeId: string }
  | { type: "removeColumn"; colId: string }
  | { type: "ageRange"; from: number; to: number }
  | { type: "pasteTable"; ages: number[]; columns: { name: string; cells: string[] }[] }
  | { type: "load"; state: unknown }
  | { type: "reset" };

const touch = (s: PlanState, patch: Partial<PlanState>): PlanState => ({ ...s, ...patch, updatedAt: Date.now() });
/** 지금 탭만 바꾼다 */
const mapTab = (s: PlanState, f: (t: PlanTab) => PlanTab): PlanState =>
  touch(s, { tabs: s.tabs.map((t) => (t.id === activeTab(s).id ? f(t) : t)) });
const mapSheet = (s: PlanState, f: (sh: RateSheet) => RateSheet): PlanState => mapTab(s, (t) => ({ ...t, sheet: f(t.sheet) }));
const mapCol = (sh: RateSheet, colId: string, f: (c: RateColumn) => RateColumn): RateSheet =>
  ({ ...sh, columns: sh.columns.map((c) => (c.id === colId ? f(c) : c)) });

export function planReducer(s: PlanState, a: PlanAction): PlanState {
  const tab = activeTab(s);
  const main = s.tabs[0];
  switch (a.type) {
    case "product": {
      const age = a.patch.age ?? s.age;
      const tabs = age !== s.age
        ? s.tabs.map((t) => ({ ...t, coverages: t.coverages.map((c) => ({ ...c, endAge: Math.max(c.endAge, age) })) }))
        : s.tabs;
      return touch(s, { ...a.patch, tabs });
    }
    case "conditions": {
      if (tab.id === main.id) return touch(s, { base: { ...s.base, ...a.patch } });
      return mapTab(s, (t) => ({ ...t, overrides: { ...t.overrides, ...a.patch } }));
    }
    case "resetOverride": {
      if (tab.id === main.id) return s;
      return mapTab(s, (t) => { const o = { ...t.overrides }; delete o[a.key]; return { ...t, overrides: o }; });
    }
    case "expenses": {
      const cur = tabConditions(s, tab).expenses;
      return planReducer(s, { type: "conditions", patch: { expenses: { ...cur, ...a.patch } as Expenses } });
    }
    case "expenseModel":
      return planReducer(s, { type: "conditions", patch: { expenses: a.model === "simple"
        ? { model: "simple", alpha: 0.007, beta: 0.0015, gamma: 0.02 }
        : { model: "method", alphaS: 0.01, alphaP: 1, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 } } });
    case "toggleStep":
      return { ...s, open: s.open.includes(a.id) ? s.open.filter((x) => x !== a.id) : [...s.open, a.id] };

    case "addTab": {
      if (s.tabs.length >= 10) return s;
      // 주계약 시트를 복사해 시작한다 — 사망률·납입면제율 같은 공통 열을 다시 넣지 않아도 되게
      const { sheet, idMap } = cloneSheet(main.sheet);
      const cov = newCoverage(sheet, "incidence", { label: "새 담보", endAge: Math.max(s.age, 80) });
      void idMap;
      const t: PlanTab = { id: newId(), name: `특약${s.tabs.length}`, sheet, coverages: [cov], overrides: {} };
      return touch(s, { tabs: [...s.tabs, t], active: t.id });
    }
    case "removeTab": {
      if (s.tabs.length <= 1 || a.id === main.id) return s;    // 주계약은 지울 수 없다
      const tabs = s.tabs.filter((t) => t.id !== a.id);
      return touch(s, { tabs, active: tabs.some((t) => t.id === s.active) ? s.active : tabs[0].id });
    }
    case "renameTab":
      return touch(s, { tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, name: a.name.slice(0, 30) || t.name } : t)) });
    case "selectTab": return { ...s, active: s.tabs.some((t) => t.id === a.id) ? a.id : s.active };
    case "moveTab": {
      const i = s.tabs.findIndex((t) => t.id === a.id), j = i + a.dir;
      if (i <= 0 || j <= 0 || j >= s.tabs.length) return s;    // 주계약은 첫 자리 고정
      const tabs = [...s.tabs];
      [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
      return touch(s, { tabs });
    }
    case "copyMainSheet": {
      if (tab.id === main.id) return s;
      const { sheet } = cloneSheet(main.sheet);
      return mapTab(s, (t) => ({
        ...t, sheet,
        coverages: t.coverages.map((c) => {
          const ev = suggestEventCol(sheet, c.kind);
          return { ...c, eventColId: ev, exitColIds: autoExitCols(sheet, c.kind, ev) };
        }),
      }));
    }

    case "addCoverage": {
      if (tab.coverages.length >= 12) return s;
      const c = newCoverage(tab.sheet, a.kind, { label: `담보 ${tab.coverages.length + 1}`, endAge: Math.max(s.age, 80) });
      return touch(mapTab(s, (t) => ({ ...t, coverages: [...t.coverages, c] })), { open: [...s.open, `cov:${c.id}`] });
    }
    case "removeCoverage":
      return tab.coverages.length <= 1 ? s : mapTab(s, (t) => ({ ...t, coverages: t.coverages.filter((c) => c.id !== a.id) }));
    case "moveCoverage": {
      const i = tab.coverages.findIndex((c) => c.id === a.id), j = i + a.dir;
      if (i < 0 || j < 0 || j >= tab.coverages.length) return s;
      return mapTab(s, (t) => { const next = [...t.coverages]; [next[i], next[j]] = [next[j], next[i]]; return { ...t, coverages: next }; });
    }
    case "coverage":
      return mapTab(s, (t) => ({ ...t, coverages: t.coverages.map((c) => {
        if (c.id !== a.id) return c;
        const merged = { ...c, ...a.patch };
        if ((a.patch.kind || a.patch.eventColId) && !a.patch.exitColIds) {
          const ev = a.patch.kind && !a.patch.eventColId ? suggestEventCol(t.sheet, merged.kind) : merged.eventColId;
          return { ...merged, eventColId: ev, exitColIds: autoExitCols(t.sheet, merged.kind, ev) };
        }
        return merged;
      }) }));

    case "cell":
      return mapSheet(s, (sh) => mapCol(sh, a.colId, (c) => ({ ...c, cells: c.cells.map((v, i) => (i === a.row ? a.value : v)) })));
    case "fillDown":
      return mapSheet(s, (sh) => mapCol(sh, a.colId, (c) => ({
        ...c, cells: c.cells.map((v, i) => (i <= a.row ? v : shiftRows(c.cells[a.row] ?? "", i - a.row))),
      })));
    case "column": return mapSheet(s, (sh) => mapCol(sh, a.colId, (c) => ({ ...c, ...a.patch })));
    case "addColumn": {
      if (tab.sheet.columns.length >= 20) return s;
      const p = RATE_PRESETS.find((x) => x.id === a.presetId) ?? RATE_PRESETS[RATE_PRESETS.length - 1];
      return mapSheet(s, (sh) => ({ ...sh, columns: [...sh.columns, presetColumn(p, s.sex, sh.ages)] }));
    }
    case "addRecipeColumn": {
      if (tab.sheet.columns.length >= 20) return s;
      const rec = COLUMN_RECIPES.find((x) => x.id === a.recipeId);
      if (!rec) return s;
      return mapSheet(s, (sh) => ({ ...sh, columns: [...sh.columns, {
        id: newColId(), name: rec.label, kind: rec.kind, waiver: rec.waiver,
        cells: sh.ages.map((_, row) => rec.cell({ sheet: sh, row, ages: sh.ages })),
      }] }));
    }
    case "removeColumn": {
      if (tab.sheet.columns.length <= 1) return s;
      return mapTab(s, (t) => {
        const sheet = { ...t.sheet, columns: t.sheet.columns.filter((c) => c.id !== a.colId) };
        return { ...t, sheet, coverages: t.coverages.map((c) => ({
          ...c,
          eventColId: c.eventColId === a.colId ? suggestEventCol(sheet, c.kind) : c.eventColId,
          exitColIds: c.exitColIds.filter((x) => x !== a.colId),
        })) };
      });
    }
    case "ageRange": return mapSheet(s, (sh) => setAgeRange(sh, a.from, a.to));
    case "pasteTable": {
      return mapSheet(s, (sh) => {
        const base = setAgeRange(sh, a.ages[0], a.ages[a.ages.length - 1]);
        const index = new Map(a.ages.map((x, i) => [x, i]));
        const cellsFor = (src: string[]) => base.ages.map((age) => { const i = index.get(age); return i === undefined ? "0" : src[i] ?? "0"; });
        const columns = [...base.columns];
        for (const col of a.columns) {
          const at = columns.findIndex((c) => c.name === col.name);
          if (at >= 0) columns[at] = { ...columns[at], cells: cellsFor(col.cells) };
          else if (columns.length < 20) columns.push({ id: newColId(), name: col.name, kind: "other", waiver: false, cells: cellsFor(col.cells) });
        }
        return { ...base, columns };
      });
    }
    case "load": return sanitizePlan(a.state);
    case "reset": return initialPlan();
    default: return s;
  }
}

// ── 레시피 ──────────────────────────────────────────────────────────────────
export interface PlanRecipe { id: string; label: string; need: string; build: (sex: Sex, age: number) => PlanState }

function recipe(sex: Sex, age: number, opts: {
  name: string; presets: string[]; endAge: number;
  covers: (sheet: RateSheet) => PlanCoverageState[];
  conditions?: Partial<TabConditions>;
  riders?: { name: string; presets: string[]; endAge: number; covers: (sheet: RateSheet) => PlanCoverageState[]; overrides?: Partial<TabConditions> }[];
}): PlanState {
  const def = initialPlan();
  const makeSheet = (presets: string[], endAge: number): RateSheet => {
    const ages = Array.from({ length: Math.max(1, endAge - age + 1) }, (_, i) => age + i);
    return { ages, columns: presets.map((id) => presetColumn(RATE_PRESETS.find((p) => p.id === id)!, sex, ages)) };
  };
  const mainSheet = makeSheet(opts.presets, opts.endAge);
  const tabs: PlanTab[] = [{ id: newId(), name: "주계약", sheet: mainSheet, coverages: opts.covers(mainSheet), overrides: {} }];
  for (const r of opts.riders ?? []) {
    const sh = makeSheet(r.presets, r.endAge);
    tabs.push({ id: newId(), name: r.name, sheet: sh, coverages: r.covers(sh), overrides: r.overrides ?? {} });
  }
  return { ...def, productName: opts.name, sex, age, base: { ...def.base, ...opts.conditions }, tabs, active: tabs[0].id, open: ["contract"] };
}

const col = (sheet: RateSheet, kind: RateKind, skip = 0) => sheet.columns.filter((c) => c.kind === kind)[skip]?.id ?? sheet.columns[0].id;

export const PLAN_RECIPES: PlanRecipe[] = [
  { id: "twoMajor", label: "2대질병 진단 (80세 만기)", need: "2대질병 발생률 + 사망률 + 납입면제율",
    build: (sex, age) => recipe(sex, age, { name: "2대질병 진단보험", presets: ["kli7", "waiver", "twoMajor"], endAge: 80,
      covers: (sh) => [newCoverage(sh, "incidence", { label: "2대질병 진단", amount: 3e7, endAge: 80, eventColId: col(sh, "incidence") })] }) },
  { id: "term", label: "정기 사망 (60세 만기)", need: "사망률 + 납입면제율",
    build: (sex, age) => recipe(sex, age, { name: "정기보험", presets: ["kli7", "waiver"], endAge: 60,
      covers: (sh) => [newCoverage(sh, "death", { label: "사망", amount: 1e8, endAge: 60, eventColId: col(sh, "death") })] }) },
  { id: "whole", label: "종신 사망 (110세)", need: "사망률 + 납입면제율",
    build: (sex, age) => recipe(sex, age, { name: "종신보험", presets: ["kli7", "waiver"], endAge: 110,
      covers: (sh) => [newCoverage(sh, "death", { label: "사망", amount: 1e8, endAge: 110, eventColId: col(sh, "death") })] }) },
  { id: "decreasing", label: "체감형 정기 (60세부터 절반)", need: "사망률 + 연령 구간 배수",
    build: (sex, age) => recipe(sex, age, { name: "체감형 정기보험", presets: ["kli7", "waiver"], endAge: 80,
      covers: (sh) => [newCoverage(sh, "death", { label: "사망(체감)", amount: 1e8, endAge: 80, eventColId: col(sh, "death"),
        steps: [{ fromAge: age, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: 80, multiple: 0.5 }] })] }) },
  { id: "cancerSet", label: "암 진단(주계약) + 암입원 특약", need: "암발생률 + 암입원 기대일수 + 사망률",
    build: (sex, age) => recipe(sex, age, { name: "암보험", presets: ["kli7", "waiver", "cancer"], endAge: 100,
      covers: (sh) => [newCoverage(sh, "incidence", { label: "암 진단", amount: 5e7, endAge: 100, waitMonths: 3, eventColId: col(sh, "incidence") })],
      riders: [{ name: "특약1 암입원", presets: ["kli7", "waiver", "cancerHosp"], endAge: 100,
        covers: (sh) => [newCoverage(sh, "daily", { label: "암 입원", amount: 1e5, endAge: 100, waitMonths: 3, eventColId: col(sh, "recurring") })] }] }) },
  { id: "maturity", label: "진단 + 만기환급금", need: "발생률 + 지급 시점",
    build: (sex, age) => recipe(sex, age, { name: "만기환급형 진단보험", presets: ["kli7", "waiver", "twoMajor"], endAge: age + 19,
      conditions: { payYears: 20, termYears: 20 },
      covers: (sh) => [
        newCoverage(sh, "incidence", { label: "2대질병 진단", amount: 3e7, endAge: age + 19, eventColId: col(sh, "incidence") }),
        newCoverage(sh, "survival", { label: "만기환급금", amount: 1e7, endAge: age + 19, points: [{ age: age + 20, multiple: 1 }] }),
      ] }) },
  { id: "waiverSupport", label: "납입면제(보험료납입지원) 적용 3대질병", need: "3대질병 발생률 + 납입면제 발생률(고도후유장해+3대질병)",
    build: (sex, age) => recipe(sex, age, { name: "보험료납입지원 적용 3대질병보험", presets: ["kli7", "waiverSupport", "threeMajor"], endAge: 80,
      conditions: { payYears: 20 },
      covers: (sh) => [newCoverage(sh, "incidence", { label: "3대질병 진단", amount: 3e7, endAge: 80, eventColId: col(sh, "incidence") })] }) },
  { id: "noRefund", label: "무해지환급형 진단 (해지율 3%)", need: "발생률 + 환급률 0 + 해지율",
    build: (sex, age) => recipe(sex, age, { name: "무해지환급형 진단보험", presets: ["kli7", "waiver", "twoMajor"], endAge: 80,
      conditions: { low: { on: true, ratio: 0, lapseRate: 0.03 } },
      covers: (sh) => [newCoverage(sh, "incidence", { label: "2대질병 진단(무해지)", amount: 3e7, endAge: 80, eventColId: col(sh, "incidence") })] }) },
];
