import { commutation, type Commutation } from "./commutation";
import { premium, type PremiumResult } from "./premium";
import { reserves } from "./reserve";
import { surrender } from "./surrender";
import type { Contract, Expenses } from "./types";

/**
 * 일반 상품 산출기. 설계형(compute.ts)이 종신·암 전용 표와 카드 편집기에 묶여 있는 반면,
 * 여기서는 담보마다 위험률(발생률·탈퇴율)과 조건만 주면 산출방법서와 같은 순서로 보험료·준비금·환급금을 낸다.
 * 담보 하나하나를 독립된 소형 상품으로 산출하고(원보사 산출방법서의 담보별 산출과 같다) 마지막에 합친다.
 * 담보가 하나이고 급부 = 탈퇴(사망보장)이면 compute()와 완전히 같은 값이 나온다 — 테스트로 고정.
 */

/**
 * 급부 유형.
 * - incidence 진단형: 발생 시 정액 지급 후 그 담보 소멸(2대질병·암 등). 탈퇴율 = 사망률 + 발생률
 * - death     사망형: 사망 시 지급. 급부 = 탈퇴라 발생률을 따로 두지 않는다
 * - daily     일당형: 입원 1일당 지급. 발생률 자리에 연간 기대 지급일수를 넣는다. 사망으로만 소멸
 * - survival  생존형: 특정 시점 생존 시 지급(축하금·만기환급금). 발생률을 쓰지 않고 시점(points)으로 지정
 */
export type BenefitKind = "incidence" | "death" | "daily" | "survival";

export const BENEFIT_KINDS: { kind: BenefitKind; label: string; unit: string; hint: string }[] = [
  { kind: "incidence", label: "진단형", unit: "진단 시", hint: "발생 시 정액 지급 후 그 담보 소멸. 2대질병·3대질병·암 등" },
  { kind: "death", label: "사망형", unit: "사망 시", hint: "사망 시 지급. 종신·정기보험" },
  { kind: "daily", label: "일당형", unit: "1일당", hint: "입원 1일당 지급. 위험률 자리에 연간 기대 입원일수" },
  { kind: "survival", label: "생존형", unit: "생존 시", hint: "정한 나이에 살아 있으면 지급. 축하금·만기환급금" },
];

export interface PlanStep { fromAge: number; toAge: number; multiple: number }
export interface PlanPoint { age: number; multiple: number }

export interface PlanCoverage {
  id: string;
  label: string;
  kind: BenefitKind;
  amount: number;        // 보장금액(원). daily는 1일당, survival은 배수 1.0일 때의 지급액
  event: number[];       // 연령 인덱스 급부 발생률(daily는 연간 기대일수). survival·death는 쓰지 않는다
  exit: number[];        // 연령 인덱스 탈퇴율
  endAge: number;        // 보장 종료 연령(이 나이까지 보장)
  waitFactor: number;    // 면책: 첫해 급부 배율(90일 면책 → 0.75). 1이면 면책 없음
  steps: PlanStep[];     // 연령 구간별 보장금액 배수(증액·감액). 비어 있으면 전 기간 1.0
  points: PlanPoint[];   // survival 전용 지급 시점
}

export interface PlanInput {
  age: number;
  termYears: number;     // 계약 보험기간(담보 중 가장 긴 것). 0 이하면 담보에서 자동 산출
  payYears: number;
  freq: number;
  interest: number;
  standardInterest: number;
  waiverRate: number[];  // 연령 인덱스 납입면제 발생률. 미적용이면 빈 배열
  expenses: Expenses;
  lowSurrender?: { ratio: number; lapseRate: number };   // 없으면 표준형(완전 환급)
}

export interface PlanCoverageResult {
  id: string; label: string; kind: BenefitKind;
  n: number; payYears: number; units: number;
  per100k: { net: number; gross: number; base: number; alpha: number; alphaStd: number; newBiz: number };
  monthlyNet: number; monthlyGross: number;
  perUnit: PremiumResult;
  benefit: number[];     // 연도별 보장금액(원), t=0..n-1 (담보 종료 후 0)
  survival: number[];    // 시점 생존급부(원), t=0..n
  reserve: number[]; reserveStd: number[]; cash: number[]; deduction: number[];
  low?: { net100k: number; gross100k: number; monthlyNet: number; monthlyGross: number; pvCsv: number; perUnit: PremiumResult; reserve: number[]; reserveStd: number[]; cash: number[] };
}

