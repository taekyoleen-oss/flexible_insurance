import { describe, expect, it } from "vitest";
import {
  activeTab, autoExitCols, columnOrigin, evaluateProduct, initialPlan, overriddenKeys, planReducer, planSteps,
  PLAN_RECIPES, sanitizePlan, suggestEventCol, tabConditions, waitFactorOf, type PlanState,
} from "@/lib/plan-state";
import { MAX_AGE, parseRateText, rateCoverage, rateCsv, RATE_PRESETS, resolveSheet, toAgeArray, waiverCols } from "@/lib/plan-rates";
import { snippetsFor } from "@/lib/sheet-snippets";

const run = (s: PlanState) => evaluateProduct(s);
const main = (s: PlanState) => s.tabs[0];
const colOf = (s: PlanState, name: RegExp) => main(s).sheet.columns.find((c) => name.test(c.name))!;
const gross = (s: PlanState) => run(s).effective.monthlyGross;
const unitGross = (s: PlanState) => run(s).coverages[0].perUnit.gross;

describe("위험률 시트 → 연령 배열", () => {
  it("표에 없는 나이는 앞 나이 값을 이어 쓴다", () => {
    const a = toAgeArray([40, 42, 45], [0.001, 0.002, 0.003]);
    expect([a[39], a[40], a[41], a[42], a[44], a[45], a[MAX_AGE]]).toEqual([0.001, 0.001, 0.001, 0.002, 0.002, 0.003, 0.003]);
  });
  it("빈 표는 전부 0", () => expect(toAgeArray([], []).every((x) => x === 0)).toBe(true));
  it("보장기간을 덮는지 알려준다", () => {
    const s = initialPlan();
    expect(rateCoverage(main(s).sheet, 40, 80).ok).toBe(true);
    expect(rateCoverage(main(s).sheet, 40, 100)).toMatchObject({ ok: false, min: 40, max: 80 });
  });
});

describe("붙여넣기·업로드 파싱 (여러 열)", () => {
  it("머리글을 열 이름으로 쓰고 2열부터 전부 읽는다", () => {
    const t = parseRateText("연령\t사망률\t암발생률\t장해율\n40\t0.001\t0.0008\t0.0004\n41\t0.0011\t0.0009\t0.00045");
    expect(t.ages).toEqual([40, 41]);
    expect(t.columns.map((c) => c.name)).toEqual(["사망률", "암발생률", "장해율"]);
    expect(t.columns[1].cells).toEqual(["0.0008", "0.0009"]);
  });
  it("%·세미콜론을 읽는다", () => expect(Number(parseRateText("40;0.12%\n41;0.15%").columns[0].cells[0])).toBeCloseTo(0.0012, 12));
  it("숫자가 없으면 오류", () => expect(() => parseRateText("가\n나")).toThrow());
  it("CSV로 내보내면 계산된 값이 나온다", () => {
    const s = initialPlan();
    expect(rateCsv(main(s).sheet, resolveSheet(main(s).sheet)).split("\r\n")).toHaveLength(main(s).sheet.ages.length + 1);
  });
});

describe("기존 표 불러오기", () => {
  it("프리셋마다 유형·납입면제 표시가 붙는다", () => {
    const f = RATE_PRESETS.find((p) => p.id === "waiver")!;
    expect([f.kind, f.waiver]).toEqual(["other", true]);
    expect(RATE_PRESETS.find((p) => p.id === "kli7")!.kind).toBe("death");
    expect(RATE_PRESETS.find((p) => p.id === "cancerHosp")!.kind).toBe("recurring");
  });
  it("암입원은 연간 기대일수라 1보다 큰 값이 나온다", () => {
    expect(RATE_PRESETS.find((x) => x.id === "cancerHosp")!.values("M", [60])[0]).toBeGreaterThan(0.5);
  });
});

