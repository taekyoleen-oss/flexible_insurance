import { describe, expect, it } from "vitest";
import {
  autoExitCols, evaluatePlan, initialPlan, planReducer, planSteps, sanitizePlan, suggestEventCol, waitFactorOf,
  type PlanState,
} from "@/lib/plan-state";
import { MAX_AGE, parseRateText, rateCoverage, rateCsv, RATE_PRESETS, resolveSheet, toAgeArray, waiverCols } from "@/lib/plan-rates";
import { snippetsFor } from "@/lib/sheet-snippets";

const run = (s: PlanState) => evaluatePlan(s);
const colOf = (s: PlanState, name: RegExp) => s.sheet.columns.find((c) => name.test(c.name))!;

describe("위험률 시트 → 연령 배열", () => {
  it("표에 없는 나이는 앞 나이 값을 이어 쓴다(첫 나이 앞은 첫 값, 마지막 뒤는 마지막 값)", () => {
    const a = toAgeArray([40, 42, 45], [0.001, 0.002, 0.003]);
    expect([a[39], a[40], a[41], a[42], a[44], a[45], a[MAX_AGE]]).toEqual([0.001, 0.001, 0.001, 0.002, 0.002, 0.003, 0.003]);
    expect(a).toHaveLength(MAX_AGE + 1);
  });
  it("빈 표는 전부 0", () => expect(toAgeArray([], []).every((x) => x === 0)).toBe(true));
  it("보장기간을 덮는지 알려준다", () => {
    const s = initialPlan();
    expect(rateCoverage(s.sheet, 40, 80).ok).toBe(true);
    expect(rateCoverage(s.sheet, 40, 100)).toMatchObject({ ok: false, min: 40, max: 80 });
  });
});

describe("붙여넣기·업로드 파싱 (여러 열)", () => {
  it("머리글을 열 이름으로 쓰고 2열부터 전부 읽는다", () => {
    const t = parseRateText("연령\t사망률\t암발생률\t장해율\n40\t0.001\t0.0008\t0.0004\n41\t0.0011\t0.0009\t0.00045");
    expect(t.ages).toEqual([40, 41]);
    expect(t.columns.map((c) => c.name)).toEqual(["사망률", "암발생률", "장해율"]);
    expect(t.columns[1].cells).toEqual(["0.0008", "0.0009"]);
  });
  it("쉼표·세미콜론·%·천단위 쉼표를 읽는다", () => {
    const t = parseRateText("40;0.12%\n41;0.15%");
    expect(Number(t.columns[0].cells[0])).toBeCloseTo(0.0012, 12);
  });
  it("숫자가 없으면 오류", () => expect(() => parseRateText("가\n나")).toThrow());
  it("CSV로 내보내면 계산된 값이 나온다", () => {
    const s = initialPlan();
    const csv = rateCsv(s.sheet, resolveSheet(s.sheet));
    expect(csv.split("\r\n")[0]).toContain("연령");
    expect(csv.split("\r\n")).toHaveLength(s.sheet.ages.length + 1);
  });
});

describe("기존 표 불러오기", () => {
  it("프리셋마다 유형·납입면제 표시가 붙는다", () => {
    const f = RATE_PRESETS.find((p) => p.id === "waiver")!;
    expect(f.kind).toBe("other");
    expect(f.waiver).toBe(true);
    expect(RATE_PRESETS.find((p) => p.id === "kli7")!.kind).toBe("death");
    expect(RATE_PRESETS.find((p) => p.id === "cancerHosp")!.kind).toBe("recurring");
  });
  it("암입원은 연간 기대일수라 1보다 큰 값이 나온다", () => {
    const p = RATE_PRESETS.find((x) => x.id === "cancerHosp")!;
    expect(p.values("M", [60])[0]).toBeGreaterThan(0.5);
  });
});

