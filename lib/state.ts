import kli7 from "@/lib/engine/data/rates-kli7.json";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import { addonCurve, ASSUMPTIONS, buildPreset, mergeAddon, PRESETS, RIDERS, type Addon, type MergeRecord, type RiderId, compute, DEFAULT_ENVELOPE, expandBlocks, getAssumption, toBlocks, type AssumptionSet, type Block, type DebtMethod, type EngineInput, type EngineResult, type EnvelopeParams, type PresetContext, type PresetId, type RateTable, type Sex } from "@/lib/engine";
import { clamp, roundS0, S0_MAX, S0_MIN, S0_UNIT } from "./format";
import { presetNeeds } from "./preset-needs";
export { roundS0, S0_MAX, S0_MIN, S0_UNIT };

export const TABLE = kli7 as RateTable;
export const CANCER_TABLE = cancerRates as RateTable;
/** 상품: 종신보험(사망보험금, ω세 종신) · 암보험(암진단보험금, 100세 만기, 사망 시 책임준비금 지급) */
export type Product = "whole" | "cancer";
export const PRODUCT_LABEL: Record<Product, string> = { whole: "설계형 종신보험", cancer: "설계형 암보험" };
export const BENEFIT_LABEL: Record<Product, string> = { whole: "사망보험금", cancer: "암진단보험금" };
export const CANCER_ASSUMPTION_ID = "cancer-2026";
export const tableOf = (p: { product?: Product }): RateTable => (p.product === "cancer" ? CANCER_TABLE : TABLE);
export const ASSUMPTION_ID = "default-2026";
export const STORAGE_KEY = "fwl:design:v1";

/** 산출 가정과 설계 제약. 설계 상태의 일부라서 공유 링크·인쇄에도 그대로 실린다 */
export interface Settings { assumption: AssumptionSet; envelope: EnvelopeParams }
export const DEFAULT_SETTINGS: Settings = { assumption: getAssumption(ASSUMPTION_ID), envelope: DEFAULT_ENVELOPE };
export const envelopeOf = (s: { settings?: Settings }): EnvelopeParams => s.settings?.envelope ?? DEFAULT_ENVELOPE;
export const assumptionOf = (s: { settings?: Settings }): AssumptionSet => s.settings?.assumption ?? DEFAULT_SETTINGS.assumption;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const numObj = <T extends object>(raw: unknown, d: T): T => {
  const o = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(d as Record<string, number>).map(([k, v]) => [k, num(o[k], v)])) as T;
};

/** 저장·공유에서 온 설정을 믿지 않는다. 숫자가 아니면 기본값, 알 수 없는 세트는 기본 세트 */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const a = (r.assumption ?? {}) as Partial<AssumptionSet> & Record<string, unknown>;
  const base = ASSUMPTIONS.find((x) => x.id === a.id) ?? (a.id === "custom" ? DEFAULT_SETTINGS.assumption : undefined);
  let assumption = DEFAULT_SETTINGS.assumption;
  if (base) {
    const e = a.expenses as Record<string, unknown> | undefined;
    const expenses: AssumptionSet["expenses"] = e?.model === "simple"
      ? { model: "simple", ...numObj(e, { alpha: 0.007, beta: 0.0015, gamma: 0.02 }) }
      : e?.model === "method"
        ? { model: "method", ...numObj(e, { alphaS: 0.01, alphaP: 1, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 }) }
        : base.expenses;
    assumption = {
      ...base,
      id: a.id === "custom" ? "custom" : base.id,
      label: typeof a.label === "string" ? a.label : base.label,
      version: typeof a.version === "string" ? a.version : base.version,
      interest: num(a.interest, base.interest), standardInterest: num(a.standardInterest, base.standardInterest),
      waiver: typeof a.waiver === "boolean" ? a.waiver : base.waiver,
      expenses,
      lowSurrender: numObj(a.lowSurrender, base.lowSurrender),
      needs: numObj(a.needs, base.needs),
    };
  }
  const e = numObj(r.envelope, DEFAULT_ENVELOPE);
  // 편집기·프리셋이 기대는 범위로 묶는다(초기 고정 1년 이상, 0 < 하한 ≤ 상한, 금액 > 0)
  const envelope: EnvelopeParams = {
    fixYears: clamp(Math.round(e.fixYears), 1, 30), maxGrowth: clamp(e.maxGrowth, 0, 1), growthEndAge: clamp(Math.round(e.growthEndAge), 20, 100),
    maxMultiple: clamp(e.maxMultiple, 1, 10), minMultiple: clamp(e.minMultiple, 0.01, Math.min(1, clamp(e.maxMultiple, 1, 10))), minAmount: Math.max(1, e.minAmount), uwLimit: Math.max(1e7, e.uwLimit),
  };
  return { assumption, envelope };
}

/** 숫자를 하나라도 고치면 사용자 정의 세트가 된다 */
export function customize(a: AssumptionSet, baseId: string): AssumptionSet {
  const origin = a.id === "custom" ? baseId : a.id;
  return { ...a, id: "custom", version: "사용자 정의", label: `사용자 정의 (기본: ${origin})` };
}