describe("시트 편집 (지금 탭)", () => {
  const s0 = initialPlan();
  it("칸에 수식을 넣고 아래로 채우면 앞 값이 이어진다", () => {
    const col = colOf(s0, /2대질병/);
    const b = planReducer(planReducer(s0, { type: "cell", colId: col.id, row: 1, value: "=D1" }), { type: "fillDown", colId: col.id, row: 1 });
    const cells = main(b).sheet.columns.find((c) => c.id === col.id)!.cells;
    expect(cells.slice(1, 4)).toEqual(["=D1", "=D2", "=D3"]);
    const vals = resolveSheet(main(b).sheet).byId[col.id];
    expect(vals[3]).toBe(vals[0]);
  });
  it("열을 지우면 담보 참조가 다시 잡힌다", () => {
    const inc = colOf(s0, /2대질병/);
    const c = planReducer(s0, { type: "removeColumn", colId: inc.id });
    expect(main(c).coverages[0].eventColId).not.toBe(inc.id);
    expect(gross(c)).toBeGreaterThan(0);
  });
  it("수식 열 레시피는 셀을 채운 채로 들어온다", () => {
    const a = planReducer(s0, { type: "addRecipeColumn", recipeId: "waiverFactor" });
    const col = main(a).sheet.columns[main(a).sheet.columns.length - 1];
    expect([col.waiver, col.cells[0]]).toEqual([true, "=B1*0.5"]);
    const r = resolveSheet(main(a).sheet);
    expect(r.byId[col.id][0]).toBeCloseTo(r.byId[main(a).sheet.columns[0].id][0] * 0.5, 12);
  });
  it("연령 범위를 늘리면 기존 입력은 그대로 남는다", () => {
    const col = colOf(s0, /사망/);
    const before = resolveSheet(main(s0).sheet).byId[col.id][0];
    const a = planReducer(s0, { type: "ageRange", from: 30, to: 90 });
    expect([main(a).sheet.ages[0], main(a).sheet.ages[main(a).sheet.ages.length - 1]]).toEqual([30, 90]);
    expect(resolveSheet(main(a).sheet).byId[col.id][10]).toBe(before);
  });
  it("여러 열 붙여넣기는 이름이 같으면 덮고 없으면 더한다", () => {
    const a = planReducer(s0, { type: "pasteTable", ages: [40, 41], columns: [{ name: main(s0).sheet.columns[0].name, cells: ["9", "9"] }, { name: "새 위험률", cells: ["1", "2"] }] });
    expect(main(a).sheet.ages).toEqual([40, 41]);
    expect(main(a).sheet.columns).toHaveLength(main(s0).sheet.columns.length + 1);
    expect(resolveSheet(main(a).sheet).byId[main(a).sheet.columns[0].id]).toEqual([9, 9]);
  });
});

describe("위험률 유형 ↔ 담보·납입면제 연결", () => {
  const s = initialPlan();
  it("진단형 담보의 탈퇴 = 사망 열 + 그 발생 열", () => {
    const inc = colOf(s, /2대질병/), death = colOf(s, /사망/);
    expect(autoExitCols(main(s).sheet, "incidence", inc.id)).toEqual([death.id, inc.id]);
  });
  it("일당형(반복지급)은 발생 열을 탈퇴에 넣지 않는다", () => {
    const a = planReducer(s, { type: "addColumn", presetId: "cancerHosp" });
    const rec = main(a).sheet.columns[main(a).sheet.columns.length - 1];
    expect(autoExitCols(main(a).sheet, "daily", rec.id)).not.toContain(rec.id);
    expect(suggestEventCol(main(a).sheet, "daily")).toBe(rec.id);
  });
  it("납입면제 열의 합이 f가 되고, 끄면 보험료가 내려간다", () => {
    expect(waiverCols(main(s).sheet)).toEqual([colOf(s, /납입면제/).id]);
    const off = planReducer(s, { type: "conditions", patch: { waiver: false } });
    expect(unitGross(s)).toBeGreaterThan(unitGross(off));
  });
  it("납입면제 열을 수식으로 만들어도 반영된다", () => {
    const f = colOf(s, /납입면제/), death = colOf(s, /사망/);
    let a = s;
    main(s).sheet.ages.forEach((_, i) => { a = planReducer(a, { type: "cell", colId: f.id, row: i, value: `=B${i + 1}*2` }); });
    const r = resolveSheet(main(a).sheet);
    expect(r.byId[f.id][0]).toBeCloseTo(r.byId[death.id][0] * 2, 12);
    expect(unitGross(a)).not.toBe(unitGross(s));
  });
});