describe("시트 편집", () => {
  const s0 = initialPlan();
  it("칸에 수식을 넣고 아래로 채우면 앞 값이 이어진다", () => {
    const col = colOf(s0, /2대질병/);
    const a = planReducer(s0, { type: "cell", colId: col.id, row: 1, value: "=D1" });
    const b = planReducer(a, { type: "fillDown", colId: col.id, row: 1 });
    const cells = b.sheet.columns.find((c) => c.id === col.id)!.cells;
    expect(cells.slice(1, 4)).toEqual(["=D1", "=D2", "=D3"]);
    const vals = resolveSheet(b.sheet).byId[col.id];
    expect(vals[3]).toBe(vals[0]);       // 전부 첫 행 값으로 평탄해진다
  });
  it("열을 더하고 지울 수 있고, 지우면 담보 참조가 다시 잡힌다", () => {
    const a = planReducer(s0, { type: "addColumn", presetId: "cancer" });
    expect(a.sheet.columns).toHaveLength(s0.sheet.columns.length + 1);
    const inc = colOf(s0, /2대질병/);
    const b = planReducer(a, { type: "coverage", id: a.coverages[0].id, patch: { eventColId: inc.id } });
    const c = planReducer(b, { type: "removeColumn", colId: inc.id });
    expect(c.coverages[0].eventColId).not.toBe(inc.id);
    expect(c.coverages[0].exitColIds).not.toContain(inc.id);
    expect(run(c).result.standard.monthlyGross).toBeGreaterThan(0);
  });
  it("수식 열 레시피는 셀을 채운 채로 들어온다", () => {
    const a = planReducer(s0, { type: "addRecipeColumn", recipeId: "waiverFactor" });
    const col = a.sheet.columns[a.sheet.columns.length - 1];
    expect(col.waiver).toBe(true);
    expect(col.cells[0]).toBe("=B1*0.5");
    const vals = resolveSheet(a.sheet).byId[col.id];
    expect(vals[0]).toBeCloseTo(resolveSheet(a.sheet).byId[a.sheet.columns[0].id][0] * 0.5, 12);
  });
  it("연령 범위를 늘리면 기존 입력은 그대로 남는다", () => {
    const col = colOf(s0, /사망/);
    const before = resolveSheet(s0.sheet).byId[col.id][0];
    const a = planReducer(s0, { type: "ageRange", from: 30, to: 90 });
    expect(a.sheet.ages[0]).toBe(30);
    expect(a.sheet.ages[a.sheet.ages.length - 1]).toBe(90);
    expect(resolveSheet(a.sheet).byId[col.id][10]).toBe(before);   // 40세 행이 그대로
  });
  it("여러 열 붙여넣기는 이름이 같으면 덮고 없으면 더한다", () => {
    const a = planReducer(s0, { type: "pasteTable", ages: [40, 41], columns: [{ name: s0.sheet.columns[0].name, cells: ["9", "9"] }, { name: "새 위험률", cells: ["1", "2"] }] });
    expect(a.sheet.ages).toEqual([40, 41]);
    expect(a.sheet.columns).toHaveLength(s0.sheet.columns.length + 1);
    expect(resolveSheet(a.sheet).byId[a.sheet.columns[0].id]).toEqual([9, 9]);
  });
});

describe("위험률 유형 ↔ 담보·납입면제 연결", () => {
  const s = initialPlan();
  it("진단형 담보의 탈퇴 = 사망 열 + 그 발생 열", () => {
    const inc = colOf(s, /2대질병/), death = colOf(s, /사망/);
    expect(autoExitCols(s.sheet, "incidence", inc.id)).toEqual([death.id, inc.id]);
  });
  it("일당형(반복지급)은 발생 열을 탈퇴에 넣지 않는다", () => {
    const a = planReducer(s, { type: "addColumn", presetId: "cancerHosp" });
    const rec = a.sheet.columns[a.sheet.columns.length - 1];
    expect(autoExitCols(a.sheet, "daily", rec.id)).not.toContain(rec.id);
    expect(suggestEventCol(a.sheet, "daily")).toBe(rec.id);
  });
  it("납입면제 열의 합이 f가 되고, 끄면 f가 없어져 보험료가 달라진다", () => {
    expect(waiverCols(s.sheet)).toEqual([colOf(s, /납입면제/).id]);
    const off = planReducer(s, { type: "contract", patch: { waiver: false } });
    // 납입면제는 납입자 집단 l′만 줄이므로 10만원당 반올림 전 값에서 차이가 난다(면제를 켜면 보험료가 오른다)
    expect(run(s).result.coverages[0].perUnit.gross).toBeGreaterThan(run(off).result.coverages[0].perUnit.gross);
  });
  it("납입면제 열을 수식으로 만들어도 반영된다", () => {
    const f = colOf(s, /납입면제/), death = colOf(s, /사망/);
    const rows = s.sheet.ages.map((_, i) => `=B${i + 1}*2`);
    let a = s;
    rows.forEach((val, i) => { a = planReducer(a, { type: "cell", colId: f.id, row: i, value: val }); });
    const r = resolveSheet(a.sheet);
    expect(r.byId[f.id][0]).toBeCloseTo(r.byId[death.id][0] * 2, 12);
    expect(run(a).result.coverages[0].perUnit.gross).not.toBe(run(s).result.coverages[0].perUnit.gross);
  });
});

