import type { Commutation } from "./commutation";
import { premium, type PremiumResult } from "./premium";
import type { Contract, Expenses } from "./types";

/**
 * 특약(보장이 작아 계약자가 모양을 바꾸지 않는 정액 담보). 보험기간·납입기간은 주계약을 따른다.
 * lump: 진단·수술 시 1회 지급 후 그 특약 소멸. daily: 입원 1일당 지급(연간 기대 입원일수로 산출), 사망 시 소멸.
 */
export type RiderId = "cancerDx" | "cancerSurg" | "cancerHosp" | "stroke" | "ami" | "hosp";
export interface RiderDef { id: RiderId; label: string; kind: "lump" | "daily"; defaultAmount: number; unitLabel: string; group: "cancer" | "ci" | "hosp" }
export const RIDERS: RiderDef[] = [
  { id: "cancerDx", label: "암진단특약", kind: "lump", defaultAmount: 1e7, unitLabel: "진단 시", group: "cancer" },
  { id: "cancerSurg", label: "암수술특약", kind: "lump", defaultAmount: 1e7, unitLabel: "수술 시", group: "cancer" },
  { id: "cancerHosp", label: "암입원특약", kind: "daily", defaultAmount: 1e5, unitLabel: "1일당", group: "cancer" },
  { id: "stroke", label: "뇌출혈진단특약", kind: "lump", defaultAmount: 1e7, unitLabel: "진단 시", group: "ci" },
  { id: "ami", label: "급성심근경색증진단특약", kind: "lump", defaultAmount: 1e7, unitLabel: "진단 시", group: "ci" },
  { id: "hosp", label: "입원특약", kind: "daily", defaultAmount: 5e4, unitLabel: "1일당", group: "hosp" },
];

/** 특약 산출 기초: 연령별 탈퇴율(사망 + 소멸 사유)과 급부 발생률(lump: 발생률, daily: 연간 기대 입원일수) */
export interface RiderBasis { interest: number; exit: number[]; event: number[] }

/** 특약 계산기수. l_{x+1} = l_x(1 − exit_x), C_x = l_x·event_x·v^{t+½}. 납입 집단 = 급부 집단 */
export function riderCommutation(b: RiderBasis, age: number, n: number): Commutation {
  const v = 1 / (1 + b.interest), len = n + 1;
  const lx = new Array<number>(len); lx[0] = 100000;
  for (let t = 0; t < n; t++) lx[t + 1] = lx[t] * Math.max(0, 1 - (b.exit[age + t] ?? 0));
  const Dx = new Array<number>(len), Cx = new Array<number>(len);
  for (let t = 0; t < len; t++) { Dx[t] = lx[t] * v ** t; Cx[t] = lx[t] * (b.event[age + t] ?? 0) * v ** (t + 0.5); }
  const rev = (a: number[]) => { const out = new Array<number>(a.length); let s = 0; for (let t = a.length - 1; t >= 0; t--) { s += a[t]; out[t] = s; } return out; };
  const Nx = rev(Dx);
  return { n, v, lx, lxp: lx, Dx, Dpx: Dx, Cx, Wx: new Array<number>(len).fill(0), Nx, Npx: Nx };
}

/** 특약 보험료(기준금액 1단위당). 주계약과 같은 사업비 구조를 쓰고, 면책은 첫해 급부 배율로 반영 */
export function riderPremium(k: Commutation, age: number, payYears: number, freq: number, e: Expenses, waitFactor = 1): PremiumResult {
  const n = k.n;
  const S = new Array<number>(n).fill(1); if (n > 0) S[0] = waitFactor;
  const c: Contract = { age, termYears: n, payYears: Math.min(payYears, n), freq, S, C: new Array<number>(n + 1).fill(0) };
  const ex = e.model === "method" && n < 20 ? { ...e, alphaP: (e.alphaP * n) / 20 } : e;
  return premium(k, c, ex);
}