describe("시트 탭 — 주계약 + 특약", () => {
  const s0 = initialPlan();
  it("처음에는 주계약 한 장", () => {
    expect(s0.tabs).toHaveLength(1);
    expect(s0.tabs[0].name).toBe("주계약");
    expect(activeTab(s0).id).toBe(s0.tabs[0].id);
  });
  it("특약을 더하면 주계약 시트를 복사해 오고 열 id는 새로 만든다", () => {
    const a = planReducer(s0, { type: "addTab" });
    expect(a.tabs).toHaveLength(2);
    expect(a.tabs[1].name).toBe("특약1");
    expect(a.active).toBe(a.tabs[1].id);
    expect(a.tabs[1].sheet.columns.map((c) => c.name)).toEqual(a.tabs[0].sheet.columns.map((c) => c.name));
    expect(a.tabs[1].sheet.columns.map((c) => c.id)).not.toEqual(a.tabs[0].sheet.columns.map((c) => c.id));
    for (const c of a.tabs[1].sheet.columns) expect(columnOrigin(a.tabs[0], a.tabs[1], c)).toBe("main-same");
  });
  it("특약은 주계약 조건을 물려받고, 고치면 그 탭만 달라진다", () => {
    const a = planReducer(s0, { type: "addTab" });
    expect(tabConditions(a, a.tabs[1]).interest).toBe(a.base.interest);
    expect(overriddenKeys(a.tabs[1])).toEqual([]);
    const b = planReducer(a, { type: "conditions", patch: { interest: 0.04 } });
    expect(tabConditions(b, b.tabs[1]).interest).toBe(0.04);
    expect(b.base.interest).toBe(a.base.interest);
    expect(overriddenKeys(b.tabs[1])).toEqual(["interest"]);
  });
  it("주계약 탭에서 고치면 base가 바뀌어 상속받는 특약도 따라간다", () => {
    const a = planReducer(planReducer(s0, { type: "addTab" }), { type: "selectTab", id: s0.tabs[0].id });
    const b = planReducer(a, { type: "conditions", patch: { interest: 0.04 } });
    expect(b.base.interest).toBe(0.04);
    expect(tabConditions(b, b.tabs[1]).interest).toBe(0.04);
  });
  it("되돌리면 다시 주계약 값을 쓴다", () => {
    const a = planReducer(planReducer(s0, { type: "addTab" }), { type: "conditions", patch: { payYears: 10 } });
    expect(tabConditions(a, a.tabs[1]).payYears).toBe(10);
    const b = planReducer(a, { type: "resetOverride", key: "payYears" });
    expect(overriddenKeys(b.tabs[1])).toEqual([]);
    expect(tabConditions(b, b.tabs[1]).payYears).toBe(b.base.payYears);
  });
  it("특약 시트를 고치면 '주계약과 다름'으로, 새 열은 '이 탭 전용'으로 표시된다", () => {
    const a = planReducer(s0, { type: "addTab" });
    const b = planReducer(a, { type: "cell", colId: a.tabs[1].sheet.columns[0].id, row: 0, value: "0.9" });
    expect(columnOrigin(b.tabs[0], b.tabs[1], b.tabs[1].sheet.columns[0])).toBe("main-changed");
    const c = planReducer(b, { type: "addColumn", presetId: "cancer" });
    expect(columnOrigin(c.tabs[0], c.tabs[1], c.tabs[1].sheet.columns[c.tabs[1].sheet.columns.length - 1])).toBe("own");
  });
  it("주계약 시트 복사로 되돌릴 수 있다", () => {
    const a = planReducer(s0, { type: "addTab" });
    const b = planReducer(a, { type: "cell", colId: a.tabs[1].sheet.columns[0].id, row: 0, value: "0.9" });
    const c = planReducer(b, { type: "copyMainSheet" });
    for (const col of c.tabs[1].sheet.columns) expect(columnOrigin(c.tabs[0], c.tabs[1], col)).toBe("main-same");
    expect(gross(c)).toBeGreaterThan(0);
  });
  it("합계 보험료 = 탭별 보험료의 합, 주계약은 지울 수 없다", () => {
    const a = planReducer(s0, { type: "addTab" });
    const p = run(a);
    expect(p.tabs).toHaveLength(2);
    expect(p.effective.monthlyGross).toBeCloseTo(p.tabs.reduce((x, t) => x + t.result.effective.monthlyGross, 0), 6);
    expect(gross(a)).toBeGreaterThan(gross(s0));
    expect(planReducer(a, { type: "removeTab", id: a.tabs[0].id }).tabs).toHaveLength(2);
    expect(planReducer(a, { type: "removeTab", id: a.tabs[1].id }).tabs).toHaveLength(1);
  });
  it("탭마다 보험기간이 다르면 전체 기간은 가장 긴 쪽", () => {
    const a = planReducer(s0, { type: "addTab" });
    const b = planReducer(a, { type: "coverage", id: a.tabs[1].coverages[0].id, patch: { endAge: 100 } });
    const p = run(b);
    expect(p.n).toBe(100 + 1 - b.age);
    expect(p.benefit).toHaveLength(p.n);
  });
  it("주계약은 첫 자리 고정", () => {
    const a = planReducer(s0, { type: "addTab" });
    expect(planReducer(a, { type: "moveTab", id: a.tabs[0].id, dir: 1 }).tabs[0].id).toBe(a.tabs[0].id);
  });
  it("이름을 바꿀 수 있다", () => {
    const a = planReducer(s0, { type: "addTab" });
    expect(planReducer(a, { type: "renameTab", id: a.tabs[1].id, name: "암입원특약" }).tabs[1].name).toBe("암입원특약");
  });
});

