import { BENEFIT_KINDS, computePlan, getAssumption, planTermYears, type BenefitKind, type Expenses, type PlanCoverage, type PlanInput, type PlanPoint, type PlanResult, type PlanStep, type Sex } from "@/lib/engine";
import { clamp } from "./format";
import { MAX_AGE, RATE_PRESETS, toAgeArray, waiverRates, type RateGrid } from "./plan-rates";

export const PLAN_STORAGE_KEY = "fwl:plan:v1";
export const PAY_YEARS = [5, 10, 15, 20, 30] as const;
export const FREQS = [{ v: 12, label: "월납" }, { v: 4, label: "3개월납" }, { v: 2, label: "6개월납" }, { v: 1, label: "연납" }] as const;

export interface PlanCoverageState {
  id: string;
  label: string;
  kind: BenefitKind;
  amount: number;        // 보장금액(원). 일당형은 1일당
  endAge: number;        // 보장 종료 연령
  waitMonths: number;    // 면책기간(개월). 첫해 급부 배율 = 1 − waitMonths/12
  presetId: string;      // 위험률을 어디서 불러왔는지(표시용)
  grid: RateGrid;
  steps: PlanStep[];     // 연령 구간별 보장금액 배수(증액·감액). 비면 전 기간 1.0
  points: PlanPoint[];   // 생존형 지급 시점
}

export interface PlanState {
  version: 1;
  sex: Sex; age: number;
  termYears: number;     // 0 = 자동(담보 중 가장 긴 것)
  payYears: number; freq: number;
  interest: number; standardInterest: number;
  waiver: boolean;
  low: { on: boolean; ratio: number; lapseRate: number };
  expenses: Expenses;
  coverages: PlanCoverageState[];
  selected: string;
  updatedAt: number;
}

const DEFAULT_EXPENSES = getAssumption("default-2026").expenses;
export const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

export function newCoverage(sex: Sex, age: number, over: Partial<PlanCoverageState> = {}): PlanCoverageState {
  const endAge = over.endAge ?? 80;
  const presetId = over.presetId ?? "twoMajor";
  const preset = RATE_PRESETS.find((p) => p.id === presetId) ?? RATE_PRESETS[0];
  return {
    id: newId(), label: "새 담보", kind: "incidence", amount: 3e7, endAge, waitMonths: 0,
    presetId, grid: preset.build(sex, age, endAge), steps: [], points: [], ...over,
  };
}

/** 첫 화면 예시: 40세 남, 2대질병 진단형 3천만원 80세 만기 20년납 */
export function initialPlan(): PlanState {
  const sex: Sex = "M", age = 40;
  const first = newCoverage(sex, age, { label: "2대질병 진단", kind: "incidence", amount: 3e7, endAge: 80, presetId: "twoMajor" });
  return {
    version: 1, sex, age, termYears: 0, payYears: 20, freq: 12,
    interest: 0.025, standardInterest: 0.0325, waiver: true,
    low: { on: false, ratio: 0.7, lapseRate: 0.03 },
    expenses: DEFAULT_EXPENSES,
    coverages: [first], selected: first.id, updatedAt: 0,
  };
}

// ── 산출 ────────────────────────────────────────────────────────────────────
export const waitFactorOf = (months: number) => clamp(1 - months / 12, 0, 1);

export function toPlanInput(s: PlanState): { input: PlanInput; coverages: PlanCoverage[] } {
  const coverages: PlanCoverage[] = s.coverages.map((c) => ({
    id: c.id, label: c.label, kind: c.kind, amount: c.amount, endAge: c.endAge,
    event: toAgeArray(c.grid.ages, c.grid.event),
    exit: toAgeArray(c.grid.ages, c.grid.exit),
    waitFactor: waitFactorOf(c.waitMonths),
    steps: c.steps, points: c.points,
  }));
  const input: PlanInput = {
    age: s.age, termYears: s.termYears > 0 ? s.termYears : planTermYears(s.age, coverages),
    payYears: s.payYears, freq: s.freq,
    interest: s.interest, standardInterest: s.standardInterest,
    waiverRate: s.waiver ? waiverRates(s.sex) : [],
    expenses: s.expenses,
    lowSurrender: s.low.on ? { ratio: s.low.ratio, lapseRate: s.low.lapseRate } : undefined,
  };
  return { input, coverages };
}

