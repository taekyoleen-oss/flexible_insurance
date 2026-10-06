import { describe, expect, it } from "vitest";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import summit from "@/tests/fixtures/rates-summit.json";
import { commutation } from "@/lib/engine/commutation";
import { expandBlocks, toBlocks } from "@/lib/engine/schedule";
import { premium } from "@/lib/engine/premium";
import type { Contract, ExpensesMethod } from "@/lib/engine/types";

const term1504: ExpensesMethod = { model: "method", alphaS: 0.01, alphaP: 1.0, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 };
const mutual: ExpensesMethod = { model: "method", alphaS: 0.01, alphaP: 1.0, betaS: 0.0004, betaG: 0.07, betaPrime: 0.0004, gamma: 0.04 };
const r0 = (x: number) => Math.round(x * 1e5);

describe("expandBlocks", () => {
  it("카드 → 연 벡터, 뒤 카드가 앞 카드를 덮는다", () => {
    const { S, C } = expandBlocks([
      { fromAge: 40, toAge: 109, multiple: 1, kind: "death" },
      { fromAge: 60, toAge: 109, multiple: 0.3, kind: "death" },
      { fromAge: 65, toAge: 65, multiple: 0.5, kind: "celebration" },
    ], 40, 70);
    expect(S).toHaveLength(70); expect(C).toHaveLength(71);
    expect(S[0]).toBe(1); expect(S[19]).toBe(1); expect(S[20]).toBe(0.3); expect(S[69]).toBe(0.3);
    expect(C[25]).toBe(0.5); expect(C[24]).toBe(0);
    expect(toBlocks(S, 40)).toEqual([
      { fromAge: 40, toAge: 59, multiple: 1, kind: "death" },
      { fromAge: 60, toAge: 109, multiple: 0.3, kind: "death" },
    ]);
  });
});

describe("G1 정기 31세 남 · 90세 만기 · 20년납 월납 · 3.4% · 경영인정기 1504", () => {
  const k = commutation({ interest: 0.034, q: kli7.M.q, f: kli7.M.f }, 31, 59);
  const c: Contract = { age: 31, termYears: 59, payYears: 20, freq: 12, S: new Array(59).fill(1), C: new Array(60).fill(0) };
  const p = premium(k, c, term1504);
  it("10만원당 순 94 · 기준연납 1,109 · 영업 133 · 신계약비 2,109", () => {
    expect(r0(p.net)).toBe(94);
    expect(r0(p.base)).toBe(1109);
    expect(r0(p.gross)).toBe(133);
    expect(r0(p.alpha)).toBe(2109);
  });
  it("β′ 포함 연납순보험료 1,174", () => expect(r0(p.pBeta)).toBe(1174));
  it("부가보험료 합 = 영업 − 순", () => {
    const L = p.loading; expect(L.alpha + L.betaS + L.betaPrime + L.betaG + L.gamma).toBeCloseTo(p.gross - p.net, 12);
  });
});

describe("G2 종신공제 59세 남 · 5년납 월납 · 3.5% · 2배(59~64)·1배·축하금 65세", () => {
  const k = commutation({ interest: 0.035, q: summit.M.q, f: summit.M.f }, 59, 51);
  const { S, C } = expandBlocks([
    { fromAge: 59, toAge: 109, multiple: 1, kind: "death" },
    { fromAge: 59, toAge: 64, multiple: 2, kind: "death" },
    { fromAge: 65, toAge: 65, multiple: 1, kind: "celebration" },
  ], 59, 51);
  const p = premium(k, { age: 59, termYears: 51, payYears: 5, freq: 12, S, C }, mutual);
  it("중간값 SUMX·N*·MaxANP", () => {
    expect(p.pvb).toBeCloseTo(127230.24884734, 4);
    expect(p.nStar).toBeCloseTo(5413118.70895496, 3);
    expect(p.base).toBeCloseTo(0.09644339, 8);
  });
  it("10만원당 순 2,350 · 영업 2,875 · 신계약비 10,644", () => {
    expect(r0(p.net)).toBe(2350);
    expect(r0(p.gross)).toBe(2875);
    expect(r0(p.alpha)).toBe(10644);
  });
});