export interface Profile {
  product: Product;      // 종신보험 | 암보험
  sex: Sex; age: number;
  childrenAges: number[]; hasSpouse: boolean;
  income: number; liquidAssets: number; debt: number; debtYears: number; retirementAge: number;
  groupCover: number; groupCoverEndAge: number; termCover: number; termCoverEndAge: number;
  // 프리셋 조건(공통 프로필이라 어느 팝업에서 고쳐도 모두 반영)
  spouseAge: number;         // 배우자 나이(은퇴증액형 기대여명)
  livingMonthly: number;     // 은퇴 후 배우자 월 생활비(원)
  retireAssets: number;      // 은퇴 자산: 연금·퇴직금 현가(원)
  debtRate: number;          // 대출 금리(연)
  debtMethod: DebtMethod;    // 상환방식
  netAssets: number;         // 순자산(상속준비형)
  assetGrowth: number;       // 자산 증가율(연)
}

export interface DesignState {
  version: 1;
  profile: Profile;
  S0: number;            // 기준보험금(원). 월 보험료는 파생값
  payYears: number;
  waiver: boolean;
  lowSurrender: boolean;
  presetId: PresetId | "custom";
  basePresetId?: PresetId;   // 직접 편집(custom)이 어느 프리셋에서 출발했는지
  blocks: Block[];       // death 카드(연속·빈틈 없음) + celebration 카드
  anchors: number[];     // 그래프에서 직접 정한 변경 연령(오름차순). 이 사이는 매년 한 칸씩 보간된다
  settings: Settings;    // 가정 세트·설계 제약
  infoApplied: InfoApplied; // 입력 정보 중 프리셋 경계에 반영한 항목
  addons: Addon[];       // 추가 조건(옵션 레이어): 그래프에 별도 선, 결합하면 스케줄에 더해진다
  riders: Record<RiderId, RiderState>;   // 특약: 부가 여부와 보장금액(1일당 금액). 기간은 주계약을 따른다
  updatedAt: number;     // 0이면 한 번도 편집하지 않은 기본 상태
}

export const DEFAULT_PROFILE: Profile = {
  product: "whole", sex: "M", age: 40, childrenAges: [], hasSpouse: true,
  income: 6e7, liquidAssets: 3e7, debt: 0, debtYears: 10, retirementAge: 65,
  groupCover: 0, groupCoverEndAge: 60, termCover: 0, termCoverEndAge: 60,
  spouseAge: 40, livingMonthly: 2.5e6, retireAssets: 0, debtRate: 0.05, debtMethod: "annuity", netAssets: 0, assetGrowth: 0.03,
};

export const omegaOf = (sex: Sex, product: Product = "whole") => tableOf({ product }).meta.terminal[sex];
/** n = ω − x (종신) */
export const termOf = (p: Profile) => omegaOf(p.sex, p.product) - p.age;
/** 마지막 사망보장 연령 = ω − 1 */
export const endAgeOf = (p: Profile) => omegaOf(p.sex, p.product) - 1;

/** 입력 정보 중 설계에 반영한 항목. 기본은 모두 false — 프리셋은 표준 경계로 그린다 */
export interface InfoApplied { child: boolean; debt: boolean; retire: boolean; group: boolean; estate: boolean; income: boolean }   // 프리셋별 조건 반영. retire: 은퇴시기·은퇴 후 필요액(은퇴증액형, 단체보험보완형과 은퇴시기 공유), income: 기준보험금을 입력 기반으로 정했는지
export const NO_INFO: InfoApplied = { child: false, debt: false, retire: false, group: false, estate: false, income: false };
export const PRESET_FLAG: Partial<Record<PresetId, keyof InfoApplied>> = { child: "child", debt: "debt", retire: "retire", group: "group", estate: "estate", level: "income" };
/** 표준 경계(가입 후 경과년 기준): 자녀 독립 20년 후(막내 5세 가정), 부채 만기 20년(5년 후부터 15년 감액), 은퇴·단체보험 만기 65세 */
export const STANDARD_BOUNDARY = { youngestChildAge: 5, debtYears: 20, retirementAge: 65 } as const;   // 단체보험 만기 = 은퇴시기

/** 프리셋 경계. 반영 플래그가 켜진 항목만 프로필 값을 쓰고 나머지는 표준 경계 */
export function presetContext(p: Profile, env: EnvelopeParams = DEFAULT_ENVELOPE, applied: InfoApplied = NO_INFO, assumption: AssumptionSet = DEFAULT_SETTINGS.assumption): PresetContext {
  const hasChild = p.childrenAges.length > 0;
  const n = termOf(p);
  // 조건 반영이 켜진 프리셋은 필요액 곡선(target)을 붙여 표준 모양 대신 규칙에 맞춰 그린다
  const targets: PresetContext["targets"] = {};
  for (const id of ["child", "debt", "retire", "group", "estate"] as const) {
    if (!applied[id]) continue;
    const r = presetNeeds(id, p, assumption, tableOf(p), n, env, { retirementAge: applied.retire ? p.retirementAge : STANDARD_BOUNDARY.retirementAge });
    if (r?.available) targets[id] = { target: r.target, floor: r.floor };
  }
  return {
    age: p.age, n, targets, fixYears: env.fixYears, maxMultiple: env.maxMultiple, minMultiple: env.minMultiple,
    youngestChildAge: applied.child && hasChild ? Math.min(...p.childrenAges) : STANDARD_BOUNDARY.youngestChildAge,
    debtYears: applied.debt && p.debt > 0 ? p.debtYears : STANDARD_BOUNDARY.debtYears,
    retirementAge: applied.retire ? p.retirementAge : STANDARD_BOUNDARY.retirementAge,
    groupCoverEndAge: applied.retire ? p.retirementAge : STANDARD_BOUNDARY.retirementAge,   // 단체보험은 퇴직(은퇴시기)에 끝난다
    growthEndAge: env.growthEndAge,
  };
}

