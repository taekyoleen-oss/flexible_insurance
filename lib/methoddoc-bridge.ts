import {
  autoExitCols, initialPlan, PLAN_STORAGE_KEY, sanitizePlan, evaluateProduct, suggestEventCol,
  type PlanCoverageState, type PlanState, type PlanTab, type TabConditions,
} from "./plan-state";
import type { RateColumn, RateKind, RateSheet } from "./plan-rates";
import type { BenefitKind, Expenses, ExpensesMethod } from "./engine";
import { planToSpec } from "./plan-doc";
import { emptySpec, rateTable, type BenefitSpec, type BasisSpec, type ContractSpec, type Evidence, type ExpenseItem, type MethodSpec, type RateRef, type RateRole, type Sex } from "./methoddoc/spec";

/**
 * methoddoc 모듈(앱 독립) ↔ 이 앱의 저장소를 잇는 다리.
 * 변환기 화면이 산출방법서에서 읽은 값을 "상품 만들기" 입력에 넣고, 반대로 저장된 조건을 MethodSpec 으로 낸다.
 * 다른 앱(Life_ins_Doc_Convert_Studio 등)이 낸 MethodSpec JSON 은 planFromSpec 으로 설계 전체(위험률 표·담보 포함)가 된다.
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

// ── 사업비 기호 → 산출방법서형 사업비 ─────────────────────────────────────────
/**
 * 기호(α_S·α_P·β_S·β_G·β′·γ, 또는 α1·α2·β1·β2)가 잡힌 항목만 옮긴다. 하나도 없으면 null.
 * 한 문서에 상품이 여럿 실린 산출방법서가 있다 — 같은 기호가 다시 나와도 앞엣것을 남긴다.
 */
function methodExpenses(items: ExpenseItem[], start: ExpensesMethod, take: (i: number) => boolean = () => true): ExpensesMethod | null {
  const isAnnual = (x: ExpenseItem) => /기준\s*연납\s*순보험료/.test(x.basis) || x.times !== undefined;
  const e = { ...start };
  const done = new Set<string>();
  const put = (key: "alphaS" | "alphaP" | "betaS" | "betaG" | "betaPrime" | "gamma", v: number) => {
    if (done.has(key)) return;
    done.add(key); e[key] = v;
  };
  items.forEach((x, i) => {
    if (!take(i)) return;
    const v = x.rate ?? x.times;
    if (v === undefined) return;
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
  });
  return done.size ? e : null;
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
  if (base.expenses.model === "method") {
    const e = methodExpenses(spec.expenses, base.expenses, (i) => take.has(`expenses[${i}]`));
    if (e) { base.expenses = e; count++; }
  }

  if (!count) return 0;
  writePlan({ ...s, base, memo: [s.memo, `산출방법서에서 ${count}개 항목 적용`].filter(Boolean).join(" · ").slice(0, 200) });
  return count;
}

// ── MethodSpec JSON → 설계 전체 ──────────────────────────────────────────────
/** 다른 앱이 낸 MethodSpec JSON 을 읽는다. 빈 칸은 기본값으로 채우고, 모양이 아니면 오류 */
export function readSpecJson(text: string): MethodSpec {
  const raw = JSON.parse(text.replace(/^﻿/, "")) as Partial<MethodSpec> | null;
  if (!raw || typeof raw !== "object" || !("meta" in raw || "basis" in raw)) throw new Error("MethodSpec JSON 이 아닙니다 (meta·basis 가 없음)");
  const e = emptySpec();
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  return {
    ...e, ...raw,
    meta: { ...e.meta, ...raw.meta, productName: String(raw.meta?.productName ?? "") },
    contract: { ...raw.contract }, basis: { ...raw.basis },
    rates: arr(raw.rates), expenses: arr(raw.expenses), benefits: arr(raw.benefits), units: arr(raw.units),
    formulas: arr(raw.formulas), sections: arr(raw.sections),
    reserve: { notes: arr(raw.reserve?.notes) }, surrender: { ...raw.surrender, notes: arr(raw.surrender?.notes) },
  };
}

/** 위험률 유형 → 시트 열 유형. 해지율은 열이 아니라 저해지 조건(적용해지율)이다 */
const KIND: Record<RateRole, RateKind | null> = { death: "death", incidence: "incidence", recurring: "recurring", waiver: "other", other: "other", lapse: null };
const COVER: Record<BenefitSpec["role"], BenefitKind> = { death: "death", incidence: "incidence", recurring: "daily", other: "survival" };
/** 계약정보 성별의 위험률 표 — 남·여 두 벌(tables)이면 그 성별, 한 벌(table)이면 그 표 */
const table = (r: RateRef, sex: Sex) => { const t = rateTable(r, sex); return t && Array.isArray(t.ages) && Array.isArray(t.values) && t.ages.length ? t : undefined; };

