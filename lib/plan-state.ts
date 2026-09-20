import { BENEFIT_KINDS, computePlan, getAssumption, planTermYears, type BenefitKind, type Expenses, type PlanCoverage, type PlanInput, type PlanPoint, type PlanResult, type PlanStep, type Sex } from "@/lib/engine";
import { clamp, pct, won } from "./format";
import {
  columnArray, defaultSheet, deathCols, firstError, MAX_AGE, presetColumn, rateCoverage, RATE_PRESETS, resolveSheet,
  setAgeRange, sumColumns, waiverCols, type RateColumn, type RateKind, type RateSheet, type ResolvedSheet,
} from "./plan-rates";
import { newColId } from "./plan-rates";
import { shiftRows } from "./sheet-formula";
import { COLUMN_RECIPES } from "./sheet-snippets";

export const PLAN_STORAGE_KEY = "fwl:plan:v2";
export const PAY_YEARS = [5, 10, 15, 20, 30] as const;
export const FREQS = [{ v: 12, label: "월납" }, { v: 4, label: "3개월납" }, { v: 2, label: "6개월납" }, { v: 1, label: "연납" }] as const;

export interface PlanCoverageState {
  id: string;
  label: string;
  kind: BenefitKind;
  amount: number;        // 보장금액(원). 일당형은 1일당
  endAge: number;        // 보장 종료 연령
  waitMonths: number;    // 면책기간(개월). 첫해 급부 배율 = 1 − waitMonths/12
  eventColId: string;    // 급부 열(시트의 열 id). 생존형은 쓰지 않는다
  exitColIds: string[];  // 탈퇴 열들(합산)
  steps: PlanStep[];     // 연령 구간별 보장금액 배수(증액·감액). 비면 전 기간 1.0
  points: PlanPoint[];   // 생존형 지급 시점
}

export interface PlanState {
  version: 2;
  productName: string; memo: string;
  sex: Sex; age: number;
  termYears: number;     // 0 = 자동(담보 중 가장 긴 것)
  payYears: number; freq: number;
  interest: number; standardInterest: number;
  waiver: boolean;
  low: { on: boolean; ratio: number; lapseRate: number };
  expenses: Expenses;
  sheet: RateSheet;
  coverages: PlanCoverageState[];
  open: string[];        // 펼쳐 놓은 단계 id
  updatedAt: number;
}

const DEFAULT_EXPENSES = getAssumption("default-2026").expenses;
export const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

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

/** 첫 화면 예시: 40세 남, 2대질병 진단형 3천만원 80세 만기 20년납 */
export function initialPlan(): PlanState {
  const sex: Sex = "M", age = 40;
  const sheet = defaultSheet(sex, age, 80);
  const inc = sheet.columns.find((c) => c.kind === "incidence")!;
  return {
    version: 2, productName: "2대질병 진단보험", memo: "",
    sex, age, termYears: 0, payYears: 20, freq: 12,
    interest: 0.025, standardInterest: 0.0325, waiver: true,
    low: { on: false, ratio: 0.7, lapseRate: 0.03 },
    expenses: DEFAULT_EXPENSES, sheet,
    coverages: [newCoverage(sheet, "incidence", { label: "2대질병 진단", amount: 3e7, endAge: 80, eventColId: inc.id })],
    open: ["contract"], updatedAt: 0,
  };
}

// ── 산출 ────────────────────────────────────────────────────────────────────
export const waitFactorOf = (months: number) => clamp(1 - months / 12, 0, 1);

export function toPlanInput(s: PlanState, r: ResolvedSheet): { input: PlanInput; coverages: PlanCoverage[] } {
  const coverages: PlanCoverage[] = s.coverages.map((c) => ({
    id: c.id, label: c.label, kind: c.kind, amount: c.amount, endAge: c.endAge,
    event: c.kind === "survival" ? [] : columnArray(s.sheet, r, c.eventColId),
    exit: sumColumns(s.sheet, r, c.exitColIds),
    waitFactor: waitFactorOf(c.waitMonths),
    steps: c.steps, points: c.points,
  }));
  const input: PlanInput = {
    age: s.age, termYears: s.termYears > 0 ? s.termYears : planTermYears(s.age, coverages),
    payYears: s.payYears, freq: s.freq,
    interest: s.interest, standardInterest: s.standardInterest,
    waiverRate: s.waiver ? sumColumns(s.sheet, r, waiverCols(s.sheet)) : [],
    expenses: s.expenses,
    lowSurrender: s.low.on ? { ratio: s.low.ratio, lapseRate: s.low.lapseRate } : undefined,
  };
  return { input, coverages };
}