export function initialState(): DesignState {
  return {
    version: 1, profile: DEFAULT_PROFILE, S0: 1e8, payYears: 20, waiver: true, lowSurrender: false,
    presetId: "level", blocks: buildPreset("level", presetContext(DEFAULT_PROFILE)), anchors: [], settings: DEFAULT_SETTINGS, infoApplied: NO_INFO, addons: [], riders: defaultRiders(), updatedAt: 0,
  };
}
export const DEFAULT_STATE: DesignState = initialState();

export function toEngineInput(s: DesignState): EngineInput {
  return { sex: s.profile.sex, age: s.profile.age, payYears: s.payYears, S0: s.S0, blocks: s.blocks, waiver: s.waiver, lowSurrender: s.lowSurrender };
}

/** 현재 가정 세트·위험률표로 설계 상태를 산출한다 */
export const evaluate = (s: DesignState): EngineResult => compute(toEngineInput(s), assumptionOf(s), tableOf(s.profile));

export const STEP = 0.1;               // 그래프 1칸 = 기준보험금의 10%
export const CELEBRATION_RATIO = 0.1;  // 축하금 = 해당 연령 사망보험금의 10%
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** 첫 편집 가능 연령 = 가입연령 + 초기 고정 연수(E01) */
export const firstEditableAge = (p: Profile, env: EnvelopeParams = DEFAULT_ENVELOPE) => p.age + env.fixYears;
/** 연도별 사망보험금 배수 S_t (t = 0..n−1) */
export const levels = (s: DesignState): number[] => expandBlocks(s.blocks, s.profile.age, termOf(s.profile)).S;
/** 하한 배수: E05 감액 하한과 E06 최소 금액 중 큰 쪽 */
export const floorMultiple = (S0: number, env: EnvelopeParams = DEFAULT_ENVELOPE) => Math.max(env.minMultiple, env.minAmount / S0);

export interface AllowedRange { editable: boolean; prev: number; ref: number; steps: number; min: number; max: number }
/** 드래그 한 번 동안 고정되는 기준: 드래그 시작 시점의 배수 벡터와 변경점 */
export interface LevelBase { S: number[]; anchors: number[] }

/** 쉼표·공백으로 구분한 나이 목록 → 범위 안의 정수 나이(중복 제거, 오름차순). 축하금 입력용 */
export const parseAgeList = (text: string, min: number, max: number): number[] =>
  [...new Set(text.split(/[,\s]+/).filter(Boolean).map(Number).filter((a) => Number.isInteger(a) && a >= min && a <= max))].sort((u, v) => u - v);

/** 결합 뒤 그래프·기준보험금을 바꾸지 않았을 때만 분리할 수 있다 */
export function canUnmerge(s: DesignState, add: Addon): boolean {
  const r = add.merged;
  if (!r || r.afterS0 !== s.S0) return false;
  const cur = levels(s);
  return cur.length === r.afterS.length && cur.every((v, i) => Math.abs(v - r.afterS[i]) < 1e-9);
}

/** 특약 상태: 기본은 모두 꺼짐, 금액은 특약 기본값(진단·수술 1천만, 암입원 1일 10만, 입원 1일 5만) */
export interface RiderState { on: boolean; amount: number }
export function defaultRiders(): Record<RiderId, RiderState> { return Object.fromEntries(RIDERS.map((r) => [r.id, { on: false, amount: r.defaultAmount }])) as Record<RiderId, RiderState>; }   // 함수 선언(호이스팅): DEFAULT_STATE가 모듈 로드 시 부른다
export function sanitizeRiders(raw: unknown): Record<RiderId, RiderState> {
  const out = defaultRiders();
  const r = (raw ?? {}) as Partial<Record<RiderId, Partial<RiderState>>>;
  for (const d of RIDERS) {
    const v = r[d.id];
    if (!v) continue;
    out[d.id] = { on: v.on === true, amount: Number.isFinite(Number(v.amount)) && Number(v.amount) > 0 ? Number(v.amount) : d.defaultAmount };
  }
  return out;
}