function lowOf(lapse: BasisSpec["lapse"], lowRatio: number | undefined, d: TabConditions["low"]): TabConditions["low"] {
  const l = lapse?.find((x) => x.rate > 0) ?? lapse?.[0];
  if (l) return { on: l.rate > 0, ratio: lowRatio ?? d.ratio, lapseRate: l.rate };
  return lowRatio !== undefined ? { ...d, on: true, ratio: lowRatio } : { ...d, on: false };
}

/** 계약·기초율(주계약 또는 특약의 다른 조건) → 탭 조건. 적힌 것만 돌려준다 */
function conditionsOf(c: Partial<ContractSpec & BasisSpec>, age: number, d: TabConditions): Partial<TabConditions> {
  const out: Partial<TabConditions> = {};
  if (c.termYears) out.termYears = Math.round(c.termYears);
  else if (c.termAge) out.termYears = Math.max(1, Math.round(c.termAge) - age + 1);
  if (c.payYears) out.payYears = Math.round(c.payYears);
  else if (c.payAge) out.payYears = Math.max(1, Math.round(c.payAge) - age);
  if (c.freq) out.freq = Math.round(c.freq);
  if (c.interest !== undefined) out.interest = c.interest;
  if (c.standardInterest !== undefined) out.standardInterest = c.standardInterest;
  if (c.waiver !== undefined) out.waiver = c.waiver;
  if (c.lapse !== undefined || c.lowRatio !== undefined) out.low = lowOf(c.lapse, c.lowRatio, d.low);
  return out;
}

/** 사업비 표 → 사업비 모형. 산출방법서형 기호가 있으면 그 모형, α·β·γ 만 있으면 3이원 단순형 */
function expensesOf(items: ExpenseItem[], d: Expenses): Expenses {
  const start: ExpensesMethod = d.model === "method" ? d : { model: "method", alphaS: 0.01, alphaP: 1, betaS: 0.0015, betaG: 0.045, betaPrime: 0.001, gamma: 0.025 };
  const m = methodExpenses(items, start);
  if (m && items.some((x) => /^(α_S|α_P|β_S|β_G|α1|α2|β1)$/.test(x.symbol))) return m;
  const pick = (sym: string) => items.find((x) => x.symbol === sym)?.rate;
  const a = pick("α"), b = pick("β"), g = pick("γ");
  if (a !== undefined || b !== undefined) return { model: "simple", alpha: a ?? 0.007, beta: b ?? 0.0015, gamma: g ?? 0.02 };
  return m ?? d;
}

/**
 * MethodSpec → "상품 만들기" 설계 전체 (planToSpec 의 반대 — 왕복하면 보험료가 같다).
 *  - 계약 단위(units, 없으면 담보의 unit 이름)마다 탭 하나. 주계약이 첫 탭
 *  - 계약정보(성별·가입나이·기간)는 spec.contract 에 있으면 그 값, 없으면(산출방법서를 읽은 조건) CONTRACT_DEFAULTS
 *  - 위험률 표는 계약정보 성별의 표(RateRef.tables → table)를 그 탭 시트의 열로. 표가 없는 위험률은 0 으로 채우고 warnings 로 알린다
 *  - 담보의 급부·탈퇴 위험률 id 는 옮긴 열 id 로, 면책 일수는 개월로
 */
