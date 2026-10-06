import { describe, expect, it } from "vitest";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import { commutation } from "@/lib/engine/commutation";
import { premium } from "@/lib/engine/premium";
import { reserves } from "@/lib/engine/reserve";
import { surrender } from "@/lib/engine/surrender";
import type { Contract, ExpensesMethod } from "@/lib/engine/types";

const e: ExpensesMethod = { model: "method", alphaS: 0.01, alphaP: 1.0, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 };
const c: Contract = { age: 31, termYears: 59, payYears: 20, freq: 12, S: new Array(59).fill(1), C: new Array(60).fill(0) };
const r0 = (x: number) => Math.round(x * 1e5);
// 위험률은 2026-10-06 부터 가상 값(연령마다 약 ±5% — scripts/perturb-rates.mjs) — 아래 값은 그 표로 다시 낸 회귀 기준값이다

const k = commutation({ interest: 0.034, q: kli7.M.q, f: kli7.M.f }, 31, 59);
const p = premium(k, c, e);
const V = reserves(k, c, e, p).map(r0);                       // 10만원당 정수
const ks = commutation({ interest: 0.0325, q: kli7.M.qStd, f: kli7.M.fStd }, 31, 59);
const ps = premium(ks, c, e);
const Vs = reserves(ks, c, e, ps).map(r0);

describe("G1 준비금(10만원당)", () => {
  it("적용 1,168 · 3,623 · 6,233 · 13,488 · 31,545 · 47,060", () => {
    expect([V[1], V[3], V[5], V[10], V[20], V[40]]).toEqual([1168, 3623, 6233, 13488, 31545, 47060]);
  });
  it("표준 1,232 · 3,815 · 6,557 · 14,161 · 32,897 · 48,891, 표준 보험료 순 100 영업 140", () => {
    expect([Vs[1], Vs[3], Vs[5], Vs[10], Vs[20], Vs[40]]).toEqual([1232, 3815, 6557, 14161, 32897, 48891]);
    expect(r0(ps.net)).toBe(100); expect(r0(ps.gross)).toBe(140);
  });
  it("만기 이후 0", () => { expect(V[59]).toBe(0); });
});

describe("G1 해약환급금(1억)", () => {
  const units = 1000; // 1억 / 10만
  const alpha100k = Math.min(r0(p.alpha), r0(ps.alpha));
  const w = surrender(V, alpha100k, r0(p.gross), c.payYears, c.freq, units);
  it("신계약비는 적용·표준 중 작은 쪽 2,109", () => expect(alpha100k).toBe(2109));
  it("1년 0 · 2년 869,571 · 3년 2,417,857 · 5년 5,630,429 · 10년 13,488,000 · 20년 31,545,000", () => {
    expect([1, 2, 3, 5, 10, 20].map((t) => w.cash[t])).toEqual([0, 869571, 2417857, 5630429, 13488000, 31545000]);
  });
  it("환급률 27.2% · 50.5% · 98.8%", () => {
    expect(w.rate[2]).toBeCloseTo(0.272, 3); expect(w.rate[3]).toBeCloseTo(0.505, 3); expect(w.rate[20]).toBeCloseTo(0.988, 3);
  });
});
