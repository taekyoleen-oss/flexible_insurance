import { describe, expect, it } from "vitest";
import { evaluatePlan, initialPlan, newCoverage, planReducer, sanitizePlan, selectedCoverage, waitFactorOf } from "@/lib/plan-state";
import { MAX_AGE, parseRateText, rateCoverage, rateCsv, RATE_PRESETS, toAgeArray } from "@/lib/plan-rates";

describe("위험률 시트 → 연령 배열", () => {
  it("표에 없는 나이는 앞 나이 값을 이어 쓴다(첫 나이 앞은 첫 값, 마지막 뒤는 마지막 값)", () => {
    const a = toAgeArray([40, 42, 45], [0.001, 0.002, 0.003]);
    expect(a[39]).toBe(0.001);      // 표 시작 전
    expect(a[40]).toBe(0.001);
    expect(a[41]).toBe(0.001);      // 빈 칸은 앞 값 유지
    expect(a[42]).toBe(0.002);
    expect(a[44]).toBe(0.002);
    expect(a[45]).toBe(0.003);
    expect(a[MAX_AGE]).toBe(0.003); // 표 끝 뒤
    expect(a).toHaveLength(MAX_AGE + 1);
  });
  it("빈 표는 전부 0", () => expect(toAgeArray([], []).every((x) => x === 0)).toBe(true));
  it("보장기간을 덮는지 알려준다", () => {
    const g = { ages: [40, 41, 42], event: [1, 1, 1], exit: [1, 1, 1] };
    expect(rateCoverage(g, 40, 42).ok).toBe(true);
    expect(rateCoverage(g, 40, 80)).toMatchObject({ ok: false, min: 40, max: 42 });
  });
});

describe("붙여넣기·업로드 파싱", () => {
  it("Excel 탭 구분 3열(연령·발생률·탈퇴율), 머리글은 건너뛴다", () => {
    const g = parseRateText("연령\t발생률\t탈퇴율\n40\t0.001\t0.0015\n41\t0.0011\t0.0017");
    expect(g.ages).toEqual([40, 41]);
    expect(g.event).toEqual([0.001, 0.0011]);
    expect(g.exit).toEqual([0.0015, 0.0017]);
  });
  it("CSV 2열이면 탈퇴율은 0, 천단위 쉼표와 %를 읽는다", () => {
    const g = parseRateText("40;0.12%\n41;0.15%");
    expect(g.exit).toEqual([0, 0]);
    expect(g.event[0]).toBeCloseTo(0.0012, 12);
  });
  it("숫자가 없으면 오류", () => expect(() => parseRateText("가\n나")).toThrow());
  it("CSV로 내보내면 다시 읽어 같은 값이 나온다", () => {
    const g = RATE_PRESETS[0].build("M", 40, 45);
    const back = parseRateText(rateCsv(g).replace("﻿", ""));
    expect(back.ages).toEqual(g.ages);
    expect(back.event).toEqual(g.event);
  });
});

describe("기존 표 불러오기", () => {
  it("제7회 사망률은 발생률 = 탈퇴율, 암발생률은 탈퇴율이 더 크다", () => {
    const k = RATE_PRESETS.find((p) => p.id === "kli7")!.build("M", 40, 60);
    expect(k.event).toEqual(k.exit);
    const c = RATE_PRESETS.find((p) => p.id === "cancer")!.build("M", 40, 60);
    expect(c.exit[0]).toBeGreaterThan(c.event[0]);
  });
  it("암입원은 연간 기대일수라 1보다 큰 값이 나온다", () => {
    const h = RATE_PRESETS.find((p) => p.id === "cancerHosp")!.build("M", 60, 61);
    expect(h.event[0]).toBeGreaterThan(0.5);
  });
});