export function evaluatePlan(s: PlanState): { result: PlanResult; sheet: ResolvedSheet } {
  const sheet = resolveSheet(s.sheet);
  const { input, coverages } = toPlanInput(s, sheet);
  return { result: computePlan(input, coverages), sheet };
}

export const kindMeta = (k: BenefitKind) => BENEFIT_KINDS.find((x) => x.kind === k) ?? BENEFIT_KINDS[0];

// ── 단계(모듈) ───────────────────────────────────────────────────────────────
export type StepStatus = "idle" | "editing" | "done" | "error";
export interface PlanStepCard { id: string; code: string; title: string; status: StepStatus; summary: string[]; message?: string; help: string; coverageId?: string }

/** 오른쪽 단계 카드 목록. 상태·요약 칩은 현재 입력과 산출 결과에서 만든다 */
export function planSteps(s: PlanState, r: PlanResult, sheet: ResolvedSheet): PlanStepCard[] {
  const err = firstError(s.sheet, sheet);
  const waiverIds = waiverCols(s.sheet);
  const out: PlanStepCard[] = [
    { id: "product", code: "M01", title: "상품 기본정보",
      status: s.productName.trim() ? "done" : "editing",
      summary: [s.productName || "이름 없음", ...(s.memo ? [s.memo.slice(0, 20)] : [])],
      help: "상품 이름과 메모입니다. 산출에는 쓰이지 않고 내보내기·저장 이름으로만 씁니다." },
    { id: "contract", code: "M02", title: "계약조건", status: "done",
      summary: [`${s.age}세 ${s.sex === "M" ? "남" : "여"}`, `${r.n}년 만기 / ${r.payYears}년납`, FREQS.find((f) => f.v === s.freq)?.label ?? ""],
      help: "가입나이·성별·보험기간·납입기간·납입주기. 보험기간을 0으로 두면 담보 중 가장 늦게 끝나는 것에 맞춥니다." },
    { id: "basis", code: "M03", title: "이자율·저해지", status: s.interest > 0 ? "done" : "error",
      summary: [`i = ${pct(s.interest, 2)}`, `표준 ${pct(s.standardInterest, 2)}`, ...(s.low.on ? [`${s.low.ratio === 0 ? "무해지" : `저해지 ${Math.round(s.low.ratio * 100)}%`} · 해지율 ${pct(s.low.lapseRate)}`] : [])],
      help: "예정이율은 보험료·책임준비금에, 표준이율은 표준책임준비금과 해약공제 기준 신계약비에 씁니다. 저해지·무해지형은 적용해지율을 넣어 다시 산출합니다." },
    { id: "rates", code: "M04", title: "위험률 열", status: err ? "error" : s.sheet.columns.length ? "done" : "editing",
      summary: s.sheet.columns.map((c) => c.name),
      message: err ? `${err.cell} 칸: ${err.code}` : undefined,
      help: "왼쪽 시트의 열마다 이름·유형(사망·최초발생·반복지급·기타)·납입면제 포함 여부를 정합니다. 유형이 담보와 납입면제에 어떻게 이어질지를 결정합니다." },
    { id: "waiver", code: "M05", title: "납입면제", status: s.waiver && waiverIds.length === 0 ? "error" : "done",
      summary: s.waiver ? (waiverIds.length ? s.sheet.columns.filter((c) => c.waiver).map((c) => c.name) : ["열 없음"]) : ["미적용"],
      message: s.waiver && waiverIds.length === 0 ? "납입면제를 켰지만 납입면제 열이 없습니다. M04에서 열을 지정하세요." : undefined,
      help: "납입면제로 표시한 열의 합이 납입자 집단 l′의 탈퇴율 f가 됩니다. 기존 장해율을 불러오거나, 다른 열에서 수식으로 만들거나, Excel에서 붙여넣어 쓸 수 있습니다." },
  ];
  s.coverages.forEach((c, i) => {
    const row = r.coverages.find((x) => x.id === c.id);
    const cover = rateCoverage(s.sheet, s.age, Math.min(c.endAge, s.age + r.n - 1));
    const noEvent = c.kind !== "survival" && !s.sheet.columns.some((x) => x.id === c.eventColId);
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
    { id: "expense", code: "M06", title: "사업비", status: "done",
      summary: [s.expenses.model === "method" ? "산출방법서형" : "3이원 단순형"],
      help: "산출방법서형은 α_S·α_P·β_S·β_G·β′·γ 6개를, 3이원 단순형은 α·β·γ 3개를 씁니다. 보장기간이 20년보다 짧으면 α_P는 n/20배로 줄입니다." },
    { id: "result", code: "M07", title: "산출 결과", status: r.effective.monthlyGross > 0 ? "done" : "error",
      summary: [`${s.freq === 12 ? "월" : "회"} ${won(r.effective.monthlyGross)}`, `총 ${won(r.effective.totalPaid)}`, `환급률 ${pct(r.effective.rate[r.payYears] ?? 0)}`],
      message: r.effective.monthlyGross > 0 ? undefined : "보험료가 0입니다 — 위험률 열과 보장금액을 확인하세요.",
      help: "담보별 보험료를 합친 값입니다. 아래 그래프와 표에 책임준비금·해약환급금·연도별 보장금액이 나옵니다." },
  );
  return out;
}

// ── 저장·복원 ───────────────────────────────────────────────────────────────
const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d: string, max = 60) => (typeof v === "string" && v.trim() ? v.slice(0, max) : d);
const RATE_KIND_SET = new Set(["death", "incidence", "recurring", "other"]);

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
  const sheet = sanitizeSheet(r.sheet, sex, age);
  const coverages = (Array.isArray(r.coverages) && r.coverages.length ? r.coverages : base.coverages).map((c) => sanitizeCoverage(c, sheet, age)).slice(0, 12);
  const low = (r.low ?? {}) as Partial<PlanState["low"]>;
  return {
    version: 2,
    productName: str(r.productName, base.productName, 60), memo: str(r.memo, "", 200),
    sex, age,
    termYears: clamp(Math.round(n(r.termYears, 0)), 0, MAX_AGE),
    payYears: clamp(Math.round(n(r.payYears, base.payYears)), 1, 60),
    freq: FREQS.some((f) => f.v === r.freq) ? (r.freq as number) : 12,
    interest: clamp(n(r.interest, base.interest), 0, 0.2),
    standardInterest: clamp(n(r.standardInterest, base.standardInterest), 0, 0.2),
    waiver: typeof r.waiver === "boolean" ? r.waiver : base.waiver,
    low: { on: low.on === true, ratio: clamp(n(low.ratio, 0.7), 0, 1), lapseRate: clamp(n(low.lapseRate, 0.03), 0, 0.5) },
    expenses, sheet, coverages,
    open: Array.isArray(r.open) ? r.open.filter((x) => typeof x === "string").slice(0, 20) : base.open,
    updatedAt: n(r.updatedAt, 0),
  };
}

