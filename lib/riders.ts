import { riderCommutation, riderPremium, RIDERS, type RiderId } from "@/lib/engine";
import cancerHosp from "@/lib/engine/data/rates-cancer-hosp.json";
import { assumptionOf, CANCER_TABLE, TABLE, type DesignState } from "./state";

/** 사망 담보가 아닌 보장(암보험 주계약·특약 전부)은 100세 만기로 고정한다 */
export const NON_DEATH_END_AGE = 100;

/**
 * 특약 위험률. 암발생률(2024-112호)·암입원율은 제공받은 값이고, 암수술·뇌출혈·급성심근경색·일반 입원은 회사 요율이 없어
 * 사망률·암발생률에 계수를 곱한 임시값이다. 계수를 바꾸거나 회사 위험률로 교체하면 된다(계획서 §0.14).
 */
export const RIDER_FACTORS = {
  cancerSurg: 0.8,        // 암 진단자 중 수술 비율 (임시)
  cancerHospDaysPerYear: 365,   // 암입원율(1일 기준) × 365 = 연간 기대 입원일수
  strokeOfMortality: 0.35,// 뇌출혈 발생률 = 경험사망률 × 계수 (임시)
  amiOfMortality: 0.30,   // 급성심근경색 발생률 = 경험사망률 × 계수 (임시)
  hospDaysBase: 1.0,      // 일반 입원 연간 기대일수 = base + slope × 사망률, 상한 cap (임시)
  hospDaysSlope: 800,
  hospDaysCap: 30,
  cancerWait: 0.75,       // 암 관련 특약 90일 면책: 첫해 급부 3/4
} as const;

export const RIDER_RATE_NOTE: Record<RiderId, string> = {
  cancerDx: "암발생률 (생명장기제2024-112호)",
  cancerSurg: `암발생률 × ${RIDER_FACTORS.cancerSurg} (임시)`,
  cancerHosp: "암입원율 × 365일 (제공 자료)",
  stroke: `경험사망률 × ${RIDER_FACTORS.strokeOfMortality} (임시)`,
  ami: `경험사망률 × ${RIDER_FACTORS.amiOfMortality} (임시)`,
  hosp: `min(${RIDER_FACTORS.hospDaysCap}, ${RIDER_FACTORS.hospDaysBase} + ${RIDER_FACTORS.hospDaysSlope} × 사망률)일 (임시)`,
};

export interface RiderRow { id: RiderId; label: string; kind: "lump" | "daily"; unitLabel: string; on: boolean; amount: number; monthly: number; per100k: number; termYears: number; payYears: number; exit: number[]; event: number[]; wait: number; note: string }

/** 특약별 월 보험료. 보험기간은 100세 만기(사망 담보 외 공통), 납입기간·이율·사업비는 주계약(현재 상품·가정 세트)을 따른다 */
export function riderPremiums(s: DesignState): RiderRow[] {
  const p = s.profile, a = assumptionOf(s), n = Math.max(1, NON_DEATH_END_AGE - p.age), m = Math.min(s.payYears, n);
  const q = TABLE[p.sex].q, inc = CANCER_TABLE[p.sex].q, hd = (cancerHosp as { M: number[]; F: number[] })[p.sex];
  const len = Math.max(q.length, inc.length);
  const at = (arr: number[], i: number) => arr[i] ?? arr[arr.length - 1] ?? 0;
  const vec = (f: (i: number) => number) => Array.from({ length: len }, (_, i) => f(i));
  const bases: Record<RiderId, { exit: number[]; event: number[]; wait: number }> = {
    cancerDx: { exit: vec((i) => at(q, i) + at(inc, i)), event: vec((i) => at(inc, i)), wait: RIDER_FACTORS.cancerWait },
    cancerSurg: { exit: vec((i) => at(q, i) + at(inc, i)), event: vec((i) => at(inc, i) * RIDER_FACTORS.cancerSurg), wait: RIDER_FACTORS.cancerWait },
    cancerHosp: { exit: vec((i) => at(q, i)), event: vec((i) => at(hd, i) * RIDER_FACTORS.cancerHospDaysPerYear), wait: RIDER_FACTORS.cancerWait },   // 입원 급부는 반복 지급이라 사망으로만 소멸
    stroke: { exit: vec((i) => at(q, i) * (1 + RIDER_FACTORS.strokeOfMortality)), event: vec((i) => at(q, i) * RIDER_FACTORS.strokeOfMortality), wait: 1 },
    ami: { exit: vec((i) => at(q, i) * (1 + RIDER_FACTORS.amiOfMortality)), event: vec((i) => at(q, i) * RIDER_FACTORS.amiOfMortality), wait: 1 },
    hosp: { exit: vec((i) => at(q, i)), event: vec((i) => Math.min(RIDER_FACTORS.hospDaysCap, RIDER_FACTORS.hospDaysBase + RIDER_FACTORS.hospDaysSlope * at(q, i))), wait: 1 },
  };
  return RIDERS.map((d) => {
    const r = s.riders[d.id];
    const b = bases[d.id];
    const k = riderCommutation({ interest: a.interest, exit: b.exit, event: b.event }, p.age, n);
    const pr = riderPremium(k, p.age, m, 12, a.expenses, b.wait);
    const per100k = Math.round(pr.gross * 1e5);            // 기준금액 10만원당 월 보험료(원)
    const monthly = per100k * (r.amount / 1e5);
    return { id: d.id, label: d.label, kind: d.kind, unitLabel: d.unitLabel, on: r.on, amount: r.amount, monthly, per100k, termYears: n, payYears: m, exit: b.exit, event: b.event, wait: b.wait, note: RIDER_RATE_NOTE[d.id] };
  });
}

export const riderTotal = (rows: RiderRow[]) => rows.filter((r) => r.on).reduce((s, r) => s + r.monthly, 0);