export interface PlanTotals {
  monthlyNet: number; monthlyGross: number; totalPaid: number;
  reserve: number[]; reserveStd: number[]; deduction: number[]; cash: number[]; paid: number[]; rate: number[];
}

export interface PlanResult {
  n: number; payYears: number; freq: number;
  coverages: PlanCoverageResult[];
  benefit: number[];     // 연도별 총 보장금액(원) — 생존형 제외
  survival: number[];    // 시점 생존급부 합계(원)
  standard: PlanTotals;  // 표준형(완전 환급) 기준
  low?: PlanTotals & { ratio: number; lapseRate: number; premiumDiscount: number; pvCsv: number };
  effective: PlanTotals; // 저해지가 켜져 있으면 low, 아니면 standard
}

const r0 = (x: number) => Math.round(x * 1e5);
const zeros = (len: number) => new Array<number>(len).fill(0);
const addInto = (dst: number[], src: number[]) => { for (let t = 0; t < src.length && t < dst.length; t++) dst[t] += src[t]; return dst; };

/** 담보의 연령 구간 배수. 구간이 비었거나 덮이지 않은 나이는 1.0 */
export function stepMultiple(steps: PlanStep[], age: number): number {
  let m = steps.length === 0 ? 1 : 0;
  for (const s of steps) if (age >= s.fromAge && age <= s.toAge) m = s.multiple;
  return m;
}

/** 담보의 보장기간 n = min(계약 보험기간, endAge + 1 − 가입나이). 최소 1년 */
export const coverageYears = (c: PlanCoverage, age: number, termYears: number) =>
  Math.max(1, Math.min(termYears, c.endAge + 1 - age));

function scaleAlphaP(e: Expenses, n: number): Expenses {
  if (e.model !== "method" || n >= 20) return e;
  return { ...e, alphaP: (e.alphaP * Math.min(n, 20)) / 20 };
}

/** 계약 보험기간: 담보 중 가장 늦게 끝나는 것 */
export const planTermYears = (age: number, coverages: PlanCoverage[]) =>
  Math.max(1, ...coverages.map((c) => c.endAge + 1 - age));

function coverage(c: PlanCoverage, input: PlanInput, n: number, N: number): PlanCoverageResult {
  const { age, freq, expenses } = input;
  const m = Math.min(input.payYears, n);
  const useEvent = c.event.length ? c.event : undefined;   // 비면 급부 = 탈퇴(사망보장)
  const mult = Array.from({ length: n }, (_, t) => (c.kind === "survival" ? 0 : stepMultiple(c.steps, age + t)));
  const S = mult.map((v, t) => (t === 0 ? v * c.waitFactor : v));   // 산출용(면책 반영)
  const C = zeros(n + 1);
  if (c.kind === "survival") for (const p of c.points) { const t = p.age - age; if (t >= 0 && t <= n) C[t] += p.multiple; }
  const contract: Contract = { age, termYears: n, payYears: m, freq, S, C };
  const e = scaleAlphaP(expenses, n);
  const basis = { q: c.exit, f: input.waiverRate, event: useEvent };

  const k = commutation({ interest: input.interest, ...basis }, age, n);
  const ks = commutation({ interest: input.standardInterest, ...basis }, age, n);
  const p = premium(k, contract, e);
  const ps = premium(ks, contract, e);
  const per100k = {
    net: r0(p.net), gross: r0(p.gross), base: r0(p.base),
    alpha: r0(p.alpha), alphaStd: r0(ps.alpha), newBiz: Math.min(r0(p.alpha), r0(ps.alpha)),
  };
  const units = c.amount / 1e5;
  const V = reserves(k, contract, e, p).map(r0);
  const Vs = reserves(ks, contract, e, ps).map(r0);
  const sur = surrender(V, per100k.newBiz, per100k.gross, m, freq, units);

  const grow = (a: number[], len: number) => Array.from({ length: len }, (_, t) => a[t] ?? 0);
  const out: PlanCoverageResult = {
    id: c.id, label: c.label, kind: c.kind, n, payYears: m, units, per100k, perUnit: p,
    monthlyNet: per100k.net * units, monthlyGross: per100k.gross * units,
    benefit: grow(mult.map((v) => v * c.amount), N),
    survival: grow(C.map((v) => v * c.amount), N + 1),
    reserve: grow(sur.reserve, N + 1), reserveStd: grow(Vs.map((v) => v * units), N + 1),
    cash: grow(sur.cash, N + 1), deduction: grow(sur.deduction, N + 1),
  };

  const low = input.lowSurrender;
  if (low) {
    // 저해지·무해지: 해지자에게 표준형 해약환급금의 ratio 만 주고, 그 현가 CSV를 급부 현가에 더해 다시 산출한다
    const wT3 = sur.cash.map((x) => (c.amount > 0 ? x / c.amount : 0));
    const payout = wT3.map((_, t) => (t < m ? (low.ratio * (wT3[t] + (wT3[t + 1] ?? wT3[t]))) / 2 : 0));
    const lapse = { rate: low.lapseRate, years: m };
    const kL = commutation({ interest: input.interest, ...basis, lapse }, age, n);
    const ksL = commutation({ interest: input.standardInterest, ...basis, lapse }, age, n);
    const csvOf = (kk: Commutation) => {
      const acc = new Array<number>(n + 2).fill(0);
      for (let t = n; t >= 0; t--) acc[t] = acc[t + 1] + kk.Wx[t] * payout[t];
      return acc;
    };
    const csv = csvOf(kL), csvs = csvOf(ksL);
    const pL = premium(kL, contract, e, csv[0]), psL = premium(ksL, contract, e, csvs[0]);
    const net100k = r0(pL.net), gross100k = r0(pL.gross);
    out.low = {
      net100k, gross100k, monthlyNet: net100k * units, monthlyGross: gross100k * units, pvCsv: csv[0], perUnit: pL,
      reserve: grow(reserves(kL, contract, e, pL, csv).map((v) => r0(v) * units), N + 1),
      reserveStd: grow(reserves(ksL, contract, e, psL, csvs).map((v) => r0(v) * units), N + 1),
      cash: grow(sur.cash.map((x, t) => (t < m ? Math.round(x * low.ratio) : x)), N + 1),
    };
  }
  return out;
}