describe("상품 만들기 상태", () => {
  it("기본 예시(2대질병 3천만원 80세 만기 20년납)에서 보험료가 나온다", () => {
    const { result: r } = run(initialPlan());
    expect(r.standard.monthlyGross).toBeGreaterThan(0);
    expect(r.n).toBe(80 + 1 - 40);
    expect(r.benefit[0]).toBe(3e7);
  });
  it("면책 3개월 = 첫해 급부 3/4", () => {
    expect(waitFactorOf(3)).toBe(0.75);
    expect(waitFactorOf(0)).toBe(1);
  });
  it("담보를 더하면 보험료가 커지고, 마지막 하나는 지울 수 없다", () => {
    const s = initialPlan();
    const two = planReducer(s, { type: "addCoverage", kind: "death" });
    expect(two.coverages).toHaveLength(2);
    expect(run(two).result.standard.monthlyGross).toBeGreaterThan(run(s).result.standard.monthlyGross);
    const back = planReducer(two, { type: "removeCoverage", id: two.coverages[1].id });
    expect(planReducer(back, { type: "removeCoverage", id: back.coverages[0].id }).coverages).toHaveLength(1);
  });
  it("담보 순서를 바꿀 수 있다", () => {
    const two = planReducer(initialPlan(), { type: "addCoverage", kind: "death" });
    const moved = planReducer(two, { type: "moveCoverage", id: two.coverages[1].id, dir: -1 });
    expect(moved.coverages.map((c) => c.id)).toEqual([two.coverages[1].id, two.coverages[0].id]);
    expect(planReducer(two, { type: "moveCoverage", id: two.coverages[1].id, dir: 1 })).toBe(two);
  });
  it("저해지를 켜면 보험료가 내려간다", () => {
    const s = initialPlan();
    const low = planReducer(s, { type: "low", patch: { on: true } });
    expect(run(low).result.effective.monthlyGross).toBeLessThan(run(s).result.standard.monthlyGross);
  });
  it("증액·감액 구간을 넣으면 보장금액과 보험료가 따라간다", () => {
    const s = initialPlan();
    const cut = planReducer(s, { type: "coverage", id: s.coverages[0].id, patch: { steps: [{ fromAge: 40, toAge: 59, multiple: 1 }, { fromAge: 60, toAge: 80, multiple: 0.5 }] } });
    const { result: r } = run(cut);
    expect(r.benefit[20]).toBe(1.5e7);
    expect(r.standard.monthlyGross).toBeLessThan(run(s).result.standard.monthlyGross);
  });
});

describe("단계 카드", () => {
  it("기본 상태에서는 모두 완료이고 담보 카드가 하나 있다", () => {
    const s = initialPlan();
    const { result, sheet } = run(s);
    const steps = planSteps(s, result, sheet);
    expect(steps.map((x) => x.code)).toEqual(["M01", "M02", "M03", "M04", "M05", "C01", "M06", "M07"]);
    expect(steps.every((x) => x.status === "done")).toBe(true);
  });
  it("납입면제를 켠 채 면제 열을 모두 끄면 M05가 오류", () => {
    let s = initialPlan();
    for (const c of s.sheet.columns) s = planReducer(s, { type: "column", colId: c.id, patch: { waiver: false } });
    const { result, sheet } = run(s);
    const m05 = planSteps(s, result, sheet).find((x) => x.code === "M05")!;
    expect(m05.status).toBe("error");
    expect(m05.message).toContain("납입면제 열이 없습니다");
  });
  it("시트에 수식 오류가 있으면 M04가 오류이고 칸 위치를 알려준다", () => {
    const s0 = initialPlan();
    const s = planReducer(s0, { type: "cell", colId: s0.sheet.columns[0].id, row: 2, value: "=1/0" });
    const { result, sheet } = run(s);
    const m04 = planSteps(s, result, sheet).find((x) => x.code === "M04")!;
    expect(m04.status).toBe("error");
    expect(m04.message).toBe("B3 칸: #DIV/0!");
  });
  it("담보를 더하면 C02가 생긴다", () => {
    const s = planReducer(initialPlan(), { type: "addCoverage", kind: "daily" });
    const { result, sheet } = run(s);
    expect(planSteps(s, result, sheet).map((x) => x.code)).toContain("C02");
  });
});