describe("상품 만들기 상태", () => {
  it("기본 예시에서 보험료가 나온다", () => {
    const p = run(initialPlan());
    expect(p.effective.monthlyGross).toBeGreaterThan(0);
    expect(p.n).toBe(80 + 1 - 40);
    expect(p.benefit[0]).toBe(3e7);
  });
  it("면책 3개월 = 첫해 급부 3/4", () => expect(waitFactorOf(3)).toBe(0.75));
  it("담보를 더하면 보험료가 커지고, 마지막 하나는 지울 수 없다", () => {
    const s = initialPlan();
    const two = planReducer(s, { type: "addCoverage", kind: "death" });
    expect(activeTab(two).coverages).toHaveLength(2);
    expect(gross(two)).toBeGreaterThan(gross(s));
    const back = planReducer(two, { type: "removeCoverage", id: activeTab(two).coverages[1].id });
    expect(planReducer(back, { type: "removeCoverage", id: activeTab(back).coverages[0].id }).tabs[0].coverages).toHaveLength(1);
  });
  it("저해지를 켜면 보험료가 내려간다", () => {
    const s = initialPlan();
    const low = planReducer(s, { type: "conditions", patch: { low: { on: true, ratio: 0.7, lapseRate: 0.03 } } });
    expect(gross(low)).toBeLessThan(gross(s));
  });
  it("증액·감액 구간이 보장금액과 보험료에 반영된다", () => {
    const s = initialPlan();
    const cut = planReducer(s, { type: "coverage", id: main(s).coverages[0].id, patch: { steps: [{ fromAge: 40, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: 80, multiple: 0.5 }] } });
    expect(run(cut).benefit[20]).toBe(1.5e7);
    expect(gross(cut)).toBeLessThan(gross(s));
  });
  it("암 레시피는 주계약 + 특약 2탭으로 온다", () => {
    const s = PLAN_RECIPES.find((r) => r.id === "cancerSet")!.build("M", 40);
    expect(s.tabs.map((t) => t.name)).toEqual(["주계약", "특약1 암입원"]);
    expect(gross(s)).toBeGreaterThan(0);
  });
});

