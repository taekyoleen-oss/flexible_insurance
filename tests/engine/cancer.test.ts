import { describe, expect, it } from "vitest";
import { compute, getAssumption, toBlocks } from "@/lib/engine";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import type { RateTable } from "@/lib/engine/types";
import { CANCER_TABLE, initialState, reducer, termOf, tableOf } from "@/lib/state";

const table = cancerRates as RateTable;

describe("암보험 (사망 시 책임준비금 지급형)", () => {
  it("위험률표: 암발생률, 사망률 없음, terminal 100 → 40세 가입 60년 만기", () => {
    expect(table.meta.terminal).toEqual({ M: 100, F: 100 });
    expect(table.M.q[40]).toBeCloseTo(0.002657, 9); expect(table.F.q[40]).toBeCloseTo(0.005681, 9);   // 경험생명표(가상)
    expect(table.M.q[110]).toBe(table.M.q[109]); expect(table.F.q[111]).toBeCloseTo(0.0144, 9);
    expect(table.M.f.every((v) => v === 0)).toBe(true);
    const s = reducer(initialState(), { type: "reset", product: "cancer" });
    expect(s.profile.product).toBe("cancer"); expect(termOf(s.profile)).toBe(60); expect(tableOf(s.profile)).toBe(CANCER_TABLE);
    expect(s.settings.assumption.id).toBe("cancer-2026"); expect(s.waiver).toBe(false);
  });
  it("준비금 점화식: V_{t+1} = (V_t + P − S_t·i_x·v^½) / ((1 − i_x)·v) — 사망 항이 없다(사망 시 준비금 지급과 동치)", () => {
    const a = { ...getAssumption("cancer-2026"), expenses: { model: "simple" as const, alpha: 0, beta: 0, gamma: 0 }, waitFactor: 1 };
    const age = 40, n = 60, S0 = 1e8;
    const r = compute({ sex: "M", age, payYears: 20, freq: 1, S0, blocks: toBlocks(new Array(n).fill(1), age) }, a, table);
    expect(r.n).toBe(60);
    const v = 1 / (1 + a.interest), P = r.perUnit.pBeta;   // 연납 순보험료(1단위)
    const V = r.perUnit ? r.reserve100k.map((x) => x / 1e5) : [];
    for (let t = 0; t < n - 1; t++) {
      const q = table.M.q[age + t];
      const next = (V[t] + (t < 20 ? P : 0) - 1 * q * Math.sqrt(v)) / ((1 - q) * v);
      expect(next).toBeCloseTo(V[t + 1], 4);
    }
    expect(V[n]).toBeCloseTo(0, 6);   // 만기급부 없음
  });
  it("면책계수: 첫해 급부 3/4 → 보험료가 그만큼 낮고, 표시용 S는 그대로", () => {
    const a = getAssumption("cancer-2026");
    const inp = { sex: "F" as const, age: 40, payYears: 20, S0: 1e8, blocks: toBlocks(new Array(60).fill(1), 40) };
    const full = compute({ ...inp, waitFactor: 1 }, a, table), wait = compute(inp, a, table);
    expect(wait.monthly.gross).toBeLessThan(full.monthly.gross);
    expect(wait.S[0]).toBe(1);
    expect(wait.monthly.gross).toBeGreaterThan(0);
  });
});