/** 추가 조건 목록 정리(저장 파일·공유 링크에서 온 값 포함) */
export function sanitizeAddons(raw: unknown): Addon[] {
  if (!Array.isArray(raw)) return [];
  const out: Addon[] = [];
  for (const r of raw as Partial<Addon>[]) {
    const kind = r?.kind === "loan" || r?.kind === "fixed" ? r.kind : r?.kind === "education" ? "education" : null;
    if (!kind || !(Number(r.amount) > 0)) continue;
    const m = r.merged as Partial<MergeRecord> | undefined;
    const nums = (v: unknown) => (Array.isArray(v) && v.every((x) => Number.isFinite(x)) ? (v as number[]) : null);
    const merged = m && nums(m.beforeS) && nums(m.afterS) && Number.isFinite(m.beforeS0) && Number.isFinite(m.afterS0)
      ? { beforeS: nums(m.beforeS)!, beforeS0: Number(m.beforeS0), beforeAnchors: nums(m.beforeAnchors) ?? [], beforePreset: String(m.beforePreset ?? "custom"), afterS: nums(m.afterS)!, afterS0: Number(m.afterS0) } : undefined;
    out.push({ id: String(r.id ?? out.length + 1), kind, amount: Math.min(1e10, Number(r.amount)), years: clamp(Math.round(Number(r.years) || 0), 0, 60), childAge: kind === "education" ? clamp(Math.round(Number(r.childAge) || 0), 0, 40) : undefined, label: typeof r.label === "string" ? r.label.slice(0, 40) : undefined, merged });
  }
  return out.slice(0, 10);
}

/** 첫 편집 연령 뒤·최종연령 안의 유효한 변경점만 오름차순으로 */
export const cleanAnchors = (anchors: unknown, p: Profile, env: EnvelopeParams = DEFAULT_ENVELOPE): number[] =>
  [...new Set((Array.isArray(anchors) ? anchors : []).filter((a): a is number => Number.isFinite(a) && a > firstEditableAge(p, env) && a <= endAgeOf(p)))].sort((u, v) => u - v);

/**
 * 연령 A에서 그래프로 움직일 수 있는 범위.
 * 기준(ref)은 A보다 앞선 마지막 변경점(없으면 첫 편집 연령 45세), 칸 수 = A − ref, level0 = ref 직전 해의 배수(직전 변경점이 정한 수준).
 * 허용 범위 = level0 ± 칸 수 × 0.1 (상한 3배·하한 E05 20%·E06 1천만원). 올리기·내리기 모두 매년 최대 한 칸(10%)씩만 움직인다.
 * prev는 지금 A의 배수(드래그 시작 값)로, 편집기가 이동량을 재는 기준이다. A 이후는 기존 모양 위에 같은 폭(Δ)을 더하고,
 * A 직전은 매년 한 칸을 넘지 않는 가장 짧은 램프로 그 전해 값에서 새 값까지 잇는다(level 액션).
 */
export function allowedRange(s: DesignState, ageAt: number, base?: LevelBase): AllowedRange {
  const x = s.profile.age, S = base?.S ?? levels(s), anchors = base?.anchors ?? s.anchors;
  const env = envelopeOf(s);
  const first = firstEditableAge(s.profile, env), end = endAgeOf(s.profile);
  const t = ageAt - x;
  if (ageAt < first || ageAt > end) {
    const prev = S[clamp(t, 0, S.length - 1)];
    return { editable: false, prev, ref: ageAt, steps: 0, min: prev, max: prev };
  }
  const ref = anchors.filter((a) => a < ageAt && a >= first).reduce((m, a) => Math.max(m, a), first);
  const prev = S[t];
  const steps = ageAt - ref;
  const level0 = S[ref - x - 1];
  // 지금 값은 항상 범위 안에 둔다(프리셋 모양이 범위 밖에 있어도 손대지 않으면 그대로)
  return {
    editable: true, prev, ref, steps,
    min: r4(Math.min(prev, Math.max(floorMultiple(s.S0, env), level0 - steps * STEP))),
    max: r4(Math.max(prev, Math.min(env.maxMultiple, level0 + steps * STEP))),
  };
}

/**
 * 변경점 정리: 직전 변경점(없으면 첫 편집 연령 직전 해) 이후 A까지 값이 한 번도 바뀌지 않으면 그 변경점은 직선 위에 있으므로 지운다.
 * 그래프에서 되돌리거나 평탄화해 직선이 되면 마름모가 사라진다.
 */
export function pruneAnchors(S: number[], anchors: number[], x: number, first: number): number[] {
  const out: number[] = [];
  let from = first - x;   // 비교 시작 인덱스(이 해와 그 전해부터 비교)
  for (const a of anchors) {
    const t = a - x;
    let changed = false;
    for (let i = from; i <= t && i < S.length; i++) if (i > 0 && S[i] !== S[i - 1]) { changed = true; break; }
    if (changed) { out.push(a); from = t + 1; }
  }
  return out;
}

/** 고객이 실제로 내는 보험료 기준 요약. 저해지·무해지 ON이면 그 기초로 다시 산출한 보험료·준비금·환급금을 쓴다. */
export function effective(r: EngineResult, payYears: number) {
  const low = r.lowSurrender;
  const gross100k = low?.gross100k ?? r.per100k.gross;
  const monthly = low?.monthlyGross ?? r.monthly.gross;
  const paid = low?.paid ?? r.surrender.paid;
  return {
    isLow: low !== undefined,
    gross100k,
    monthly,
    net: (low?.net100k ?? r.per100k.net) * r.units,   // 해지급부가 급부 현가에 들어가므로 순보험료도 달라진다
    deltaP100k: low?.deltaP100k ?? 0,
    ratio: low?.ratio ?? 1,
    lapseRate: low?.lapseRate ?? 0,
    premiumDiscount: low?.premiumDiscount ?? 0,
    totalPaid: paid[Math.min(payYears, paid.length - 1)],
    cash: low?.cash ?? r.surrender.cash,
    rate: low?.rate ?? r.surrender.rate,
    reserve100k: low?.reserve100k ?? r.reserve100k,
    reserveStd100k: low?.reserveStd100k ?? r.reserveStd100k,
    paid,
    standardMonthly: r.monthly.gross,
  };
}

