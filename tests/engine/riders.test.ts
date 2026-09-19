import { describe, expect, it } from "vitest";
import { compute, getAssumption, riderCommutation, riderPremium, RIDERS, toBlocks } from "@/lib/engine";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import type { RateTable } from "@/lib/engine/types";
import { riderPremiums, riderTotal } from "@/lib/riders";
import { initialState, reducer } from "@/lib/state";

const cancer = cancerRates as RateTable, life = kli7 as RateTable;

describe("특약", () => {
  it("암진단특약: 사망 시 소멸(이중탈퇴)이라 사망 시 준비금을 주는 암보험 주계약보다 단위당 보험료가 낮고, 면책이 있으면 더 낮다", () => {
    const a = getAssumption("cancer-2026"), age = 40, n = 60;
    const q = life.M.q, inc = cancer.M.q;
    const exit = inc.map((v, i) => v + (q[i] ?? 0));
    const k = riderCommutation({ interest: a.interest, exit, event: inc }, age, n);
    const rider = riderPremium(k, age, 20, 12, a.expenses, 1);
    const main = compute({ sex: "M", age, payYears: 20, S0: 1e7, blocks: toBlocks(new Array(n).fill(1), age), waitFactor: 1 }, a, cancer);
    expect(rider.gross).toBeGreaterThan(0);
    expect(rider.gross).toBeLessThan(main.perUnit.gross);
    expect(riderPremium(k, age, 20, 12, a.expenses, 0.75).gross).toBeLessThan(rider.gross);
    expect(k.lx[n]).toBeLessThan(k.lx[0]); expect(k.lxp).toEqual(k.lx);   // 납입면제율 f = 0 → 납입 집단 = 급부 집단
  });
  it("상태: 특약 6종 기본 꺼짐, 켜고 금액을 바꾸면 보험료가 비례해 바뀌고 합계에 더해진다", () => {
    let s = initialState();
    expect(RIDERS.map((r) => r.id)).toEqual(["cancerDx", "cancerSurg", "cancerHosp", "stroke", "ami", "hosp"]);
    expect(Object.values(s.riders).every((r) => !r.on)).toBe(true);
    const rows0 = riderPremiums(s);
    expect(rows0.every((r) => r.monthly > 0)).toBe(true);
    expect(riderTotal(rows0)).toBe(0);
    s = reducer(s, { type: "rider", id: "cancerDx", patch: { on: true } });
    s = reducer(s, { type: "rider", id: "hosp", patch: { on: true, amount: 1e5 } });   // 1일당 10만원
    const rows = riderPremiums(s);
    const dx = rows.find((r) => r.id === "cancerDx")!, hosp = rows.find((r) => r.id === "hosp")!;
    expect(riderTotal(rows)).toBeCloseTo(dx.monthly + hosp.monthly, 6);
    expect(hosp.monthly).toBeCloseTo(rows0.find((r) => r.id === "hosp")!.monthly * 2, 6);   // 5만 → 10만
    const cancerProduct = reducer(reducer(initialState(), { type: "reset", product: "cancer" }), { type: "rider", id: "stroke", patch: { on: true } });
    expect(riderPremiums(cancerProduct).find((r) => r.id === "stroke")!.monthly).toBeGreaterThan(0);   // 암보험 가정으로 산출
    // 사망 담보가 아닌 특약은 주계약과 무관하게 100세 만기(40세 → 60년), 납입은 주계약(20년)
    expect(rows.every((r) => r.termYears === 60 && r.payYears === 20)).toBe(true);
    expect(riderPremiums(cancerProduct).every((r) => r.termYears === 60)).toBe(true);
    expect(hosp.monthly).toBeLessThan(dx.monthly * 20);   // 암입원율 × 365 일수 기준(제공 자료)
  });
});
