import { beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extractDoc, extractText } from "@/lib/methoddoc/extract";
import { parseMethodDoc } from "@/lib/methoddoc/parse";
import { docToMarkdown } from "@/lib/methoddoc/render";
import type { Evidence } from "@/lib/methoddoc/spec";
import { applySpecToPlan, specFromPlanStorage } from "@/lib/methoddoc-bridge";
import { buildPlanDoc, planToSpec } from "@/lib/plan-doc";
import { evaluateProduct, PLAN_RECIPES, PLAN_STORAGE_KEY, sanitizePlan, type PlanState } from "@/lib/plan-state";

/**
 * 양방향 왕복 시험.
 *  ① 산출방법서 문서 → 입력 조건 → 보험료
 *  ② 입력 조건 + 산출 결과 → 산출방법서 → 다시 읽어 조건 비교
 * 둘이 같은 MethodSpec 을 거치므로, 한쪽이 흘리는 항목이 있으면 여기서 드러난다.
 */

// ── localStorage 대역 (bridge 가 저장소를 통해 오가므로) ─────────────────────
const store = new Map<string, string>();
beforeEach(() => store.clear());
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});
const seed = (s: PlanState) => store.set(PLAN_STORAGE_KEY, JSON.stringify(s));
const load = () => sanitizePlan(JSON.parse(store.get(PLAN_STORAGE_KEY)!));
const plan = (id: string) => PLAN_RECIPES.find((r) => r.id === id)!.build("M", 40);

// ── ① 문서 → 조건 → 보험료 ──────────────────────────────────────────────────
const ROOT = "C:/Users/tklee/OneDrive - 코리안리재보험/0. 보험료 산출 방법서";
function find(dirFrag: string, fileFrag: string): string {
  try {
    const dir = readdirSync(ROOT).find((d) => d.normalize("NFC").includes(dirFrag));
    if (!dir) return "";
    const f = readdirSync(`${ROOT}/${dir}`).find((x) => /\.pdf$/i.test(x) && x.normalize("NFC").includes(fileFrag));
    return f ? `${ROOT}/${dir}/${f}` : "";
  } catch { return ""; }
}
const GONGJE = find("교직원 공제", "실속건강공제");   // 이율 4.25%, 신계약비 3/1000, 유지비·수금비 2%

describe.runIf(!!GONGJE && existsSync(GONGJE))("① 산출방법서 PDF → 입력 조건 → 보험료", () => {
  it("검수에서 고른 항목만 조건에 들어가고, 그 조건으로 보험료가 나온다", async () => {
    const doc = await extractDoc("실속건강공제.pdf", new Uint8Array(readFileSync(GONGJE)));
    const r = parseMethodDoc(doc, { fallbackName: "교육가족 실속건강공제" });

    // 검수 화면 기본값과 같게: AI 추정(low)은 빼고 고른다
    const accepted: Evidence[] = r.evidence.filter((e) => e.confidence !== "low");

    seed(plan("whole"));                       // 40세 남자 종신보험을 바탕으로 깐다
    const before = evaluateProduct(load()).effective.monthlyGross;
    const applied = applySpecToPlan(r.spec, accepted);
    expect(applied).toBeGreaterThanOrEqual(3);

    const s = load();
    expect(s.productName).toBe("교육가족 실속건강공제");
    expect(s.base.interest).toBeCloseTo(0.0425, 12);            // 문서의 예정이율
    expect(s.base.expenses.model).toBe("method");
    if (s.base.expenses.model === "method") {
      expect(s.base.expenses.alphaS).toBeCloseTo(0.003, 12);    // 신계약비 초년도 가입금액 3/1000
      expect(s.base.expenses.gamma).toBeCloseTo(0.02, 12);      // 수금비 영업부담금 2%
    }

    const after = evaluateProduct(s).effective.monthlyGross;
    expect(after).toBeGreaterThan(0);
    // 예정이율이 2.5% → 4.25% 로 올라갔으니 보험료는 내려가야 한다
    expect(after).toBeLessThan(before);

    // 검수에서 아무것도 고르지 않으면 조건은 그대로다
    seed(plan("whole"));
    expect(applySpecToPlan(r.spec, [])).toBe(0);
    expect(load().base.interest).toBeCloseTo(0.025, 12);
  }, 300000);
});

