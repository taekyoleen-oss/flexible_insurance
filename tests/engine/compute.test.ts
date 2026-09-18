import { describe, expect, it } from "vitest";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import { compute } from "@/lib/engine/compute";
import { ASSUMPTIONS, getAssumption } from "@/lib/engine/assumptions";
import { commutation } from "@/lib/engine/commutation";
import type { RateTable } from "@/lib/engine/types";

const table = kli7 as RateTable;
const cancerTable = cancerRates as RateTable;
const verify = getAssumption("verify-term-1504");

describe("compute G1 (verify-term-1504 세트, 1억, 정기 형태)", () => {
  const r = compute({ sex: "M", age: 31, payYears: 20, S0: 1e8, termYears: 59,
    blocks: [{ fromAge: 31, toAge: 89, multiple: 1, kind: "death" }] }, verify, table);
  it("월 영업보험료 133,000원, 순 93,000원, 총납입 31,920,000원", () => {
    expect(r.monthly.gross).toBe(133000);
    expect(r.monthly.net).toBe(93000);
    expect(r.totalPaid).toBe(31920000);
  });
  it("해약환급금 10년 13,417,000 · 20년 31,346,000", () => {
    expect(r.surrender.cash[10]).toBe(13417000);
    expect(r.surrender.cash[20]).toBe(31346000);
  });
  it("표준 준비금 10만원당 20년 33,086", () => expect(r.reserveStd100k[20]).toBe(33086));
  it("사업비 흐름: 길이 n, 0년차에 신계약비 포함", () => {
    expect(r.expenseFlow).toHaveLength(59);
    expect(r.expenseFlow[0]).toBeGreaterThan(r.expenseFlow[1]);
    expect(r.expenseFlow[25]).toBeCloseTo(0.001 * 1e8, 6); // 납입 후 β′·S0
  });
});

describe("G3 평준 스케줄 = 종신 공식 (사업비 0, 납입면제 OFF)", () => {
  const a = { ...ASSUMPTIONS[0], expenses: { model: "simple" as const, alpha: 0, beta: 0, gamma: 0 }, waiver: false };
  const r = compute({ sex: "M", age: 40, payYears: 20, S0: 1e8, blocks: [{ fromAge: 40, toAge: 109, multiple: 1, kind: "death" }] }, a, table);
  it("n = 110 − 40 = 70, 순 = 영업, PVB = Mx0 − Mx70", () => {
    expect(r.n).toBe(70);
    expect(r.perUnit.net).toBe(r.perUnit.gross);
    const k = commutation({ interest: a.interest, q: kli7.M.q, f: new Array(120).fill(0) }, 40, 70);
    const M = k.Cx.slice(0, 70).reduce((s, x) => s + x, 0);
    expect(r.perUnit.pvb).toBeCloseTo(M, 9);
    expect(r.perUnit.net).toBeCloseTo(M / r.perUnit.nStar, 15);
  });
});

describe("G4 정기 형태 = 정기 공식", () => {
  const a = { ...verify, expenses: { model: "simple" as const, alpha: 0, beta: 0, gamma: 0 } };
  const r = compute({ sex: "M", age: 31, payYears: 20, S0: 1e8, termYears: 59, blocks: [{ fromAge: 31, toAge: 89, multiple: 1, kind: "death" }] }, a, table);
  it("순보험료 = M*/N*", () => expect(r.perUnit.net).toBeCloseTo(16212.828499 / 17378602.403207, 12));
});