export function planFromSpec(spec: MethodSpec): { state: PlanState; warnings: string[] } {
  const def = initialPlan();
  const warnings: string[] = [];
  const sex = spec.contract.sex === "F" ? "F" : spec.contract.sex === "M" ? "M" : def.sex;
  const age = Math.round(spec.contract.age ?? def.age);
  const base: TabConditions = {
    ...def.base, termYears: 0,
    ...conditionsOf({ ...spec.contract, ...spec.basis }, age, def.base),
    expenses: expensesOf(spec.expenses, def.base.expenses),
  };
  let k = 0;
  const fresh = (p: string) => `${p}${Date.now().toString(36)}x${(k++).toString(36)}`;     // 한 번에 여럿 만들어도 겹치지 않게

  // 계약 단위 — 없으면 담보에 적힌 단위 이름으로 묶는다
  const unitName = (b: BenefitSpec) => b.unit?.trim() || "주계약";
  const units: MethodSpec["units"] = spec.units.length ? [...spec.units].sort((a, b) => Number(b.main) - Number(a.main)) : (() => {
    const names = [...new Set(spec.benefits.map(unitName))].sort((a, b) => Number(b === "주계약") - Number(a === "주계약"));
    const many = names.length > 1;
    return (names.length ? names : ["주계약"]).map((name, i) => {
      const bens = spec.benefits.filter((b) => unitName(b) === name);
      const used = new Set(bens.flatMap((b) => [b.rateId, ...(b.exitRateIds ?? [])]).filter(Boolean) as string[]);
      // 특약이 여럿이면 그 담보가 쓰는 위험률(+ 납입면제 사유)만, 하나면 전부
      const rateIds = spec.rates.filter((r) => !many || used.has(r.id) || r.role === "waiver").map((r) => r.id);
      return { id: `u${i}`, name, main: i === 0, benefitIds: bens.map((b) => b.id), rateIds };
    });
  })();

  const endDefault = spec.contract.termAge ?? (base.termYears ? age + base.termYears - 1 : 80);
  const tabs: PlanTab[] = units.map((u) => {
    const rates = u.rateIds.map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r && KIND[r.role] !== null);
    const withT = rates.filter((r) => table(r, sex));
    const ages = withT.length
      ? [...new Set(withT.flatMap((r) => table(r, sex)!.ages.map((a) => Math.round(a))))].sort((a, b) => a - b)
      : Array.from({ length: Math.max(1, endDefault - age + 1) }, (_, i) => age + i);
    const colOf = new Map<string, string>();
    const columns: RateColumn[] = rates.map((r) => {
      const id = fresh("r"), t = table(r, sex);
      colOf.set(r.id, id);
      if (!t) warnings.push(`위험률 "${r.name}" 에 값 표가 없어 0 으로 넣었습니다 — 시트에 붙여넣으세요`);
      else if (t.sex && t.sex !== sex) warnings.push(`위험률 "${r.name}" 표는 ${t.sex === "M" ? "남" : "여"}자 표입니다(계약정보 ${sex === "M" ? "남" : "여"}) — 그 성별 표를 시트에 붙여넣으세요`);
      // 표에 없는 나이는 바로 앞 나이 값(첫 나이 앞은 첫 값) — 시트 평가(toAgeArray)와 같은 규칙
      const at = t ? new Map(t.ages.map((a, i) => [Math.round(a), Number(t.values[i]) || 0])) : null;
      let last = t ? Number(t.values[0]) || 0 : 0;
      const cells = ages.map((a) => { if (at?.has(a)) last = at.get(a)!; return String(last); });
      return { id, name: r.name, kind: KIND[r.role]!, waiver: r.role === "waiver", cells, ...(r.source ? { source: r.source } : {}) };
    });
    if (rates.length > 20) warnings.push(`${u.name}: 위험률이 ${rates.length}개라 앞의 20개만 시트에 넣었습니다`);
    const sheet: RateSheet = { ages, columns };
    const coverages = u.benefitIds.map((id) => spec.benefits.find((b) => b.id === id)).filter((b): b is BenefitSpec => !!b).map((b): PlanCoverageState => {
      const kind = COVER[b.role] ?? "incidence";
      const eventColId = (b.rateId && colOf.get(b.rateId)) || suggestEventCol(sheet, kind);
      const exits = (b.exitRateIds ?? []).map((x) => colOf.get(x)).filter((x): x is string => !!x);
      return {
        id: fresh("c"), label: b.name, kind, amount: b.amount ?? 3e7, endAge: b.endAge ?? endDefault,
        waitMonths: b.waitDays ? Math.round(b.waitDays / 30.4) : 0,     // planToSpec 이 개월 × 30.4 로 낸다
        eventColId, exitColIds: exits.length ? exits : autoExitCols(sheet, kind, eventColId),
        steps: b.steps ?? [], points: b.points ?? [],
      };
    });
    if (!coverages.length) warnings.push(`${u.name}: 담보가 없어 기본 담보 하나를 넣었습니다`);
    return { id: fresh("t"), name: u.name, sheet, coverages, overrides: u.main ? {} : conditionsOf(u.overrides ?? {}, age, base) };
  });

  const state = sanitizePlan({
    version: 3, productName: spec.meta.productName || def.productName, memo: spec.meta.note ?? "",
    sex, age, base, tabs, active: tabs[0].id, open: ["contract"], updatedAt: Date.now(),
  });
  return { state, warnings };
}

/** 다른 앱의 MethodSpec 으로 "상품 만들기" 설계를 바꾼다(지금 설계는 덮어쓴다 — 필요하면 보관함에 먼저 저장) */
export function openSpecAsPlan(spec: MethodSpec): string[] {
  const { state, warnings } = planFromSpec(spec);
  writePlan(state);
  return warnings;
}
