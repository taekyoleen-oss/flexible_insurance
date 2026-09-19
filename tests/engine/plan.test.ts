import { describe, expect, it } from "vitest";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import { compute } from "@/lib/engine/compute";
import { getAssumption } from "@/lib/engine/assumptions";
import { computePlan, planTermYears, stepMultiple, type PlanCoverage, type PlanInput } from "@/lib/engine/plan";
import type { RateTable } from "@/lib/engine/types";

const table = kli7 as RateTable;
const a = getAssumption("verify-term-1504");
const q = table.M.q, f = table.M.f;
const AGE = 31, TERM = 59, PAY = 20, S0 = 1e8;

/** compute()는 표준준비금·표준 신계약비에 표준위험률을 쓰고, 일반 상품 산출기는 표준위험률이 없어 적용위험률을 쓴다
 *  (산출방법서 §1.2 나 "표준위험률이 없는 경우 적용위험률"). 두 경로를 비교하려고 표준위험률을 적용위험률로 맞춘 표 */
const same: RateTable = { ...table, M: { ...table.M, qStd: q, fStd: f } };

const base: PlanInput = {
  age: AGE, termYears: TERM, payYears: PAY, freq: 12,
  interest: a.interest, standardInterest: a.standardInterest,
  waiverRate: f, expenses: a.expenses,
};
const cov = (over: Partial<PlanCoverage> = {}): PlanCoverage => ({
  id: "c1", label: "담보", kind: "death", amount: S0, event: q, exit: q,
  endAge: AGE + TERM - 1, waitFactor: 1, steps: [], points: [], ...over,
});

describe("일반 상품 산출기: 사망형 담보 1개 = 설계형 compute()", () => {
  const r = compute({ sex: "M", age: AGE, payYears: PAY, S0, termYears: TERM, waiver: true,
    blocks: [{ fromAge: AGE, toAge: AGE + TERM - 1, multiple: 1, kind: "death" }] }, a, same);
  const p = computePlan(base, [cov()]);
  const c = p.coverages[0];
  it("10만원당 보험료·신계약비가 같다", () => {
    expect(c.per100k).toEqual(r.per100k);
    expect(p.standard.monthlyGross).toBe(r.monthly.gross);
    expect(p.standard.monthlyNet).toBe(r.monthly.net);
    expect(p.standard.totalPaid).toBe(r.totalPaid);
  });
  it("준비금·해약환급금·환급률이 같다", () => {
    expect(c.reserve).toEqual(r.surrender.reserve);
    expect(p.standard.cash).toEqual(r.surrender.cash);
    expect(p.standard.deduction).toEqual(r.surrender.deduction);
    expect(p.standard.rate).toEqual(r.surrender.rate);
  });
  it("연도별 보장금액이 같다", () => {
    expect(p.benefit).toEqual(r.S.map((m) => m * S0));
    expect(p.n).toBe(r.n);
  });
});

describe("급부 유형", () => {
  it("진단형: 탈퇴 = 사망 + 발생이라 같은 발생률의 사망형보다 보험료가 낮다", () => {
    const inc = q.map((x) => x * 0.4);
    const dx = computePlan(base, [cov({ kind: "incidence", event: inc, exit: q.map((x, i) => x + inc[i]) })]);
    const dn = computePlan(base, [cov({ kind: "death", exit: inc })]);   // 같은 발생률을 사망률로 쓴 경우
    expect(dx.standard.monthlyGross).toBeLessThan(dn.standard.monthlyGross);
    expect(dx.standard.monthlyGross).toBeGreaterThan(0);
  });
  it("진단형: 면책계수가 낮으면 첫해 급부가 줄어 보험료가 내려간다", () => {
    const inc = q.map((x) => x * 0.4), exit = q.map((x, i) => x + inc[i]);
    const full = computePlan(base, [cov({ kind: "incidence", event: inc, exit })]);
    const wait = computePlan(base, [cov({ kind: "incidence", event: inc, exit, waitFactor: 0.75 })]);
    expect(wait.coverages[0].perUnit.pvb).toBeLessThan(full.coverages[0].perUnit.pvb);
    expect(wait.coverages[0].perUnit.net).toBeLessThan(full.coverages[0].perUnit.net);
  });
  it("일당형: 보장금액(1일당)에 비례하고, 연간 기대일수가 2배면 보험료도 2배", () => {
    const days = q.map(() => 3);
    const one = computePlan(base, [cov({ kind: "daily", amount: 1e5, event: days, exit: q })]);
    const two = computePlan(base, [cov({ kind: "daily", amount: 1e5, event: days.map((d) => d * 2), exit: q })]);
    expect(one.coverages[0].per100k.net).toBeGreaterThan(0);
    expect(two.coverages[0].perUnit.net).toBeCloseTo(one.coverages[0].perUnit.net * 2, 12);
  });
  it("생존형: 만기 직전 준비금이 지급액의 현가, 지급 후에는 0", () => {
    const amount = 1e7, n = 20;
    const p = computePlan({ ...base, termYears: n, payYears: n },
      [cov({ kind: "survival", amount, endAge: AGE + n - 1, points: [{ age: AGE + n, multiple: 1 }] })]);
    const v = 1 / (1 + a.interest);
    expect(p.coverages[0].reserve[n - 1]).toBeGreaterThan(amount * v * 0.9);
    expect(p.coverages[0].reserve[n - 1]).toBeLessThan(amount * v);
    expect(p.coverages[0].reserve[n]).toBe(0);
    expect(p.survival[n]).toBe(amount);
  });
});