export function evaluatePlan(s: PlanState): PlanResult {
  const { input, coverages } = toPlanInput(s);
  return computePlan(input, coverages);
}

export const selectedCoverage = (s: PlanState): PlanCoverageState | undefined =>
  s.coverages.find((c) => c.id === s.selected) ?? s.coverages[0];

export const kindMeta = (k: BenefitKind) => BENEFIT_KINDS.find((x) => x.kind === k) ?? BENEFIT_KINDS[0];

// ── 저장·복원 ───────────────────────────────────────────────────────────────
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const arr = (v: unknown): number[] => (Array.isArray(v) ? v.map((x) => n(x, 0)) : []);

function sanitizeGrid(raw: unknown): RateGrid {
  const g = (raw ?? {}) as Partial<RateGrid>;
  const ages = arr(g.ages).map((a) => clamp(Math.round(a), 0, MAX_AGE));
  const event = arr(g.event), exit = arr(g.exit);
  return { ages, event: ages.map((_, i) => event[i] ?? 0), exit: ages.map((_, i) => exit[i] ?? 0) };
}

function sanitizeCoverage(raw: unknown, sex: Sex, age: number): PlanCoverageState {
  const c = (raw ?? {}) as Partial<PlanCoverageState>;
  const base = newCoverage(sex, age);
  const kind = BENEFIT_KINDS.some((k) => k.kind === c.kind) ? (c.kind as BenefitKind) : base.kind;
  const endAge = clamp(Math.round(n(c.endAge, base.endAge)), age, MAX_AGE);
  const g = sanitizeGrid(c.grid);
  return {
    id: typeof c.id === "string" && c.id ? c.id : newId(),
    label: typeof c.label === "string" && c.label.trim() ? c.label.slice(0, 40) : base.label,
    kind, amount: clamp(n(c.amount, base.amount), 0, 1e11), endAge,
    waitMonths: clamp(Math.round(n(c.waitMonths, 0)), 0, 24),
    presetId: typeof c.presetId === "string" ? c.presetId : base.presetId,
    grid: g.ages.length ? g : base.grid,
    steps: (Array.isArray(c.steps) ? c.steps : []).map((s) => ({
      fromAge: clamp(Math.round(n(s?.fromAge, age)), 0, MAX_AGE),
      toAge: clamp(Math.round(n(s?.toAge, endAge)), 0, MAX_AGE),
      multiple: clamp(n(s?.multiple, 1), 0, 100),
    })),
    points: (Array.isArray(c.points) ? c.points : []).map((p) => ({
      age: clamp(Math.round(n(p?.age, endAge)), 0, MAX_AGE), multiple: clamp(n(p?.multiple, 1), 0, 100),
    })),
  };
}