describe("단계 카드", () => {
  it("기본 상태에서는 모두 완료", () => {
    const s = initialPlan();
    const steps = planSteps(s, run(s));
    expect(steps.map((x) => x.code)).toEqual(["M01", "M02", "M03", "M04", "M05", "C01", "M06", "M07"]);
    expect(steps.every((x) => x.status === "done")).toBe(true);
  });
  it("특약이 조건을 덮으면 그 단계에 표시가 붙는다", () => {
    const a = planReducer(planReducer(initialPlan(), { type: "addTab" }), { type: "conditions", patch: { interest: 0.04 } });
    expect(planSteps(a, run(a)).find((x) => x.code === "M03")!.overridden).toBe(true);
  });
  it("납입면제 열을 모두 끄면 M05가 오류", () => {
    let s = initialPlan();
    for (const c of main(s).sheet.columns) s = planReducer(s, { type: "column", colId: c.id, patch: { waiver: false } });
    expect(planSteps(s, run(s)).find((x) => x.code === "M05")!.status).toBe("error");
  });
  it("시트 수식 오류가 있으면 M04가 칸 위치를 알려준다", () => {
    const s0 = initialPlan();
    const s = planReducer(s0, { type: "cell", colId: main(s0).sheet.columns[0].id, row: 2, value: "=1/0" });
    const m04 = planSteps(s, run(s)).find((x) => x.code === "M04")!;
    expect([m04.status, m04.message]).toEqual(["error", "B3 칸: #DIV/0!"]);
  });
});

describe("수식 추천", () => {
  it("고른 칸에 맞춰 실제 열 문자로 만들어 준다", () => {
    const s = initialPlan();
    const tips = snippetsFor({ sheet: main(s).sheet, col: main(s).sheet.columns[2], colIdx: 2, row: 3 });
    expect(tips.find((t) => t.id === "carry")!.formula).toBe("=D3");
    expect(tips.find((t) => t.id === "copy")!.formula).toBe("=B4");
    expect(tips.some((t) => t.formula.includes("IF("))).toBe(true);
  });
  it("첫 행에서는 앞 행 이어받기를 권하지 않는다", () => {
    const s = initialPlan();
    expect(snippetsFor({ sheet: main(s).sheet, col: main(s).sheet.columns[0], colIdx: 0, row: 0 }).some((t) => t.id === "carry")).toBe(false);
  });
});

describe("저장값 검증", () => {
  it("쓰레기 값이 들어와도 기본값으로 살아난다", () => {
    const s = sanitizePlan({ age: "40", base: { payYears: -5, interest: 99 }, tabs: [{ sheet: { ages: ["a"] }, coverages: [{ label: 123 }] }] });
    expect(s.age).toBe(40);
    expect(s.base.payYears).toBe(1);
    expect(s.base.interest).toBe(0.2);
    expect(s.tabs[0].sheet.columns.length).toBeGreaterThan(0);
    expect(gross(s)).toBeGreaterThanOrEqual(0);
  });
  it("정상 상태는 왕복해도 그대로", () => {
    const s = planReducer(planReducer(initialPlan(), { type: "addTab" }), { type: "conditions", patch: { interest: 0.04 } });
    const back = sanitizePlan(JSON.parse(JSON.stringify(s)));
    expect(back.tabs.map((t) => t.name)).toEqual(s.tabs.map((t) => t.name));
    expect(overriddenKeys(back.tabs[1])).toEqual(["interest"]);
    expect(gross(back)).toBe(gross(s));
  });
  it("탭이 없는 v2 저장본도 주계약 한 장으로 읽는다", () => {
    const v2 = { version: 2, productName: "옛 저장본", age: 40, sex: "M", payYears: 20, interest: 0.03,
      sheet: { ages: [40, 41], columns: [{ id: "a", name: "사망률", kind: "death", waiver: false, cells: ["0.001", "0.0011"] }] },
      coverages: [{ id: "c1", label: "사망", kind: "death", amount: 1e8, endAge: 60, eventColId: "a", exitColIds: ["a"] }] };
    const s = sanitizePlan(v2);
    expect(s.version).toBe(3);
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].name).toBe("주계약");
    expect(s.base.interest).toBe(0.03);
    expect(s.tabs[0].coverages[0].label).toBe("사망");
    expect(gross(s)).toBeGreaterThan(0);
  });
  it("주계약 탭에는 overrides 가 남지 않는다", () => {
    const s = sanitizePlan({ ...initialPlan(), tabs: [{ ...initialPlan().tabs[0], overrides: { interest: 0.09 } }] });
    expect(overriddenKeys(s.tabs[0])).toEqual([]);
  });
});
