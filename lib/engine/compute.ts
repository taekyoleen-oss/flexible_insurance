import { commutation, type Commutation } from "./commutation";
import { expandBlocks } from "./schedule";
import { premium, type Loading, type PremiumResult } from "./premium";
import { reserves } from "./reserve";
import { surrender, type SurrenderResult } from "./surrender";
import type { AssumptionSet, Contract, EngineInput, Expenses, RateTable } from "./types";

export interface EngineResult {
  n: number; omega: number; S: number[]; C: number[];
  S0: number; units: number;
  perUnit: PremiumResult & { alphaStd: number };
  per100k: { net: number; gross: number; base: number; alpha: number; alphaStd: number; newBiz: number };
  monthly: { net: number; gross: number };  // S0 기준 원
  totalPaid: number;
  loading: Loading;                          // S0 기준 원(1회 납입)
  reserve100k: number[]; reserveStd100k: number[];
  surrender: SurrenderResult;
  expenseFlow: number[];                     // 연도별 사업비(원), t=0..n-1
  /**
   * 저해지·무해지형(산출방법서 §2.1·§4). 적용해지율 w를 넣은 계산기수로 다시 산출한 결과.
   * 납입기간 중 해지환급금 = 표준형 × ratio(무해지면 0), 그 차액이 급부 현가를 낮춰 보험료가 내려간다.
   * premiumDiscount는 입력이 아니라 결과(표준형 대비 인하율)다.
   */
  lowSurrender?: {
    ratio: number; lapseRate: number;
    premiumDiscount: number; deltaP100k: number;
    net100k: number; gross100k: number; monthlyGross: number;
    pvCsv: number;                              // 해지급부 현가 CSV_0 (radix 10만)
    reserve100k: number[]; reserveStd100k: number[];   // 저해지형 자체 책임준비금
    cash: number[]; rate: number[]; paid: number[];
  };
  meta: { assumptionId: string; assumptionVersion: string; waiver: boolean; lowSurrender: boolean };
}

const r0 = (x: number) => Math.round(x * 1e5);

function scaleAlphaP(e: Expenses, n: number): Expenses {
  if (e.model !== "method" || n >= 20) return e;
  return { ...e, alphaP: (e.alphaP * Math.min(n, 20)) / 20 };
}

