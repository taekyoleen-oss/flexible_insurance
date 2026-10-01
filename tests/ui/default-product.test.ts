import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { planFromSpec, readSpecJson } from "@/lib/methoddoc-bridge";
import { computeSpec } from "@/lib/methoddoc/calc";
import { activeTab, evaluateProduct } from "@/lib/plan-state";

/**
 * Studio 의 기본 상품 종신보험(암진단 포함) → 이 앱의 계산.
 * Studio samples/09_종신보험(암진단포함)_MethodSpec.json 을 열어(계약정보 기본값: 남 40세 · 20년납 · 월납) 계산하고,
 * VERIFY_UPDATE=1 이면 담보별 결과를 Studio samples/09_…_계산결과.json 에 쓴다 — 엑셀 검산 파일이 이 값과 수식 결과를 맞대어 본다.
 */
const DIR = new URL("../../../Life_ins_Doc_Convert_Studio/samples/", import.meta.url);
const SPEC = new URL("09_종신보험(암진단포함)_MethodSpec.json", DIR);
const OUT = new URL("09_종신보험(암진단포함)_계산결과.json", DIR);

describe.runIf(existsSync(SPEC))("Studio 기본 상품 → 이 앱의 계산", () => {
  const { state, warnings } = planFromSpec(readSpecJson(readFileSync(SPEC, "utf8")));
  const p = evaluateProduct(state);

  it("JSON 열기: 담보 둘 · 암 진단 3개월 면책 · 납입면제 열 = 80% 장해·암 · 남 40세 표", () => {
    expect(warnings).toEqual([]);
    const tab = activeTab(state);
    expect(tab.sheet.columns.map((c) => [c.name, c.kind, c.waiver])).toEqual([
      ["사망률", "death", false], ["80% 이상 장해율", "incidence", true], ["암발생률", "incidence", true],
    ]);
    expect(tab.coverages.map((c) => [c.label, c.kind, c.amount, c.endAge, c.waitMonths])).toEqual([
      ["사망·80% 이상 장해", "death", 1e8, 110, 0], ["암 진단", "incidence", 5e7, 99, 3],   // 산출방법서의 100세 만기 = 보장 종료 연령 99세
    ]);
    expect([state.sex, state.age, state.base.payYears, state.base.freq, state.base.waiver]).toEqual(["M", 40, 20, 12, true]);
    expect(p.coverages.map((c) => [c.n, c.payYears])).toEqual([[71, 20], [60, 20]]);
  });

  it("납입면제 사유가 그 담보의 탈퇴 사유이기도 하면 다시 빼지 않는다 — 두 담보 모두 납입자수는 사망·장해·암으로 준다", () => {
    for (const c of p.coverages) {
      const k = c.perUnit;
      expect(k.pvb).toBeGreaterThan(0);
      expect(c.monthlyGross).toBeGreaterThan(0);
    }
    // 두 담보의 납입자수는 같은 세 사유(사망·장해·암)로 준다 — 첫해 결합 탈퇴율이 같아야 한다(두 번 빼면 암 진단 쪽이 더 준다)
    const tab = p.tabs[0];
    const at40 = (id: string) => tab.sheet.byId[id][40 - tab.tab.sheet.ages[0]];
    const [q, r80, rc] = activeTab(state).sheet.columns.map((c) => at40(c.id));
    const both = (a: number, b: number) => a + b - (a * b) / 2;
    const keepMain = 1 - both(q, r80) - rc + (both(q, r80) * rc) / 2, keepCancer = 1 - both(q, rc) - r80 + (both(q, rc) * r80) / 2;
    expect(keepMain).toBeCloseTo(keepCancer, 8);
  });

  it("산출방법서의 식을 그대로 읽어 계산해도 엔진과 같은 값 — 다른 앱은 lib/methoddoc 만으로도 산출할 수 있다", () => {
    const spec = readSpecJson(readFileSync(SPEC, "utf8"));
    const got = computeSpec(spec, { sex: state.sex, age: state.age, payYears: state.base.payYears, freq: state.base.freq });
    expect(got.errors).toEqual([]);
    expect(got.missingRates).toEqual([]);
    got.benefits.forEach((b, i) => {
      const c = p.coverages[i];
      expect([b.n, b.m]).toEqual([c.n, c.payYears]);
      // 식을 적은 순서가 엔진의 계산 순서와 조금 달라(q + r − q·r/2 ↔ Σd − (Σd² − Σd²)/4) 끝자리만 다르다
      expect(b.pvb / c.perUnit.pvb).toBeCloseTo(1, 7);
      expect(b.gross / c.perUnit.gross).toBeCloseTo(1, 7);
      expect(b.per100k).toBe(c.per100k.gross);          // 10만원당 보험료는 정확히 같다
    });
    expect(got.premium).toBe(p.effective.monthlyGross);
  });

  it("담보별 결과를 남긴다 (VERIFY_UPDATE=1) — 엑셀 검산 파일이 맞대어 보는 값", () => {
    const out = {
      product: state.productName, contract: { sex: state.sex, age: state.age, payYears: state.base.payYears, freq: state.base.freq }, n: p.n,
      coverages: p.coverages.map((c) => ({
        label: c.label, n: c.n, m: c.payYears, amount: c.monthlyGross / c.per100k.gross * 1e5,
        pvb: c.perUnit.pvb, nStar: c.perUnit.nStar, net: c.perUnit.net, base: c.perUnit.base, gross: c.perUnit.gross, pBeta: c.perUnit.pBeta,
        gross100k: c.per100k.gross, monthlyGross: c.monthlyGross, reserve100k: c.reserve.map((v) => Math.round(v / c.units)).slice(0, c.n + 1),
      })),
      monthlyGross: p.effective.monthlyGross,
    };
    if (process.env.VERIFY_UPDATE || !existsSync(OUT)) writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
    expect(JSON.parse(readFileSync(OUT, "utf8"))).toEqual(JSON.parse(JSON.stringify(out)));
  });
});