function totals(rows: PlanCoverageResult[], N: number, m: number, freq: number, useLow: boolean): PlanTotals {
  const monthlyNet = rows.reduce((s, r) => s + (useLow ? r.low!.monthlyNet : r.monthlyNet), 0);
  const monthlyGross = rows.reduce((s, r) => s + (useLow ? r.low!.monthlyGross : r.monthlyGross), 0);
  const reserve = zeros(N + 1), reserveStd = zeros(N + 1);
  for (const r of rows) { addInto(reserve, useLow ? r.low!.reserve : r.reserve); addInto(reserveStd, useLow ? r.low!.reserveStd : r.reserveStd); }
  const deduction = zeros(N + 1), cash = zeros(N + 1);
  for (const r of rows) { addInto(deduction, r.deduction); addInto(cash, useLow ? r.low!.cash : r.cash); }
  const paid = Array.from({ length: N + 1 }, (_, t) => Math.min(t, m) * freq * monthlyGross);
  return {
    monthlyNet, monthlyGross, totalPaid: paid[Math.min(m, N)],
    reserve, reserveStd, deduction, cash, paid,
    rate: cash.map((x, t) => (paid[t] > 0 ? x / paid[t] : 0)),
  };
}

export function computePlan(input: PlanInput, coverages: PlanCoverage[]): PlanResult {
  const N = input.termYears > 0 ? input.termYears : planTermYears(input.age, coverages);
  const rows = coverages.map((c) => coverage(c, input, coverageYears(c, input.age, N), N));
  const benefit = zeros(N), survival = zeros(N + 1);
  for (const r of rows) { addInto(benefit, r.benefit); addInto(survival, r.survival); }
  const payYears = Math.min(input.payYears, N);
  const standard = totals(rows, N, payYears, input.freq, false);
  const result: PlanResult = { n: N, payYears, freq: input.freq, coverages: rows, benefit, survival, standard, effective: standard };
  const ls = input.lowSurrender;
  if (ls && rows.every((r) => r.low)) {
    const low = totals(rows, N, payYears, input.freq, true);
    result.low = {
      ...low, ratio: ls.ratio, lapseRate: ls.lapseRate,
      premiumDiscount: standard.monthlyGross > 0 ? (standard.monthlyGross - low.monthlyGross) / standard.monthlyGross : 0,
      pvCsv: rows.reduce((s, r) => s + (r.low?.pvCsv ?? 0), 0),
    };
    result.effective = result.low;
  }
  return result;
}