export function compute(input: EngineInput, a: AssumptionSet, table: RateTable): EngineResult {
  const rs = table[input.sex];
  const omega = table.meta.terminal[input.sex];
  const n = input.termYears ?? omega - input.age;
  const freq = input.freq ?? 12;
  const waiver = input.waiver ?? a.waiver;
  const useLow = input.lowSurrender ?? false;
  const zero = new Array<number>(rs.q.length).fill(0);
  const { S: S_, C } = expandBlocks(input.blocks, input.age, n);
  // 면책(암 90일 등): 첫해 급부만 waitFactor 배로 산출한다. 표시용 S는 그대로
  const wait = input.waitFactor ?? a.waitFactor ?? 1;
  const S = wait === 1 ? S_ : S_.map((v, t) => (t === 0 ? v * wait : v));
  const c: Contract = { age: input.age, termYears: n, payYears: input.payYears, freq, S, C };
  const e = scaleAlphaP(a.expenses, n);

  const k = commutation({ interest: a.interest, q: rs.q, f: waiver ? rs.f : zero }, input.age, n);
  const p = premium(k, c, e);
  const ks = commutation({ interest: a.standardInterest, q: rs.qStd, f: waiver ? rs.fStd : zero }, input.age, n);
  const ps = premium(ks, c, e);
  const V = reserves(k, c, e, p);
  const Vs = reserves(ks, c, e, ps);

  const units = input.S0 / 100000;
  const per100k = { net: r0(p.net), gross: r0(p.gross), base: r0(p.base), alpha: r0(p.alpha), alphaStd: r0(ps.alpha), newBiz: Math.min(r0(p.alpha), r0(ps.alpha)) };
  const reserve100k = V.map(r0), reserveStd100k = Vs.map(r0);
  const sur = surrender(reserve100k, per100k.newBiz, per100k.gross, c.payYears, freq, units);

  const loading: Loading = { alpha: p.loading.alpha * input.S0, betaS: p.loading.betaS * input.S0, betaPrime: p.loading.betaPrime * input.S0, betaG: p.loading.betaG * input.S0, gamma: p.loading.gamma * input.S0 };
  const expenseFlow = new Array<number>(n).fill(0);
  const bp = e.model === "method" ? e.betaPrime : 0;
  for (let t = 0; t < n; t++) {
    if (t < c.payYears) expenseFlow[t] = freq * (loading.betaS + loading.betaG + loading.gamma);
    else expenseFlow[t] = bp * input.S0;
  }
  expenseFlow[0] += p.alpha * input.S0;

  const result: EngineResult = {
    n, omega, S: S_, C, S0: input.S0, units,
    perUnit: { ...p, alphaStd: ps.alpha },
    per100k,
    monthly: { net: per100k.net * units, gross: per100k.gross * units },
    totalPaid: per100k.gross * units * freq * c.payYears,
    loading, reserve100k, reserveStd100k, surrender: sur, expenseFlow,
    meta: { assumptionId: a.id, assumptionVersion: a.version, waiver, lowSurrender: useLow },
  };
  if (useLow) {
    const { ratio, lapseRate } = a.lowSurrender;
    const m = c.payYears;
    // 해지급부: 납입기간 중 해지하면 표준형 해지환급금(준비금 − 해약공제)의 ratio를 준다. 연중앙 해지 → (W_t + W_{t+1})/2
    const wT3 = sur.cash.map((x) => x / input.S0);                    // 표준형 해지환급금, 기준보험금 1단위당
    const payout = wT3.map((_, t) => (t < m ? (ratio * (wT3[t] + (wT3[t + 1] ?? wT3[t]))) / 2 : 0));
    const lapse = { rate: lapseRate, years: m };
    const kL = commutation({ interest: a.interest, q: rs.q, f: waiver ? rs.f : zero, lapse }, input.age, n);
    const ksL = commutation({ interest: a.standardInterest, q: rs.qStd, f: waiver ? rs.fStd : zero, lapse }, input.age, n);
    // CSV_t = Σ_{u≥t} Wx_u·해지급부_u
    const csvOf = (kk: Commutation) => {
      const out = new Array<number>(n + 2).fill(0);
      for (let t = n; t >= 0; t--) out[t] = out[t + 1] + kk.Wx[t] * payout[t];
      return out;
    };
    const csvL = csvOf(kL), csvsL = csvOf(ksL);
    const pL = premium(kL, c, e, csvL[0]);
    const psL = premium(ksL, c, e, csvsL[0]);
    const net100k = r0(pL.net), gross100k = r0(pL.gross);
    // 납입 완료 후에는 해지율이 0이라 저해지형 준비금이 표준형과 같아진다 → 환급금도 같다
    const cash = sur.cash.map((x, t) => (t < m ? Math.round(x * ratio) : x));
    const paid = cash.map((_, t) => Math.min(t, m) * freq * gross100k * units);
    const rate = cash.map((x, t) => (paid[t] > 0 ? x / paid[t] : 0));
    result.lowSurrender = {
      ratio, lapseRate,
      premiumDiscount: per100k.gross > 0 ? (per100k.gross - gross100k) / per100k.gross : 0,
      deltaP100k: per100k.gross - gross100k,
      net100k, gross100k, monthlyGross: gross100k * units,
      pvCsv: csvL[0],
      reserve100k: reserves(kL, c, e, pL, csvL).map(r0),
      reserveStd100k: reserves(ksL, c, e, psL, csvsL).map(r0),
      cash, rate, paid,
    };
  }
  return result;
}