/** 저해지 / 무해지 표기. 환급률 0이면 무해지환급형 */
export const lowKind = (ratio: number) => (ratio === 0 ? "무해지환급형" : `저해지환급형 ${Math.round(ratio * 100)}%`);

/** 월 보험료(원) → 기준보험금(원). 가장 가까운 1천만원 단위로 맞춘다 */
export const s0FromMonthly = (monthly: number, gross100k: number) => roundS0((monthly * 1e5) / gross100k);

export const deathSegments = (blocks: Block[]) => blocks.filter((b) => b.kind === "death").sort((a, b) => a.fromAge - b.fromAge);
export const celebrations = (blocks: Block[]) => blocks.filter((b) => b.kind === "celebration").sort((a, b) => a.fromAge - b.fromAge);

/** 사망 카드를 가입연령~최종연령 빈틈·겹침 없이 잇는다. 앞 카드의 toAge가 뒤 카드의 fromAge를 정하고, 삼켜진 카드는 버린다. */
export function normalizeSegments(segs: Block[], age: number, endAge: number): Block[] {
  const out: Block[] = [];
  let cur = age;
  for (const s of segs) {
    if (cur > endAge) break;
    if (s.toAge < cur) continue;
    out.push({ ...s, fromAge: cur, toAge: Math.min(Math.max(s.toAge, cur), endAge) });
    cur = out[out.length - 1].toAge + 1;
  }
  if (out.length === 0) out.push({ fromAge: age, toAge: endAge, multiple: 1, kind: "death" });
  out[out.length - 1] = { ...out[out.length - 1], toAge: endAge };
  return out;
}

function clampProfile(p: Profile): Profile {
  return {
    ...p,
    product: p.product === "cancer" ? "cancer" : "whole",
    sex: p.sex === "F" ? "F" : "M",
    age: clamp(Math.round(p.age), 15, 70),
    childrenAges: (Array.isArray(p.childrenAges) ? p.childrenAges : [])
      .filter((a) => Number.isFinite(a))
      .map((a) => clamp(Math.round(a), 0, 40))
      .slice(0, 6),
    income: Math.max(0, p.income), liquidAssets: Math.max(0, p.liquidAssets), debt: Math.max(0, p.debt),
    debtYears: clamp(Math.round(p.debtYears), 1, 40),
    retirementAge: clamp(Math.round(p.retirementAge), 40, 80),
    groupCover: Math.max(0, p.groupCover), groupCoverEndAge: clamp(Math.round(p.groupCoverEndAge), 20, 80),
    termCover: Math.max(0, p.termCover), termCoverEndAge: clamp(Math.round(p.termCoverEndAge), 20, 100),
    spouseAge: clamp(Math.round(Number(p.spouseAge) || p.age), 15, 90), livingMonthly: Math.max(0, Number(p.livingMonthly) || 0), retireAssets: Math.max(0, Number(p.retireAssets) || 0),
    debtRate: clamp(Number(p.debtRate) || 0, 0, 0.3), debtMethod: p.debtMethod === "principal" || p.debtMethod === "bullet" ? p.debtMethod : "annuity",
    netAssets: Math.max(0, Number(p.netAssets) || 0), assetGrowth: clamp(Number(p.assetGrowth) || 0, -0.1, 0.2),
  };
}

function withBlocks(s: DesignState, deaths: Block[], cels: Block[], presetId: DesignState["presetId"] = s.presetId): DesignState {
  const p = s.profile, n = termOf(p);
  const d = normalizeSegments(deaths, p.age, endAgeOf(p));
  const { S } = expandBlocks(d, p.age, n);
  const seen = new Set<number>();
  const c: Block[] = [];
  for (const b of cels) {
    if (b.fromAge < p.age || b.fromAge > p.age + n || seen.has(b.fromAge)) continue;
    seen.add(b.fromAge);
    const t = Math.min(b.fromAge - p.age, n - 1);
    c.push({ fromAge: b.fromAge, toAge: b.fromAge, multiple: r4(CELEBRATION_RATIO * S[t]), kind: "celebration" });
  }
  return { ...s, blocks: [...d, ...c], presetId, updatedAt: Date.now() };
}

export type AutoFixCode = "E01" | "E04" | "E05";