// ── ② 조건 + 결과 → 산출방법서 → 다시 읽기 ──────────────────────────────────
describe("② 입력 조건 + 산출 결과 → 산출방법서 → 다시 읽기", () => {
  const roundtrip = (s: PlanState) => {
    const p = evaluateProduct(s);
    const md = docToMarkdown(buildPlanDoc(s, p, new Date("2026-09-20")), s.productName);
    const back = parseMethodDoc(extractText(new TextEncoder().encode(md)), { fallbackName: s.productName });
    return { p, md, back };
  };
  it("낸 문서에 조건·보험료·준비금이 들어 있다", () => {
    const s = plan("waiverSupport");
    const { p, md } = roundtrip(s);
    expect(md).toContain("보험료납입지원 적용 3대질병보험");
    expect(md).toContain("2.50%");                    // 예정이율
    expect(md).toContain("20년");                     // 납입기간
    expect(md).toContain("3대질병 진단");
    expect(md).toContain("납입면제 발생률");           // 위험률 목록
    expect(md).toContain("산출 결과 — 보험료");
    expect(md).toContain("산출 결과 — 책임준비금·해지환급금");
    // 표시한 월보험료가 실제 산출값과 같다
    expect(md).toContain(p.effective.monthlyGross.toLocaleString("ko-KR", { maximumFractionDigits: 0 }));
  });

  it("낸 문서를 다시 읽으면 이율·납입기간·사업비가 되살아난다", () => {
    const s = plan("waiverSupport");
    const { back } = roundtrip(s);
    expect(back.spec.basis.interest).toBeCloseTo(s.base.interest, 12);
    expect(back.spec.basis.standardInterest).toBeCloseTo(s.base.standardInterest, 12);
    expect(back.spec.contract.payYears).toBe(s.base.payYears);
    expect(back.spec.expenses.length).toBeGreaterThanOrEqual(4);
    expect(back.missing).not.toContain("사업비");
  });

  it("되읽은 조건을 그대로 적용하면 보험료가 같다", () => {
    const s = plan("waiverSupport");
    const { p, back } = roundtrip(s);

    seed(s);
    applySpecToPlan(back.spec, back.evidence.filter((e) => e.confidence !== "low"));
    const again = evaluateProduct(load());
    expect(again.effective.monthlyGross).toBeCloseTo(p.effective.monthlyGross, 6);
    expect(again.effective.reserve[10]).toBeCloseTo(p.effective.reserve[10], 6);
    expect(again.effective.cash[20]).toBeCloseTo(p.effective.cash[20], 6);
  });

  it("무해지환급형도 종류·해지율·환급률이 문서에 남고 되읽힌다", () => {
    const s = plan("noRefund");
    const { back, md } = roundtrip(s);
    expect(md).toContain("무해지환급형");
    expect(back.spec.basis.lapse?.[0].rate).toBeCloseTo(0.03, 12);
    expect(back.spec.basis.lowRatio).toBe(0);

    seed(plan("noRefund"));
    applySpecToPlan(back.spec, back.evidence.filter((e) => e.confidence !== "low"));
    const s2 = load();
    expect(s2.base.low.on).toBe(true);
    expect(s2.base.low.lapseRate).toBeCloseTo(0.03, 12);
    expect(s2.base.low.ratio).toBe(0);
  });

  it("저장소 → MethodSpec 도 같은 값을 낸다 (변환기 화면이 쓰는 경로)", () => {
    const s = plan("twoMajor");
    seed(s);
    const spec = specFromPlanStorage()!;
    expect(spec).toEqual(planToSpec(s, evaluateProduct(s)));
    expect(spec.rates.length).toBe(s.tabs[0].sheet.columns.length);
    expect(spec.benefits.length).toBe(s.tabs[0].coverages.length);
  });
});