/** 저장·공유에서 온 값을 믿지 않는다. 숫자가 아니면 기본값 */
export function sanitizePlan(raw: unknown): PlanState {
  const r = (raw ?? {}) as Partial<PlanState>;
  const base = initialPlan();
  const sex: Sex = r.sex === "F" ? "F" : "M";
  const age = clamp(Math.round(n(r.age, base.age)), 0, 90);
  const e = (r.expenses ?? {}) as Record<string, unknown>;
  const expenses: Expenses = e.model === "simple"
    ? { model: "simple", alpha: n(e.alpha, 0.007), beta: n(e.beta, 0.0015), gamma: n(e.gamma, 0.02) }
    : e.model === "method"
      ? { model: "method", alphaS: n(e.alphaS, 0.01), alphaP: n(e.alphaP, 1), betaS: n(e.betaS, 0.0015), betaG: n(e.betaG, 0.045), betaPrime: n(e.betaPrime, 0.001), gamma: n(e.gamma, 0.025) }
      : base.expenses;
  const coverages = (Array.isArray(r.coverages) && r.coverages.length ? r.coverages : base.coverages).map((c) => sanitizeCoverage(c, sex, age)).slice(0, 12);
  const low = (r.low ?? {}) as Partial<PlanState["low"]>;
  return {
    version: 1, sex, age,
    termYears: clamp(Math.round(n(r.termYears, 0)), 0, MAX_AGE),
    payYears: clamp(Math.round(n(r.payYears, base.payYears)), 1, 60),
    freq: FREQS.some((f) => f.v === r.freq) ? (r.freq as number) : 12,
    interest: clamp(n(r.interest, base.interest), 0, 0.2),
    standardInterest: clamp(n(r.standardInterest, base.standardInterest), 0, 0.2),
    waiver: typeof r.waiver === "boolean" ? r.waiver : base.waiver,
    low: { on: low.on === true, ratio: clamp(n(low.ratio, 0.7), 0, 1), lapseRate: clamp(n(low.lapseRate, 0.03), 0, 0.5) },
    expenses, coverages,
    selected: coverages.some((c) => c.id === r.selected) ? (r.selected as string) : coverages[0].id,
    updatedAt: n(r.updatedAt, 0),
  };
}

// ── reducer ─────────────────────────────────────────────────────────────────
export type ContractPatch = Partial<Pick<PlanState, "sex" | "age" | "termYears" | "payYears" | "freq" | "interest" | "standardInterest" | "waiver">>;
export type CoveragePatch = Partial<Omit<PlanCoverageState, "id">>;

export type PlanAction =
  | { type: "contract"; patch: ContractPatch }
  | { type: "low"; patch: Partial<PlanState["low"]> }
  | { type: "expenses"; patch: Partial<Record<string, number>> }
  | { type: "expenseModel"; model: Expenses["model"] }
  | { type: "addCoverage" }
  | { type: "removeCoverage"; id: string }
  | { type: "selectCoverage"; id: string }
  | { type: "coverage"; id: string; patch: CoveragePatch }
  | { type: "load"; state: unknown }
  | { type: "reset" };

const touch = (s: PlanState, patch: Partial<PlanState>): PlanState => ({ ...s, ...patch, updatedAt: Date.now() });

export function planReducer(s: PlanState, a: PlanAction): PlanState {
  switch (a.type) {
    case "contract": {
      const next = { ...s, ...a.patch };
      // 가입나이·성별이 바뀌면 보장 종료 연령이 가입나이보다 앞설 수 없다
      const coverages = next.age !== s.age
        ? s.coverages.map((c) => ({ ...c, endAge: Math.max(c.endAge, next.age) }))
        : s.coverages;
      return touch(s, { ...a.patch, coverages });
    }
    case "low": return touch(s, { low: { ...s.low, ...a.patch } });
    case "expenses": return touch(s, { expenses: { ...s.expenses, ...a.patch } as Expenses });
    case "expenseModel":
      return touch(s, { expenses: a.model === "simple"
        ? { model: "simple", alpha: 0.007, beta: 0.0015, gamma: 0.02 }
        : { model: "method", alphaS: 0.01, alphaP: 1, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 } });
    case "addCoverage": {
      if (s.coverages.length >= 12) return s;
      const c = newCoverage(s.sex, s.age, { label: `담보 ${s.coverages.length + 1}` });
      return touch(s, { coverages: [...s.coverages, c], selected: c.id });
    }
    case "removeCoverage": {
      if (s.coverages.length <= 1) return s;
      const coverages = s.coverages.filter((c) => c.id !== a.id);
      return touch(s, { coverages, selected: coverages.some((c) => c.id === s.selected) ? s.selected : coverages[0].id });
    }
    case "selectCoverage": return { ...s, selected: a.id };
    case "coverage": return touch(s, { coverages: s.coverages.map((c) => (c.id === a.id ? { ...c, ...a.patch } : c)) });
    case "load": return sanitizePlan(a.state);
    case "reset": return initialPlan();
    default: return s;
  }
}