export type Action =
  | { type: "load"; state: DesignState }
  | { type: "reset"; product?: Product }   // 새 설계: 상품을 고르면 그 상품의 가정 세트로 시작
  | { type: "profile"; patch: Partial<Profile> }
  | { type: "S0"; S0: number; exact?: boolean }
  | { type: "payYears"; payYears: number }
  | { type: "waiver"; on: boolean }
  | { type: "lowSurrender"; on: boolean }
  | { type: "preset"; id: PresetId }
  | { type: "segment"; index: number; patch: { toAge?: number; multiple?: number } }
  | { type: "splitSegment"; index: number }
  | { type: "removeSegment"; index: number }
  | { type: "addCelebration"; age: number }
  | { type: "celebration"; index: number; patch: { fromAge: number } }
  | { type: "removeCelebration"; index: number }
  | { type: "level"; age: number; multiple: number; base?: LevelBase }
  | { type: "flatten"; age: number }   // 더블클릭: A 이후를 A의 값으로 평탄화
  | { type: "rider"; id: RiderId; patch: Partial<RiderState> }
  | { type: "addAddon"; addon: Addon }
  | { type: "removeAddon"; id: string }
  | { type: "mergeAddon"; id: string }   // 결합: 추가 조건을 스케줄에 더한다(되돌리기 정보를 보관)
  | { type: "unmergeAddon"; id: string }   // 분리: 결합 뒤 그래프를 바꾸지 않았으면 결합 전으로
  | { type: "settings"; patch: Partial<Settings> }
  | { type: "applyInfo"; applied: Partial<InfoApplied>; S0?: number; presetId?: PresetId }
  | { type: "resetDesign" }
  | { type: "autoFix"; code: AutoFixCode };