describe("상품 만들기 상태", () => {
  it("기본 예시(2대질병 3천만원 80세 만기 20년납)에서 보험료가 나온다", () => {
    const s = initialPlan();
    const r = evaluatePlan(s);
    expect(r.standard.monthlyGross).toBeGreaterThan(0);
    expect(r.n).toBe(80 + 1 - 40);
    expect(r.benefit[0]).toBe(3e7);
    expect(r.coverages).toHaveLength(1);
  });
  it("면책 3개월 = 첫해 급부 3/4", () => {
    expect(waitFactorOf(3)).toBe(0.75);
    expect(waitFactorOf(0)).toBe(1);
  });
  it("담보를 더하면 보험료가 커지고, 마지막 하나는 지울 수 없다", () => {
    const s = initialPlan();
    const two = planReducer(s, { type: "addCoverage" });
    expect(two.coverages).toHaveLength(2);
    expect(evaluatePlan(two).standard.monthlyGross).toBeGreaterThan(evaluatePlan(s).standard.monthlyGross);
    const back = planReducer(two, { type: "removeCoverage", id: two.coverages[1].id });
    expect(back.coverages).toHaveLength(1);
    expect(planReducer(back, { type: "removeCoverage", id: back.coverages[0].id }).coverages).toHaveLength(1);
  });
  it("가입나이를 올리면 보장 종료 연령이 그보다 앞설 수 없다", () => {
    const s = planReducer(initialPlan(), { type: "contract", patch: { age: 85 } });
    expect(s.coverages[0].endAge).toBeGreaterThanOrEqual(85);
    expect(evaluatePlan(s).standard.monthlyGross).toBeGreaterThan(0);
  });
  it("저해지를 켜면 보험료가 내려간다", () => {
    const s = initialPlan();
    const low = planReducer(s, { type: "low", patch: { on: true } });
    expect(evaluatePlan(low).effective.monthlyGross).toBeLessThan(evaluatePlan(s).standard.monthlyGross);
  });
  it("증액·감액 구간을 넣으면 보장금액과 보험료가 따라간다", () => {
    const s = initialPlan();
    const id = s.coverages[0].id;
    const cut = planReducer(s, { type: "coverage", id, patch: { steps: [{ fromAge: 40, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: 80, multiple: 0.5 }] } });
    const r = evaluatePlan(cut);
    expect(r.benefit[0]).toBe(3e7);
    expect(r.benefit[20]).toBe(1.5e7);
    expect(r.standard.monthlyGross).toBeLessThan(evaluatePlan(s).standard.monthlyGross);
  });
  it("선택 담보는 목록에 없으면 첫 담보로 떨어진다", () => {
    const s = { ...initialPlan(), selected: "없는id" };
    expect(selectedCoverage(s)!.id).toBe(s.coverages[0].id);
  });
});

describe("저장값 검증", () => {
  it("쓰레기 값이 들어와도 기본값으로 살아난다", () => {
    const s = sanitizePlan({ age: "40", payYears: -5, interest: 99, coverages: [{ label: 123, amount: "x", grid: { ages: ["a"] } }], low: { on: "yes" } });
    expect(s.age).toBe(40);
    expect(s.payYears).toBe(1);
    expect(s.interest).toBe(0.2);
    expect(s.low.on).toBe(false);
    expect(s.coverages).toHaveLength(1);
    expect(evaluatePlan(s).standard.monthlyGross).toBeGreaterThanOrEqual(0);
  });
  it("정상 상태는 왕복해도 그대로", () => {
    const s = planReducer(initialPlan(), { type: "addCoverage" });
    const back = sanitizePlan(JSON.parse(JSON.stringify(s)));
    expect(back.coverages.map((c) => c.id)).toEqual(s.coverages.map((c) => c.id));
    expect(evaluatePlan(back).standard.monthlyGross).toBe(evaluatePlan(s).standard.monthlyGross);
  });
  it("담보는 12개까지", () => {
    const many = Array.from({ length: 30 }, () => newCoverage("M", 40));
    expect(sanitizePlan({ coverages: many }).coverages).toHaveLength(12);
  });
});