// ── 레시피: 입력만 바꿔 만들 수 있는 보장 형태 ───────────────────────────────
export interface PlanRecipe { id: string; label: string; need: string; build: (sex: Sex, age: number) => PlanState }

const withCoverages = (sex: Sex, age: number, cs: PlanCoverageState[], over: Partial<PlanState> = {}): PlanState => ({
  ...initialPlan(), sex, age, coverages: cs, selected: cs[0].id, ...over,
});

/** 화면에 "이 입력으로 이런 보장을 만들 수 있다"를 보여 주고, 누르면 그대로 채워 준다 */
export const PLAN_RECIPES: PlanRecipe[] = [
  { id: "twoMajor", label: "2대질병 진단 (80세 만기)", need: "2대질병 발생률 + 사망률",
    build: (sex, age) => withCoverages(sex, age, [newCoverage(sex, age, { label: "2대질병 진단", kind: "incidence", amount: 3e7, endAge: 80, presetId: "twoMajor" })]) },
  { id: "term", label: "정기 사망 (60세 만기)", need: "사망률만",
    build: (sex, age) => withCoverages(sex, age, [newCoverage(sex, age, { label: "사망", kind: "death", amount: 1e8, endAge: 60, presetId: "kli7" })]) },
  { id: "whole", label: "종신 사망 (110세)", need: "사망률만",
    build: (sex, age) => withCoverages(sex, age, [newCoverage(sex, age, { label: "사망", kind: "death", amount: 1e8, endAge: 110, presetId: "kli7" })]) },
  { id: "decreasing", label: "체감형 정기 (60세부터 절반)", need: "사망률 + 연령 구간 배수",
    build: (sex, age) => withCoverages(sex, age, [newCoverage(sex, age, { label: "사망(체감)", kind: "death", amount: 1e8, endAge: 80, presetId: "kli7",
      steps: [{ fromAge: age, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: 80, multiple: 0.5 }] })]) },
  { id: "cancerSet", label: "암 진단 + 암입원 일당", need: "암발생률 + 암입원 연간 기대일수",
    build: (sex, age) => withCoverages(sex, age, [
      newCoverage(sex, age, { label: "암 진단", kind: "incidence", amount: 5e7, endAge: 100, presetId: "cancer", waitMonths: 3 }),
      newCoverage(sex, age, { label: "암 입원", kind: "daily", amount: 1e5, endAge: 100, presetId: "cancerHosp", waitMonths: 3 }),
    ]) },
  { id: "maturity", label: "진단 + 만기환급금", need: "발생률 + 지급 시점",
    build: (sex, age) => withCoverages(sex, age, [
      newCoverage(sex, age, { label: "2대질병 진단", kind: "incidence", amount: 3e7, endAge: age + 20 - 1, presetId: "twoMajor" }),
      newCoverage(sex, age, { label: "만기환급금", kind: "survival", amount: 1e7, endAge: age + 20 - 1, presetId: "kli7", points: [{ age: age + 20, multiple: 1 }] }),
    ], { payYears: 20, termYears: 20 }) },
  { id: "noRefund", label: "무해지환급형 진단 (해지율 3%)", need: "발생률 + 환급률 0 + 해지율",
    build: (sex, age) => withCoverages(sex, age, [newCoverage(sex, age, { label: "2대질병 진단(무해지)", kind: "incidence", amount: 3e7, endAge: 80, presetId: "twoMajor" })],
      { low: { on: true, ratio: 0, lapseRate: 0.03 } }) },
];