export function reducer(s: DesignState, a: Action): DesignState {
  const touch = (patch: Partial<DesignState>): DesignState => ({ ...s, ...patch, updatedAt: Date.now() });
  switch (a.type) {
    case "load": {
      const raw = a.state as Partial<DesignState> | null | undefined;
      const profile = clampProfile({ ...DEFAULT_PROFILE, ...raw?.profile });
      const blocks = Array.isArray(raw?.blocks) ? raw.blocks : [];
      const settings = sanitizeSettings(raw?.settings);
      const merged: DesignState = { ...DEFAULT_STATE, ...raw, profile, settings };
      const payYears = clamp(Math.round(Number(merged.payYears)), 1, termOf(profile));
      const S0 = roundS0(Number(merged.S0));
      const anchors = cleanAnchors(merged.anchors, profile, settings.envelope);
      const ia = (raw?.infoApplied ?? {}) as Partial<Record<keyof InfoApplied, unknown>>;
      const infoApplied: InfoApplied = { child: ia.child === true, debt: ia.debt === true, retire: ia.retire === true, group: ia.group === true, estate: ia.estate === true, income: ia.income === true };
      merged.infoApplied = infoApplied;
      merged.basePresetId = raw?.basePresetId && raw.basePresetId in PRESETS ? raw.basePresetId : merged.presetId !== "custom" ? merged.presetId : undefined;
      merged.addons = sanitizeAddons(raw?.addons);
      merged.riders = sanitizeRiders(raw?.riders);
      return { ...withBlocks({ ...merged, payYears, S0, anchors }, deathSegments(blocks), celebrations(blocks)), updatedAt: merged.updatedAt };
    }
    case "reset": {
      const product: Product = a.product ?? s.profile.product;
      const base = initialState();
      const profile = { ...base.profile, product };
      const assumption = product === "cancer" ? getAssumption(CANCER_ASSUMPTION_ID) : (s.settings.assumption.mortality === "cancer" ? DEFAULT_SETTINGS.assumption : s.settings.assumption);
      const settings = { ...s.settings, assumption };
      return withBlocks({ ...base, profile, settings, waiver: product === "cancer" ? false : base.waiver }, buildPreset("level", presetContext(profile, settings.envelope, NO_INFO, assumption)), [], "level");
    }
    case "resetDesign": {
      // 입력·설정·계약 조건은 두고 설계만 1억·표준 평준형으로. 변경점·축하금·입력 반영도 지운다
      const next = { ...s, S0: 1e8, anchors: [], infoApplied: NO_INFO, basePresetId: "level" as const, addons: [] };
      return withBlocks(next, buildPreset("level", presetContext(s.profile, envelopeOf(s), NO_INFO, assumptionOf(s))), [], "level");
    }
    case "profile": {
      const profile = clampProfile({ ...s.profile, ...a.patch });
      // 조건이 사라진 프리셋(부채 0, 자녀 없음 등)은 반영 표시를 끈다 — 체크된 채 표준 모양으로 조용히 돌아가지 않게
      const infoApplied = { ...s.infoApplied };
      for (const id of ["child", "debt", "group", "estate"] as const) {
        if (infoApplied[id] && !presetNeeds(id, profile, assumptionOf(s), tableOf(profile), termOf(profile), envelopeOf(s))?.available) infoApplied[id] = false;
      }
      const next = { ...s, profile, infoApplied, anchors: cleanAnchors(s.anchors, profile, envelopeOf(s)) };
      const deaths = s.presetId === "custom" ? deathSegments(s.blocks) : buildPreset(s.presetId, presetContext(profile, envelopeOf(s), infoApplied, assumptionOf(s)));
      return withBlocks(next, deaths, celebrations(s.blocks));
    }
    case "S0": return touch({ S0: a.exact ? clamp(Math.round(a.S0), 0, S0_MAX) : roundS0(a.S0), infoApplied: { ...s.infoApplied, income: false } });   // exact: 재설계처럼 예산이 정한 값. 손으로 바꾸면 연소득 반영 표시는 해제
    case "payYears": return touch({ payYears: clamp(Math.round(a.payYears), 1, termOf(s.profile)) });
    case "waiver": return touch({ waiver: a.on });
    case "lowSurrender": return touch({ lowSurrender: a.on });
    case "preset": {
      // 카드 버튼: 그 카드의 체크가 켜져 있으면 조건 반영 곡선, 꺼져 있으면 기준보험금 1억·표준 모양
      const flag = PRESET_FLAG[a.id];
      const on = flag ? s.infoApplied[flag] : false;
      return withBlocks({ ...s, anchors: [], basePresetId: a.id, S0: on ? s.S0 : 1e8 }, buildPreset(a.id, presetContext(s.profile, envelopeOf(s), s.infoApplied, assumptionOf(s))), celebrations(s.blocks), a.id);
    }
    case "applyInfo": {
      // 입력 정보 반영: 체크한 경계만 프로필 값으로, 선택하면 기준보험금·프리셋도 함께. 프리셋 상태면 다시 그린다
      const infoApplied: InfoApplied = { ...s.infoApplied, ...a.applied };
      // 직접 편집 중(custom)에 어떤 프리셋의 조건을 켜면 그 프리셋 곡선으로 다시 그린다(화면에서 미리 확인을 받는다)
      const turnedOn = (Object.keys(a.applied) as (keyof InfoApplied)[]).find((k) => a.applied[k] && !s.infoApplied[k] && k !== "income");
      const fromFlag = turnedOn ? (Object.keys(PRESET_FLAG) as PresetId[]).find((id) => PRESET_FLAG[id] === turnedOn) : undefined;
      const presetId = a.presetId ?? (s.presetId === "custom" && fromFlag ? fromFlag : s.presetId);
      const S0 = a.S0 !== undefined ? roundS0(a.S0) : s.S0;
      const next = { ...s, infoApplied, S0 };
      if (presetId === "custom") return touch({ infoApplied, S0 });
      return withBlocks({ ...next, anchors: [], basePresetId: presetId }, buildPreset(presetId, presetContext(s.profile, envelopeOf(s), infoApplied, assumptionOf(s))), celebrations(s.blocks), presetId);
    }
    case "settings": {
      const merged = sanitizeSettings({ ...s.settings, ...a.patch });
      const baseId = s.settings.assumption.id === "custom" ? (s.settings.assumption.label.match(/기본: ([\w-]+)/)?.[1] ?? ASSUMPTION_ID) : s.settings.assumption.id;
      const known = ASSUMPTIONS.find((x) => x.id === merged.assumption.id);
      const assumption = known && JSON.stringify(known) === JSON.stringify(merged.assumption) ? known : customize(merged.assumption, baseId);
      const settings = { ...merged, assumption };
      return { ...touch({ settings }), anchors: cleanAnchors(s.anchors, s.profile, settings.envelope) };
    }
    case "segment": {
      if (!deathSegments(s.blocks)[a.index]) return s;
      const d = deathSegments(s.blocks).map((b, i) => i !== a.index ? b : {
        ...b,
        toAge: a.patch.toAge === undefined ? b.toAge : Math.round(a.patch.toAge),
        multiple: a.patch.multiple === undefined ? b.multiple : clamp(a.patch.multiple, 0, 10),
      });
      return withBlocks({ ...s, anchors: [] }, d, celebrations(s.blocks), "custom");
    }
    case "splitSegment": {
      const d = deathSegments(s.blocks);
      const b = d[a.index];
      if (!b || b.toAge - b.fromAge < 1) return s;
      const mid = Math.floor((b.fromAge + b.toAge) / 2);
      d.splice(a.index, 1, { ...b, toAge: mid }, { ...b, fromAge: mid + 1 });
      return withBlocks({ ...s, anchors: [] }, d, celebrations(s.blocks), "custom");
    }
    case "removeSegment": {
      const d = deathSegments(s.blocks);
      if (d.length < 2 || !d[a.index]) return s;
      if (a.index > 0) d[a.index - 1] = { ...d[a.index - 1], toAge: d[a.index].toAge };
      d.splice(a.index, 1);
      return withBlocks({ ...s, anchors: [] }, d, celebrations(s.blocks), "custom");
    }
    case "addCelebration": {
      const c: Block = { fromAge: Math.round(a.age), toAge: Math.round(a.age), multiple: 0, kind: "celebration" };
      return withBlocks(s, deathSegments(s.blocks), [...celebrations(s.blocks), c]);
    }
    case "celebration": {
      if (!celebrations(s.blocks)[a.index]) return s;
      const c = celebrations(s.blocks).map((b, i) => (i !== a.index ? b : { ...b, fromAge: Math.round(a.patch.fromAge) }));
      return withBlocks(s, deathSegments(s.blocks), c);
    }
    case "removeCelebration":
      return withBlocks(s, deathSegments(s.blocks), celebrations(s.blocks).filter((_, i) => i !== a.index));
    case "level": {
      const r = allowedRange(s, a.age, a.base);
      if (!r.editable) return s;
      const x = s.profile.age, n = termOf(s.profile);
      const S = a.base && a.base.S.length === n ? a.base.S : levels(s);
      const anchors0 = a.base?.anchors ?? s.anchors;
      const target = r4(clamp(a.multiple, r.min, r.max));
      const t = a.age - x, tRef = r.ref - x;
      // A 이후: 기존 모양(프리셋·이전 편집) 위에 변화폭 Δ = target − 지금 A의 값을 더한다
      const delta = r4(target - S[t]);
      const lo = floorMultiple(s.S0, envelopeOf(s)), hi = envelopeOf(s).maxMultiple;
      const next = S.slice();
      if (delta !== 0) {
        for (let i = t; i < n; i++) next[i] = r4(clamp(S[i] + delta, lo, hi));
        // A 직전 k년: 한 칸에 1년(k ≥ |Δ|/0.1)이되, 그 전해 값(from)에서 target까지 매년 한 칸을 넘으면 더 길게 잡는다.
        // 범위가 level0 ± 칸 수라 k = 칸 수면 항상 가능하다. 되돌리는 드래그는 k = |Δ|/0.1이 이전 램프를 그대로 덮어 원래 모양으로 돌아온다
        let k = Math.max(1, Math.ceil(Math.abs(delta) / STEP - 1e-9));
        while (k < t - tRef && Math.abs(target - S[t - k - 1]) > STEP * k + 1e-9) k++;
        k = Math.min(k, t - tRef);
        const r0 = t - k, from = S[r0 - 1];
        for (let i = r0; i < t; i++) next[i] = r4(clamp(from + ((target - from) * (i - r0 + 1)) / k, lo, hi));
      }
      const unchangedFromBase = next.every((v, i) => v === S[i]);
      const first = firstEditableAge(s.profile, envelopeOf(s));
      const anchors = pruneAnchors(next, unchangedFromBase ? anchors0 : cleanAnchors([...anchors0, a.age], s.profile, envelopeOf(s)), x, first);
      const cur = levels(s);
      const same = next.every((v, i) => v === cur[i]) && anchors.length === s.anchors.length && anchors.every((v, i) => v === s.anchors[i]);
      if (same) return s;
      return withBlocks({ ...s, anchors }, toBlocks(next, x), celebrations(s.blocks), "custom");
    }
    case "rider": {
      const cur = s.riders[a.id];
      const def = RIDERS.find((r) => r.id === a.id)!;
      const amount = a.patch.amount !== undefined ? clamp(Math.round(a.patch.amount), def.kind === "daily" ? 1e4 : 1e6, def.kind === "daily" ? 1e6 : 5e8) : cur.amount;
      return touch({ riders: { ...s.riders, [a.id]: { on: a.patch.on ?? cur.on, amount } } });
    }
    case "addAddon": {
      const [a1] = sanitizeAddons([a.addon]);
      return a1 ? touch({ addons: [...s.addons, a1] }) : s;
    }
    case "removeAddon": return touch({ addons: s.addons.filter((x) => x.id !== a.id) });
    case "mergeAddon": {
      const add = s.addons.find((x) => x.id === a.id);
      if (!add) return s;
      const x = s.profile.age, n = termOf(s.profile);
      const curve = addonCurve(add, n, assumptionOf(s).needs.independenceAge, envelopeOf(s).fixYears);
      if (add.merged) return s;
      const before = levels(s);
      const merged = mergeAddon(before, s.S0, curve, envelopeOf(s), S0_UNIT);
      const rec: MergeRecord = { beforeS: before, beforeS0: s.S0, beforeAnchors: s.anchors, beforePreset: s.presetId, afterS: merged.S, afterS0: merged.S0 };
      const next = { ...s, S0: merged.S0, addons: s.addons.map((y) => (y.id === a.id ? { ...y, merged: rec } : y)), anchors: [] };
      return withBlocks(next, toBlocks(merged.S, x), celebrations(s.blocks), "custom");
    }
    case "unmergeAddon": {
      const add = s.addons.find((x) => x.id === a.id);
      if (!add?.merged || !canUnmerge(s, add)) return s;
      const r = add.merged, x = s.profile.age;
      const presetId = (r.beforePreset in PRESETS ? r.beforePreset : "custom") as DesignState["presetId"];
      const next = { ...s, S0: r.beforeS0, anchors: cleanAnchors(r.beforeAnchors, s.profile, envelopeOf(s)), addons: s.addons.map((y) => (y.id === a.id ? { ...y, merged: undefined } : y)) };
      return withBlocks(next, toBlocks(r.beforeS, x), celebrations(s.blocks), presetId);
    }
    case "flatten": {
      const r = allowedRange(s, a.age);
      if (!r.editable) return s;
      const x = s.profile.age, n = termOf(s.profile), S = levels(s), t = a.age - x;
      const next = S.slice();
      for (let i = t; i < n; i++) next[i] = S[t];
      if (next.every((v, i) => v === S[i])) return s;
      const anchors = pruneAnchors(next, cleanAnchors([...s.anchors.filter((b) => b <= a.age), a.age], s.profile, envelopeOf(s)), x, firstEditableAge(s.profile, envelopeOf(s)));
      return withBlocks({ ...s, anchors }, toBlocks(next, x), celebrations(s.blocks), "custom");
    }
    case "autoFix": {
      const d = deathSegments(s.blocks);
      if (a.code === "E01") {
        d[0] = { ...d[0], toAge: Math.max(d[0].toAge, s.profile.age + envelopeOf(s).fixYears - 1) };
      } else {
        const { minMultiple, maxMultiple } = envelopeOf(s);
        for (let i = 0; i < d.length; i++) d[i] = { ...d[i], multiple: clamp(d[i].multiple, minMultiple, maxMultiple) };
      }
      return withBlocks({ ...s, anchors: [] }, d, celebrations(s.blocks), "custom");
    }
  }
}