describe("보험금 증액·감액", () => {
  const steps = [{ fromAge: AGE, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: AGE + TERM - 1, multiple: 0.5 }];
  const flat = computePlan(base, [cov()]);
  const cut = computePlan(base, [cov({ steps })]);
  it("구간 배수가 연도별 보장금액에 그대로 나온다", () => {
    expect(stepMultiple(steps, 45)).toBe(1);
    expect(stepMultiple(steps, 60)).toBe(0.5);
    expect(cut.benefit[0]).toBe(S0);
    expect(cut.benefit[60 - AGE]).toBe(S0 * 0.5);
  });
  it("60세 이후 반으로 줄이면 보험료·준비금이 낮아진다", () => {
    expect(cut.standard.monthlyGross).toBeLessThan(flat.standard.monthlyGross);
    expect(cut.standard.reserve[PAY]).toBeLessThan(flat.standard.reserve[PAY]);
  });
  it("구간을 비우면 전 기간 1.0", () => expect(stepMultiple([], 70)).toBe(1));
});

describe("담보 합산", () => {
  const inc = q.map((x) => x * 0.4);
  const two: PlanCoverage[] = [
    cov({ id: "a", label: "사망", amount: 5e7 }),
    cov({ id: "b", label: "2대질병", kind: "incidence", amount: 3e7, event: inc, exit: q.map((x, i) => x + inc[i]), endAge: 79 }),
  ];
  const p = computePlan(base, two);
  it("합계 보험료 = 담보별 보험료의 합", () => {
    const sum = p.coverages.reduce((s, c) => s + c.monthlyGross, 0);
    expect(p.standard.monthlyGross).toBe(sum);
    expect(p.coverages.map((c) => c.label)).toEqual(["사망", "2대질병"]);
  });
  it("담보마다 보장기간이 다르면 끝난 담보는 0이 되고 합계는 계약 기간 전체", () => {
    expect(p.n).toBe(TERM);
    expect(p.coverages[1].n).toBe(79 + 1 - AGE);
    expect(p.coverages[1].benefit[79 - AGE]).toBe(3e7);
    expect(p.coverages[1].benefit[80 - AGE]).toBe(0);
    expect(p.benefit[0]).toBe(8e7);
    expect(p.benefit[80 - AGE]).toBe(5e7);
  });
  it("계약 보험기간은 가장 늦게 끝나는 담보 기준", () => expect(planTermYears(AGE, two)).toBe(TERM));
});

describe("저해지·무해지", () => {
  const low = { ratio: 0.7, lapseRate: 0.03 };
  const p = computePlan({ ...base, lowSurrender: low }, [cov()]);
  const std = computePlan(base, [cov()]);
  it("해지율 0이면 표준형과 완전히 같다", () => {
    const z = computePlan({ ...base, lowSurrender: { ratio: 0.7, lapseRate: 0 } }, [cov()]);
    expect(z.low!.pvCsv).toBe(0);
    expect(z.effective.monthlyGross).toBe(std.standard.monthlyGross);
    expect(z.effective.reserve).toEqual(std.standard.reserve);
  });
  it("보험료가 내려가고 인하율은 결과값", () => {
    expect(p.low!.monthlyGross).toBeLessThan(std.standard.monthlyGross);
    expect(p.low!.premiumDiscount).toBeGreaterThan(0);
    expect(p.effective).toBe(p.low);
  });
  it("납입 완료 후 준비금·환급금이 표준형과 같아진다", () => {
    for (let t = PAY; t <= p.n; t++) expect(p.low!.reserve[t]).toBe(std.standard.reserve[t]);
    expect(p.low!.cash[PAY]).toBe(std.standard.cash[PAY]);
    expect(p.low!.cash[5]).toBe(Math.round(std.standard.cash[5] * 0.7));
  });
  it("무해지(ratio 0)는 납입기간 중 환급금이 0", () => {
    const z = computePlan({ ...base, lowSurrender: { ratio: 0, lapseRate: 0.03 } }, [cov()]);
    for (let t = 0; t < PAY; t++) expect(z.low!.cash[t]).toBe(0);
    expect(z.low!.monthlyGross).toBeLessThan(p.low!.monthlyGross);
  });
});
