import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planFromSpec, readSpecJson } from "@/lib/methoddoc-bridge";
import { planToSpec } from "@/lib/plan-doc";
import { evaluateProduct, PLAN_RECIPES } from "@/lib/plan-state";

/**
 * 다른 앱의 MethodSpec JSON → "상품 만들기" 설계 전체 (planFromSpec).
 *  ① 이 앱의 설계 → MethodSpec JSON → 다시 설계: 모든 레시피·남녀에서 보험료·담보·탭이 같다
 *  ② Life_ins_Doc_Convert_Studio 가 낸 JSON — 종신 샘플 조건에 사망률(남)·80% 이상 장해율(남) 표를 붙여넣고 [내보내기 → MethodSpec .json]
 *     (tests/fixtures/studio-whole.methodspec.json) → 이 앱의 종신 레시피와 같은 보험료
 */
const studio = () => readSpecJson(readFileSync(new URL("../fixtures/studio-whole.methodspec.json", import.meta.url), "utf8"));
const recipe = (id: string, sex: "M" | "F" = "M") => PLAN_RECIPES.find((r) => r.id === id)!.build(sex, 40);
const covs = (s: ReturnType<typeof recipe>) => s.tabs.map((t) => [t.name, t.coverages.map((c) => [c.label, c.kind, c.amount, c.endAge, c.waitMonths, c.steps, c.points])]);

describe("① 설계 → MethodSpec JSON → 설계", () => {
  it.each(PLAN_RECIPES.map((r) => r.id))("%s: 보험료·담보·탭·기초율이 같다", (id) => {
    for (const sex of ["M", "F"] as const) {
      const s = recipe(id, sex);
      const p = evaluateProduct(s);
      const { state, warnings } = planFromSpec(readSpecJson(JSON.stringify(planToSpec(s, p))));
      expect(warnings).toEqual([]);
      expect(evaluateProduct(state).effective.monthlyGross).toBeCloseTo(p.effective.monthlyGross, 6);
      expect(covs(state)).toEqual(covs(s));
      expect([state.sex, state.age, state.base.low, state.base.expenses, state.base.waiver]).toEqual([s.sex, s.age, s.base.low, s.base.expenses, s.base.waiver]);
    }
  });
});

describe("② Life_ins_Doc_Convert_Studio 의 MethodSpec JSON", () => {
  it("종신 샘플 + 위험률 표 → 이 앱의 종신 레시피와 같은 설계·보험료", () => {
    const { state, warnings } = planFromSpec(studio());
    expect(warnings).toEqual([]);
    expect(state.productName).toBe("종신보험");
    const [tab] = state.tabs;
    expect(tab.sheet.columns.map((c) => [c.name, c.kind, c.waiver])).toEqual([["제7회 경험생명표 사망률", "death", false], ["80% 이상 장해율", "incidence", false]]);
    expect([tab.sheet.ages[0], tab.sheet.ages[tab.sheet.ages.length - 1]]).toEqual([40, 110]);
    const c = tab.coverages[0];
    expect([c.label, c.kind, c.amount, c.endAge, c.exitColIds.length]).toEqual(["사망·80% 이상 장해", "death", 1e8, 110, 2]);
    const native = evaluateProduct(recipe("whole"));
    expect(evaluateProduct(state).effective.monthlyGross).toBeCloseTo(native.effective.monthlyGross, 6);
  });

  it("담보의 계약 단위(unit) 이름마다 탭을 만들고, 특약 시트에는 그 담보가 쓰는 위험률만", () => {
    const spec = studio();
    spec.benefits.push({ id: "b2", name: "80% 이상 장해 특약", unit: "특약1", role: "incidence", amount: 2e7, endAge: 80, rateId: "k80", exitRateIds: ["q", "k80"] });
    spec.rates.push({ id: "kc", name: "암발생률", role: "incidence" });      // 아무 담보도 안 쓰는 표 없는 위험률
    const { state, warnings } = planFromSpec(spec);
    expect(state.tabs.map((t) => t.name)).toEqual(["주계약", "특약1"]);
    expect(state.tabs[1].sheet.columns.map((c) => c.name)).toEqual(["제7회 경험생명표 사망률", "80% 이상 장해율"]);
    const rider = state.tabs[1].coverages[0];
    expect(rider.eventColId).toBe(state.tabs[1].sheet.columns[1].id);
    expect(warnings).toEqual([]);             // 특약이 여럿이면 쓰는 위험률만 옮겨서 표 없는 kc 는 경고도 없다
  });

  it("표가 없는 위험률은 0 으로 넣고 알린다 · 해지율은 열이 아니다 · 면책 일수는 개월로", () => {
    const spec = studio();
    delete spec.rates[1].table;
    spec.rates.push({ id: "w", name: "적용해지율", role: "lapse" });
    spec.benefits[0].waitDays = 90;
    const { state, warnings } = planFromSpec(spec);
    expect(warnings.join("\n")).toMatch(/80% 이상 장해율.*값 표가 없어 0/);
    expect(state.tabs[0].sheet.columns.map((c) => c.name)).toEqual(["제7회 경험생명표 사망률", "80% 이상 장해율"]);
    expect(state.tabs[0].sheet.columns[1].cells.every((x) => x === "0")).toBe(true);
    expect(state.tabs[0].coverages[0].waitMonths).toBe(3);
  });

  it("MethodSpec 이 아니면 거절한다", () => {
    expect(() => readSpecJson('{"a":1}')).toThrow(/MethodSpec/);
    expect(() => readSpecJson("[1,2]")).toThrow(/MethodSpec/);
  });
});
