import type { Commutation } from "./commutation";
import type { Contract, Expenses } from "./types";

export interface Loading { alpha: number; betaS: number; betaPrime: number; betaG: number; gamma: number }
export interface PremiumResult {
  pvb: number;    // 급부 현가(radix 기준)
  nStar: number;  // 월납 보정 납입기수
  net: number;    // 순보험료(1회 납입, 1단위당)
  base: number;   // 기준연납순보험료
  pBeta: number;  // β′ 포함 연납순보험료(준비금용)
  gross: number;  // 영업보험료(1회 납입)
  alpha: number;  // 신계약비(1단위당) = α_S + α_P·round5(base)
  loading: Loading;
}

export const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function pvBenefit(k: Commutation, S: number[], C: number[]): number {
  let s = 0;
  for (let t = 0; t < k.n; t++) s += S[t] * k.Cx[t];
  for (let t = 0; t <= k.n; t++) s += (C[t] ?? 0) * k.Dx[t];
  return s;
}

/** N* = mm·[(N′x0 − N′xm) − (mm−1)/(2mm)·(D′x0 − D′xm)] */
export function nStar(k: Commutation, m: number, mm: number): number {
  return mm * ((k.Npx[0] - k.Npx[m]) - ((mm - 1) / (2 * mm)) * (k.Dpx[0] - k.Dpx[m]));
}

/**
 * 원본 `P` 시트(정기)·`총괄` 시트(종신공제) 산식.
 * pvCsv는 저해지·무해지형의 해지급부 현가(Ā_x = M̄_x + CSV_x). 급부 현가에 더해져 순보험료·기준연납·준비금에 모두 반영된다.
 */
export function premium(k: Commutation, c: Contract, e: Expenses, pvCsv = 0): PremiumResult {
  const { n, Dpx, Nx, Npx } = k;
  const m = c.payYears, mm = c.freq;
  const pvb = pvBenefit(k, c.S, c.C) + pvCsv;
  const N = nStar(k, m, mm);
  const net = pvb / N;
  const base = pvb / (Npx[0] - Npx[Math.min(n, 20)]);
  if (e.model === "method") {
    const lAlpha = ((e.alphaS + e.alphaP * base) * Dpx[0]) / N;
    const lBetaS = e.betaS / mm;
    const lBetaPrime = (e.betaPrime * (Nx[m] - Nx[n])) / N;
    const gross = (net + lAlpha + lBetaS + lBetaPrime) / (1 - e.betaG - e.gamma);
    const pBeta = (pvb + e.betaPrime * (Nx[m] - Nx[n])) / (Npx[0] - Npx[m]);
    return { pvb, nStar: N, net, base, pBeta, gross, alpha: e.alphaS + e.alphaP * round5(base),
      loading: { alpha: lAlpha, betaS: lBetaS, betaPrime: lBetaPrime, betaG: e.betaG * gross, gamma: e.gamma * gross } };
  }
  const lAlpha = (e.alpha * Dpx[0]) / N;
  const lBeta = (e.beta * (Nx[0] - Nx[n])) / N;
  const gross = (net + lAlpha + lBeta) / (1 - e.gamma);
  return { pvb, nStar: N, net, base, pBeta: pvb / (Npx[0] - Npx[m]), gross, alpha: e.alpha,
    loading: { alpha: lAlpha, betaS: lBeta, betaPrime: 0, betaG: 0, gamma: e.gamma * gross } };
}