describe("수식 추천", () => {
  it("고른 칸에 맞춰 실제 열 문자로 만들어 준다", () => {
    const s = initialPlan();
    const tips = snippetsFor({ sheet: s.sheet, col: s.sheet.columns[2], colIdx: 2, row: 3 });
    expect(tips.find((t) => t.id === "carry")!.formula).toBe("=D3");
    expect(tips.find((t) => t.id === "copy")!.formula).toBe("=B4");
    expect(tips.some((t) => t.formula.includes("IF("))).toBe(true);
    for (const t of tips) expect(t.formula.startsWith("=")).toBe(true);
  });
  it("첫 행에서는 앞 행 이어받기를 권하지 않는다", () => {
    const s = initialPlan();
    expect(snippetsFor({ sheet: s.sheet, col: s.sheet.columns[0], colIdx: 0, row: 0 }).some((t) => t.id === "carry")).toBe(false);
  });
});

describe("저장값 검증", () => {
  it("쓰레기 값이 들어와도 기본값으로 살아난다", () => {
    const s = sanitizePlan({ age: "40", payYears: -5, interest: 99, sheet: { ages: ["a"] }, coverages: [{ label: 123, amount: "x" }], low: { on: "yes" } });
    expect(s.age).toBe(40);
    expect(s.payYears).toBe(1);
    expect(s.interest).toBe(0.2);
    expect(s.low.on).toBe(false);
    expect(s.sheet.columns.length).toBeGreaterThan(0);
    expect(run(s).result.standard.monthlyGross).toBeGreaterThanOrEqual(0);
  });
  it("정상 상태는 왕복해도 그대로", () => {
    const s = planReducer(initialPlan(), { type: "addCoverage", kind: "death" });
    const back = sanitizePlan(JSON.parse(JSON.stringify(s)));
    expect(back.sheet.columns.map((c) => c.id)).toEqual(s.sheet.columns.map((c) => c.id));
    expect(run(back).result.standard.monthlyGross).toBe(run(s).result.standard.monthlyGross);
  });
  it("없는 열을 가리키는 담보는 살아 있는 열로 되돌린다", () => {
    const s = initialPlan();
    const back = sanitizePlan({ ...s, coverages: [{ ...s.coverages[0], eventColId: "없음", exitColIds: ["없음"] }] });
    expect(s.sheet.columns.some((c) => c.id === back.coverages[0].eventColId)).toBe(true);
    expect(back.coverages[0].exitColIds.length).toBeGreaterThan(0);
  });
});

describe("산출식 문서", () => {
  it("7개 절이 나오고 실제 숫자가 들어간다", async () => {
    const { buildPlanDoc, docToMarkdown } = await import("@/lib/plan-doc");
    const s = initialPlan();
    const { result, sheet } = run(s);
    const doc = buildPlanDoc(s, result, sheet, new Date("2026-09-20"));
    expect(doc.map((x) => x.id)).toEqual(["overview", "basis", "commutation", "premium", "reserve", "surrender", "check"]);
    const md = docToMarkdown(doc, "테스트");
    expect(md).toContain("# 테스트");
    expect(md).toContain("PVB = Σ");
    expect(md).toContain("2대질병");
    expect(md).toContain("| 열 | 이름 | 유형 | 납입면제 |");     // 위험률 열 표
    expect(md).toContain("f_x =");                               // 납입면제 정의
  });
  it("저해지를 켜면 CSV 식과 인하율이 문서에 실린다", async () => {
    const { buildPlanDoc, docToMarkdown } = await import("@/lib/plan-doc");
    const s = planReducer(initialPlan(), { type: "low", patch: { on: true } });
    const { result, sheet } = run(s);
    const md = docToMarkdown(buildPlanDoc(s, result, sheet), "x");
    expect(md).toContain("CSV_t = Σ");
    expect(md).toContain("Ā_x = PVB + CSV_0");
    expect(md).toContain("표준형 대비 인하율");
  });
  it("담보별 보험료 합계와 표시 합계가 같다", async () => {
    const { buildPlanDoc } = await import("@/lib/plan-doc");
    const s = planReducer(initialPlan(), { type: "addCoverage", kind: "death" });
    const { result, sheet } = run(s);
    const check = buildPlanDoc(s, result, sheet).find((x) => x.id === "check")!.blocks.find((b) => b.t === "table")!;
    const rows = (check as { rows: (string | number)[][] }).rows;
    expect(String(rows.find((x) => x[0] === "차이")![1])).toBe("0원");
  });
});
