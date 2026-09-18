import type { Commutation } from "./commutation";
import type { PremiumResult } from "./premium";
import type { Contract, Expenses } from "./types";

/**
 * 연말 책임준비금(순보식 + 납입후유지비), 1단위당, t=0..n. 원본 `V` 시트 C~I열.
 * V_t = [Σ_{u≥t,u<n} S_u·Cx_u + Σ_{u>t} C_u·Dx_u + CSV_t + β′·(Nx_{max(t,m)} − Nx_n) − P_β·(N′x_t − N′x_m)·[t≤m]] / Dx_t
 * csv[t] = Σ_{u≥t} Wx_u·(해지급부) — 저해지·무해지형에서만 0이 아니다.
 */
export function reserves(k: Commutation, c: Contract, e: Expenses, p: PremiumResult, csv?: number[]): number[] {
  const { n, Dx, Nx, Npx, Cx } = k;
  const m = c.payYears;
  const bp = e.model === "method" ? e.betaPrime : 0;
  const futureDeath = new Array<number>(n + 2).fill(0);
  for (let t = n - 1; t >= 0; t--) futureDeath[t] = futureDeath[t + 1] + c.S[t] * Cx[t];
  const futureSurv = new Array<number>(n + 2).fill(0);
  for (let t = n; t >= 0; t--) futureSurv[t] = futureSurv[t + 1] + (c.C[t] ?? 0) * Dx[t];
  const V = new Array<number>(n + 1);
  for (let t = 0; t <= n; t++) {
    if (Dx[t] <= 0) { V[t] = 0; continue; }
    const maint = bp * (Nx[Math.max(t, m)] - Nx[n]);
    const income = t <= m ? p.pBeta * (Npx[t] - Npx[m]) : 0;
    V[t] = (futureDeath[t] + futureSurv[t + 1] + (csv?.[t] ?? 0) + maint - income) / Dx[t];
  }
  return V;
}