// ── reducer ─────────────────────────────────────────────────────────────────
export type ContractPatch = Partial<Pick<PlanState, "productName" | "memo" | "sex" | "age" | "termYears" | "payYears" | "freq" | "interest" | "standardInterest" | "waiver">>;
export type CoveragePatch = Partial<Omit<PlanCoverageState, "id">>;

export type PlanAction =
  | { type: "contract"; patch: ContractPatch }
  | { type: "low"; patch: Partial<PlanState["low"]> }
  | { type: "expenses"; patch: Partial<Record<string, number>> }
  | { type: "expenseModel"; model: Expenses["model"] }
  | { type: "toggleStep"; id: string }
  | { type: "addCoverage"; kind: BenefitKind }
  | { type: "removeCoverage"; id: string }
  | { type: "moveCoverage"; id: string; dir: -1 | 1 }
  | { type: "coverage"; id: string; patch: CoveragePatch }
  // 시트
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
const mapCol = (s: PlanState, colId: string, f: (c: RateColumn) => RateColumn): RateSheet =>
  ({ ...s.sheet, columns: s.sheet.columns.map((c) => (c.id === colId ? f(c) : c)) });

export function planReducer(s: PlanState, a: PlanAction): PlanState {
  switch (a.type) {
    case "contract": {
      const age = a.patch.age ?? s.age;
      const coverages = age !== s.age ? s.coverages.map((c) => ({ ...c, endAge: Math.max(c.endAge, age) })) : s.coverages;
      // 성별을 바꾸면 기존 표에서 불러온 값은 그대로 둔다(사용자가 고친 수식·값을 덮지 않는다)
      return touch(s, { ...a.patch, coverages });
    }
    case "low": return touch(s, { low: { ...s.low, ...a.patch } });
    case "expenses": return touch(s, { expenses: { ...s.expenses, ...a.patch } as Expenses });
    case "expenseModel":
      return touch(s, { expenses: a.model === "simple"
        ? { model: "simple", alpha: 0.007, beta: 0.0015, gamma: 0.02 }
        : { model: "method", alphaS: 0.01, alphaP: 1, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 } });
    case "toggleStep":
      return { ...s, open: s.open.includes(a.id) ? s.open.filter((x) => x !== a.id) : [...s.open, a.id] };
    case "addCoverage": {
      if (s.coverages.length >= 12) return s;
      const c = newCoverage(s.sheet, a.kind, { label: `담보 ${s.coverages.length + 1}`, endAge: Math.max(s.age, 80) });
      return touch(s, { coverages: [...s.coverages, c], open: [...s.open, `cov:${c.id}`] });
    }
    case "removeCoverage":
      return s.coverages.length <= 1 ? s : touch(s, { coverages: s.coverages.filter((c) => c.id !== a.id) });
    case "moveCoverage": {
      const i = s.coverages.findIndex((c) => c.id === a.id), j = i + a.dir;
      if (i < 0 || j < 0 || j >= s.coverages.length) return s;
      const next = [...s.coverages];
      [next[i], next[j]] = [next[j], next[i]];
      return touch(s, { coverages: next });
    }
    case "coverage": {
      const coverages = s.coverages.map((c) => {
        if (c.id !== a.id) return c;
        const merged = { ...c, ...a.patch };
        // 급부 유형이나 급부 열이 바뀌면 탈퇴 열을 다시 잡는다(사용자가 직접 고른 경우는 patch에 실려 온다)
        if ((a.patch.kind || a.patch.eventColId) && !a.patch.exitColIds) {
          const ev = a.patch.kind && !a.patch.eventColId ? suggestEventCol(s.sheet, merged.kind) : merged.eventColId;
          return { ...merged, eventColId: ev, exitColIds: autoExitCols(s.sheet, merged.kind, ev) };
        }
        return merged;
      });
      return touch(s, { coverages });
    }
    case "cell":
      return touch(s, { sheet: mapCol(s, a.colId, (c) => ({ ...c, cells: c.cells.map((v, i) => (i === a.row ? a.value : v)) })) });
    case "fillDown":
      // 이 칸의 수식을 아래 끝까지 채운다. 상대 행 참조는 한 칸씩 밀려 "앞 값 이어받기"가 된다
      return touch(s, { sheet: mapCol(s, a.colId, (c) => ({
        ...c, cells: c.cells.map((v, i) => (i <= a.row ? v : shiftRows(c.cells[a.row] ?? "", i - a.row))),
      })) });
    case "column": return touch(s, { sheet: mapCol(s, a.colId, (c) => ({ ...c, ...a.patch })) });
    case "addColumn": {
      if (s.sheet.columns.length >= 20) return s;
      const p = RATE_PRESETS.find((x) => x.id === a.presetId) ?? RATE_PRESETS[RATE_PRESETS.length - 1];
      return touch(s, { sheet: { ...s.sheet, columns: [...s.sheet.columns, presetColumn(p, s.sex, s.sheet.ages)] } });
    }
    case "addRecipeColumn": {
      if (s.sheet.columns.length >= 20) return s;
      const rec = COLUMN_RECIPES.find((x) => x.id === a.recipeId);
      if (!rec) return s;
      const cells = s.sheet.ages.map((_, row) => rec.cell({ sheet: s.sheet, row, ages: s.sheet.ages }));
      const col: RateColumn = { id: newColId(), name: rec.label, kind: rec.kind, waiver: rec.waiver, cells };
      return touch(s, { sheet: { ...s.sheet, columns: [...s.sheet.columns, col] } });
    }
    case "removeColumn": {
      if (s.sheet.columns.length <= 1) return s;
      const sheet = { ...s.sheet, columns: s.sheet.columns.filter((c) => c.id !== a.colId) };
      const coverages = s.coverages.map((c) => ({
        ...c,
        eventColId: c.eventColId === a.colId ? suggestEventCol(sheet, c.kind) : c.eventColId,
        exitColIds: c.exitColIds.filter((x) => x !== a.colId),
      }));
      return touch(s, { sheet, coverages });
    }
    case "ageRange": return touch(s, { sheet: setAgeRange(s.sheet, a.from, a.to) });
    case "pasteTable": {
      // 붙여넣은 표로 연령 행을 맞추고, 열은 이름이 같으면 덮고 없으면 더한다
      const base = setAgeRange(s.sheet, a.ages[0], a.ages[a.ages.length - 1]);
      const index = new Map(a.ages.map((x, i) => [x, i]));
      const cellsFor = (src: string[]) => base.ages.map((age) => { const i = index.get(age); return i === undefined ? "0" : src[i] ?? "0"; });
      const columns = [...base.columns];
      for (const col of a.columns) {
        const at = columns.findIndex((c) => c.name === col.name);
        if (at >= 0) columns[at] = { ...columns[at], cells: cellsFor(col.cells) };
        else if (columns.length < 20) columns.push({ id: newColId(), name: col.name, kind: "other", waiver: false, cells: cellsFor(col.cells) });
      }
      return touch(s, { sheet: { ...base, columns } });
    }
    case "load": return sanitizePlan(a.state);
    case "reset": return initialPlan();
    default: return s;
  }
}