describe("저해지 70% (해지율 3%): 해지급부 현가로 보험료를 다시 산출한다", () => {
  const a = ASSUMPTIONS[0];
  const base = { sex: "M" as const, age: 40, payYears: 20, S0: 1e8, blocks: [{ fromAge: 40, toAge: 109, multiple: 1, kind: "death" as const }] };
  const r = compute({ ...base, lowSurrender: true }, a, table);
  const low = r.lowSurrender!;
  it("가정 세트는 환급률 70% · 적용해지율 3%", () => {
    expect(a.lowSurrender).toEqual({ ratio: 0.7, lapseRate: 0.03 });
    expect(low).toMatchObject({ ratio: 0.7, lapseRate: 0.03 });
  });
  it("보험료 인하율은 입력이 아니라 결과 — 해지급부 현가 CSV_0 > 0 이라야 내려간다", () => {
    expect(low.pvCsv).toBeGreaterThan(0);
    expect(low.gross100k).toBeLessThan(r.per100k.gross);
    expect(low.net100k).toBeLessThan(r.per100k.net);
    expect(low.deltaP100k).toBe(r.per100k.gross - low.gross100k);
    expect(low.premiumDiscount).toBeCloseTo(low.deltaP100k / r.per100k.gross, 12);
    expect(low.monthlyGross).toBe(low.gross100k * r.units);
  });
  it("해지율 0이면 표준형과 완전히 같다 (퇴화 검증)", () => {
    const z = compute({ ...base, lowSurrender: true }, { ...a, lowSurrender: { ratio: 0.7, lapseRate: 0 } }, table).lowSurrender!;
    expect(z.pvCsv).toBe(0);
    expect(z.gross100k).toBe(r.per100k.gross);
    expect(z.reserve100k).toEqual(r.reserve100k);
  });
  it("납입기간 중 준비금은 표준형보다 낮고, 납입 완료 후에는 정확히 같다", () => {
    for (const t of [2, 5, 10, 19]) expect(low.reserve100k[t]).toBeLessThan(r.reserve100k[t]);
    for (let t = 20; t <= r.n; t++) expect(low.reserve100k[t]).toBe(r.reserve100k[t]);
  });
  it("t < 20 환급금은 표준형 해약환급금의 70%, t ≥ 20은 표준과 같다", () => {
    for (const t of [1, 3, 5, 10, 19]) expect(low.cash[t]).toBe(Math.round(r.surrender.cash[t] * 0.7));
    for (const t of [20, 25, 40]) expect(low.cash[t]).toBe(r.surrender.cash[t]);
  });
  it("납입 누계·환급률은 인하된 보험료 기준이라 납입 완료 시점 환급률이 표준보다 높다", () => {
    expect(low.paid[20]).toBe(20 * 12 * low.gross100k * r.units);
    expect(low.rate[20]).toBeCloseTo(low.cash[20] / low.paid[20], 12);
    expect(low.rate[20]).toBeGreaterThan(r.surrender.rate[20]);
  });
});

describe("암보험 무해지 (환급률 0 · 해지율 3%)", () => {
  const a = getAssumption("cancer-2026");
  const inp = { sex: "M" as const, age: 40, payYears: 20, S0: 1e8, termYears: 60, blocks: [{ fromAge: 40, toAge: 99, multiple: 1, kind: "death" as const }] };
  const r = compute(inp, a, cancerTable);
  const low = compute({ ...inp, lowSurrender: true }, a, cancerTable).lowSurrender!;
  it("납입기간 중 해약환급금이 0", () => {
    expect(a.lowSurrender.ratio).toBe(0);
    for (let t = 0; t < 20; t++) expect(low.cash[t]).toBe(0);
    expect(low.cash[20]).toBe(r.surrender.cash[20]);
  });
  it("해지자에게 아무것도 주지 않으므로 저해지형보다 보험료가 더 내려간다", () => {
    expect(low.pvCsv).toBe(0);
    expect(low.gross100k).toBeLessThan(r.per100k.gross);
    expect(low.premiumDiscount).toBeGreaterThan(0.1);
  });
});

describe("G5 예산 역산 왕복", () => {
  const a = ASSUMPTIONS[0];
  const blocks = [{ fromAge: 40, toAge: 109, multiple: 1, kind: "death" as const }, { fromAge: 60, toAge: 109, multiple: 0.3, kind: "death" as const }];
  const r = compute({ sex: "F", age: 40, payYears: 20, S0: 1e8, blocks }, a, table);
  it("S0 → 월 보험료 → S0", () => {
    const budget = r.perUnit.gross * 1e8;
    expect(budget / r.perUnit.gross).toBeCloseTo(1e8, 3);
    expect(r.n).toBe(72);
  });
});
