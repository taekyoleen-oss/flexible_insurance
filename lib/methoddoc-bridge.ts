import { PLAN_STORAGE_KEY, sanitizePlan, evaluateProduct, type PlanState, type TabConditions } from "./plan-state";
import { planToSpec } from "./plan-doc";
import type { Evidence, MethodSpec } from "./methoddoc/spec";

/**
 * methoddoc 모듈(앱 독립) ↔ 이 앱의 저장소를 잇는 다리.
 * 변환기 화면이 산출방법서에서 읽은 값을 "상품 만들기" 입력에 넣고, 반대로 저장된 조건을 MethodSpec 으로 낸다.
 * 다른 앱에 옮길 때는 이 파일만 새로 쓰면 된다.
 */

const readPlan = (): PlanState | null => {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY);
    return raw ? sanitizePlan(JSON.parse(raw)) : null;
  } catch { return null; }
};
const writePlan = (s: PlanState) => localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ ...s, updatedAt: Date.now() }));

/** 저장된 설계 → MethodSpec */
export function specFromPlanStorage(): MethodSpec | null {
  const s = readPlan();
  return s ? planToSpec(s, evaluateProduct(s)) : null;
}

/**
 * 검수에서 고른 항목만 "상품 만들기" 조건에 넣는다. 위험률 표는 건드리지 않는다
 * (표는 시트에 붙여넣는 쪽이 정확해서, 변환기가 조용히 덮어쓰지 않게 한다).
 * 돌려주는 값은 실제로 반영한 항목 수.
 */
export function applySpecToPlan(spec: MethodSpec, accepted: Evidence[]): number {
  const s = readPlan();
  if (!s) return 0;
  const take = new Set(accepted.map((e) => e.path));
  const base: TabConditions = { ...s.base };
  let count = 0;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  if (take.has("meta.productName") && spec.meta.productName) { s.productName = spec.meta.productName.slice(0, 60); count++; }
  if (take.has("contract.age") && num(spec.contract.age) !== null) { s.age = Math.round(spec.contract.age!); count++; }
  if (take.has("contract.sex") && spec.contract.sex) { s.sex = spec.contract.sex; count++; }
  if (take.has("contract.termYears") && num(spec.contract.termYears) !== null) { base.termYears = Math.round(spec.contract.termYears!); count++; }
  if (take.has("contract.termAge") && num(spec.contract.termAge) !== null) { base.termYears = Math.max(1, Math.round(spec.contract.termAge!) - s.age + 1); count++; }
  if (take.has("contract.payYears") && num(spec.contract.payYears) !== null) { base.payYears = Math.round(spec.contract.payYears!); count++; }
  if (take.has("contract.freq") && num(spec.contract.freq) !== null) { base.freq = Math.round(spec.contract.freq!); count++; }
  if (take.has("basis.interest") && num(spec.basis.interest) !== null) { base.interest = spec.basis.interest!; count++; }
  if (take.has("basis.standardInterest") && num(spec.basis.standardInterest) !== null) { base.standardInterest = spec.basis.standardInterest!; count++; }
  if (take.has("basis.waiver") && spec.basis.waiver !== undefined) { base.waiver = spec.basis.waiver; count++; }
  if (take.has("basis.lapse") && spec.basis.lapse?.length) {
    const l = spec.basis.lapse.find((x) => x.rate > 0) ?? spec.basis.lapse[0];
    base.low = { on: l.rate > 0, ratio: spec.basis.lowRatio ?? base.low.ratio, lapseRate: l.rate };
    count++;
  }
  if (take.has("basis.lowRatio") && num(spec.basis.lowRatio) !== null) { base.low = { ...base.low, on: true, ratio: spec.basis.lowRatio! }; count++; }

  // 사업비 — 기호가 잡힌 항목만 옮긴다(산출방법서형 기준)
  const isAnnual = (x: MethodSpec["expenses"][number]) => /기준\s*연납\s*순보험료/.test(x.basis) || x.times !== undefined;
  const e = { ...base.expenses };
  if (e.model === "method") {
    let hit = false;
    // 한 문서에 상품이 여럿 실린 산출방법서가 있다 — 같은 기호가 다시 나와도 앞엣것을 남긴다
    const done = new Set<string>();
    const put = (key: "alphaS" | "alphaP" | "betaS" | "betaG" | "betaPrime" | "gamma", v: number) => {
      if (done.has(key)) return;
      done.add(key); e[key] = v; hit = true;
    };
    for (let i = 0; i < spec.expenses.length; i++) {
      if (!take.has(`expenses[${i}]`)) continue;
      const x = spec.expenses[i];
      const v = x.rate ?? x.times;
      if (v === undefined) continue;
      const after = x.phase === "납입후";
      if (x.symbol === "α_S") put("alphaS", v);
      else if (x.symbol === "α_P") put("alphaP", v);
      else if (x.symbol === "β_S") put(after ? "betaPrime" : "betaS", v);
      else if (x.symbol === "β_G") put("betaG", v);
      else if (x.symbol === "β_기타" || x.symbol === "β′" || x.symbol === "β'") put("betaPrime", v);   // 납입 후 유지비
      else if (x.symbol === "γ") put("gamma", v);
      // 산출방법서마다 기호를 α1·α2·β1·β2 로만 적기도 한다
      else if (x.symbol === "α1") put(isAnnual(x) ? "alphaP" : "alphaS", v);
      else if (x.symbol === "α2") put("alphaS", v);
      else if (x.symbol === "β1") put(/보험료|공제료|부담금/.test(x.basis) ? "betaG" : "betaS", v);
      else if (x.symbol === "β2") put("betaPrime", v);
    }
    if (hit) { base.expenses = e; count++; }
  }

  if (!count) return 0;
  writePlan({ ...s, base, memo: [s.memo, `산출방법서에서 ${count}개 항목 적용`].filter(Boolean).join(" · ").slice(0, 200) });
  return count;
}