// ── 레시피: 입력만 바꿔 만들 수 있는 보장 ───────────────────────────────────
export interface PlanRecipe { id: string; label: string; need: string; build: (sex: Sex, age: number) => PlanState }

function recipe(sex: Sex, age: number, opts: {
  name: string; presets: string[]; endAge: number;
  covers: (sheet: RateSheet) => PlanCoverageState[];
  patch?: Partial<PlanState>;
}): PlanState {
  const ages = Array.from({ length: Math.max(1, opts.endAge - age + 1) }, (_, i) => age + i);
  const sheet: RateSheet = { ages, columns: opts.presets.map((id) => presetColumn(RATE_PRESETS.find((p) => p.id === id)!, sex, ages)) };
  const coverages = opts.covers(sheet);
  return { ...initialPlan(), productName: opts.name, sex, age, sheet, coverages, open: ["contract"], ...opts.patch };
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
  { id: "cancerSet", label: "암 진단 + 암입원 일당", need: "암발생률 + 암입원 기대일수 + 사망률",
    build: (sex, age) => recipe(sex, age, { name: "암보험", presets: ["kli7", "waiver", "cancer", "cancerHosp"], endAge: 100,
      covers: (sh) => [
        newCoverage(sh, "incidence", { label: "암 진단", amount: 5e7, endAge: 100, waitMonths: 3, eventColId: col(sh, "incidence") }),
        newCoverage(sh, "daily", { label: "암 입원", amount: 1e5, endAge: 100, waitMonths: 3, eventColId: col(sh, "recurring") }),
      ] }) },
  { id: "maturity", label: "진단 + 만기환급금", need: "발생률 + 지급 시점",
    build: (sex, age) => recipe(sex, age, { name: "만기환급형 진단보험", presets: ["kli7", "waiver", "twoMajor"], endAge: age + 19,
      patch: { payYears: 20, termYears: 20 },
      covers: (sh) => [
        newCoverage(sh, "incidence", { label: "2대질병 진단", amount: 3e7, endAge: age + 19, eventColId: col(sh, "incidence") }),
        newCoverage(sh, "survival", { label: "만기환급금", amount: 1e7, endAge: age + 19, points: [{ age: age + 20, multiple: 1 }] }),
      ] }) },
  { id: "noRefund", label: "무해지환급형 진단 (해지율 3%)", need: "발생률 + 환급률 0 + 해지율",
    build: (sex, age) => recipe(sex, age, { name: "무해지환급형 진단보험", presets: ["kli7", "waiver", "twoMajor"], endAge: 80,
      patch: { low: { on: true, ratio: 0, lapseRate: 0.03 } },
      covers: (sh) => [newCoverage(sh, "incidence", { label: "2대질병 진단(무해지)", amount: 3e7, endAge: 80, eventColId: col(sh, "incidence") })] }) },
];
