import { coverTerms, unitNames, unitOf, waiverRates, WHOLE_LIFE_AGE, type BenefitSpec, type ComboSpec, type FormulaSpec, type MethodSpec, type RateRef, type SurvivorSpec } from "./spec";
import { SAVE_PREMIUM, savingsFormulas } from "./savings";

/**
 * 조건(MethodSpec) → 산출식. 앱 엔진 없이 조건만으로 산출방법서의 3장 이후를 만든다.
 *
 * 식은 산출 순서대로 묶는다 — 카드(조건 화면)와 절(산출방법서)이 같은 순서다.
 *   1장 다. 생존자               생존자마다 lx(k): 기준 인원 · 결합 탈퇴율(R · Q) · l^{(k)} · D^{(k)} · N^{(k)} — 유지자수·납입자수를 나누지 않는다
 *                                [납입] 생존자는 그 계약 단위의 보험료 납입기수(N*)에 쓴다
 *   1장 라. 보험금               담보마다 쓰는 생존자 lx(k)(l · D · N 으로 가져오고 납입은 D′ · N′) → S · C · M · PVB
 *   1장 마. 순보험료 및 영업보험료 N* · P · 기준연납순보험료 · G · 1원당 반올림 → 10만원당
 *   2·3장 책임준비금 · 해지환급금  P_β · V · 해약공제 · W · 납입누계 · 환급률 — 모두 계산할 수 있는 식
 *
 * 규칙은 기존 산출방법서를 따른다.
 *  - 유지자수·납입자수는 "율"이 아니라 "~를 제외한 생존자수"로 적는다
 *      사유 하나    lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q)
 *      사유 둘      lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q − r + q·r/2)   (q 사망률 · r 그 밖의 탈퇴 발생률)
 *      사유 셋 이상 1 − Σd + Σ_{i<j} dᵢ·dⱼ/2
 *  - 납입자수 l′ 는 담보의 탈퇴 사유로 똑같이 줄고, 납입만 면제되는 사유(f)가 있으면 더 준다
 *  - 사망형(role: death) 담보는 탈퇴 사유 전부에 같은 보험금(종신의 "사망 또는 80% 이상 장해")
 *  - 급부 발생률은 따로 고르지 않는다 — 그 담보의 탈퇴 사유(집단) 가운데 사망이 아닌 것이 급부다(진단형). 일당형만 rateId 로 따로
 *  - 보장금액 = 가입금액 × 배수(multiple). 식은 모두 보장금액 1원당이고, 맨 뒤에서 가입금액 × 배수를 곱한다
 *  - 면책·삭감: 면책·삭감 기간(일) 동안 지급 비율(waitPayRatio — 면책 0, 50% 삭감 0.5) → 보장금액의 배수 S_t 에 반영
 *  - 기호: n 보험기간 · m 납입기간 · k 납입주기별 계수(연 납입횟수) · ρ 납입기간 중 해지환급금 비율 — render 의 "기호의 정의" 절
 *  - 식은 한 줄에 하나, 설명은 그 위 줄(또는 식 제목)에 — 기존 산출방법서 모양이고, Word·한글 수식으로 옮기기 좋다
 *
 * 이 식 표기는 calc.ts 가 그대로 읽어 계산한다 — 식을 고치면 계산이 바뀐다.
 * 그래서 새 식을 더할 때는 calc.ts 의 문법(아래첨자 · Σ · if · min/max · round)을 벗어나지 않게 적는다.
 */

const at = (x: string) => `${x}_{x+t}`;

/** 위험률 이름을 지급 사유 낱말로 — "사망률" → "사망", "80% 이상 장해율" → "80% 이상 장해" */
export const reasonOf = (r: RateRef) => (r.role === "death" ? "사망" : r.name.replace(/\s*(발생)?[율률]\s*[a-zA-Z]?$/, ""));

/** 사업비가 산출방법서형(α_S·α_P·β_S·β_G·β′·γ)인지 */
export const isMethodExpenses = (spec: MethodSpec) =>
  !spec.expenses.length || spec.expenses.some((e) => /^(α_S|α_P|β_S|β_G|β′|β'|α1|α2|β1|β2)$/.test(e.symbol));

/** 여러 기호를 한 벌로 — 같은 밑글자가 둘 이상이면 q^{(1)} · q^{(2)} */
function numbered(base: string, n: number): string[] {
  return n === 1 ? [base] : Array.from({ length: n }, (_, i) => `${base}^{(${i + 1})}`);
}

/** 기호로 쓸 수 없는 이름 — 식의 계열·기호(l · d · D · N · C · M · S · V · W · Q · R …)와 함수 이름 */
const RESERVED_SYM = new Set(["l", "d", "D", "N", "C", "M", "S", "V", "W", "Q", "R", "F", "P", "G", "E", "H", "k", "n", "m", "t", "u", "x", "v", "i", "w", "f", "g", "e", "min", "max", "if", "round"]);

/**
 * 위험률 기호 — 문서 전체에서 한 위험률은 한 기호다(유지자 표·보험금 표가 같은 기호를 쓴다).
 * **M04 예정위험률 표의 기호(위험률 id)를 그대로 쓴다**(사용자 요청 2026-10-06 — 암발생률 rc 가 식에서 r^{(1)} 로 바뀌지 않게).
 * id 가 기호로 쓸 수 없는 글자(영문자로 시작하는 영문·숫자가 아니거나 식의 계열 이름과 겹침)일 때만 옛 방식 —
 * 사망 q, 그 밖 r 에 차례 위첨자(q^{(1)} · r^{(1)} …). 해지율은 w 로 따로.
 */
export function rateSymbols(spec: MethodSpec): Map<string, string> {
  const rs = spec.rates.filter((r) => r.role !== "lapse");
  const out = new Map<string, string>();
  for (const r of rs) if (/^[A-Za-z][A-Za-z0-9]*$/.test(r.id) && !RESERVED_SYM.has(r.id) && ![...out.values()].includes(r.id)) out.set(r.id, r.id);
  // 나머지는 옛 방식 — 그 밑글자가 하나뿐이면 q · r, 여럿이면 차례 위첨자(옛 판과 같은 모양 — 자유설계보험의 id 는 기호로 못 쓴다)
  const rest = rs.filter((r) => !out.has(r.id)), taken = new Set(out.values());
  for (const base of ["q", "r"] as const) {
    const list = rest.filter((r) => (r.role === "death") === (base === "q"));
    const names = list.length === 1 && !taken.has(base) ? [base] : list.map((_, i) => `${base}^{(${i + 1})}`);
    list.forEach((r, i) => out.set(r.id, names[i]));
  }
  return out;
}

/** 옛 판(2026-10-05 까지)의 위험률 기호 — 사망 q · 그 밖 r(둘 이상이면 ^{(i)}), 위험률 표의 차례. 옛 문서를 되읽을 때만 쓴다 */
export function legacyRateSymbols(spec: MethodSpec): Map<string, string> {
  const rs = spec.rates.filter((r) => r.role !== "lapse");
  const deaths = rs.filter((r) => r.role === "death"), others = rs.filter((r) => r.role !== "death");
  const dq = numbered("q", deaths.length), dr = numbered("r", others.length);
  const out = new Map<string, string>();
  deaths.forEach((r, i) => out.set(r.id, dq[i]));
  others.forEach((r, i) => out.set(r.id, dr[i]));
  return out;
}

// ── 생존자 ──────────────────────────────────────────────────────────────────
/** 이름 — 빠지는 사유에 X: "생존자(사망X, 80% 이상 장해X)" */
export const crowdLabel = (kind: "생존자" | "유지자" | "납입자", rates: RateRef[]) =>
  `${kind}(${rates.length ? rates.map((r) => `${reasonOf(r)}X`).join(", ") : "빠지는 사유 없음"})`;
/** 유지자 이름(표준 산출방법서 v8) — "사망, 80% 이상 장해 아닌 유지자" · "사망 아닌 유지자" · "탈퇴 사유 없는 유지자" */
export const keepLabel = (rates: RateRef[]) => (rates.length ? `${rates.map(reasonOf).join(", ")} 아닌 유지자` : "탈퇴 사유 없는 유지자");
/** 탈퇴 사유에서 만든 이름인지 — 되읽을 때 사람이 붙인 이름과 가른다(옛 판 "생존자(사망X, …)" 도) */
export const isAutoKeepLabel = (s: string) => /^생존자\(.*\)$|^유지자\(.*\)$| 아닌 유지자$|^탈퇴 사유 없는 유지자$/.test(s.trim());

const exitsOf = (spec: MethodSpec, b: BenefitSpec) =>
  (b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);
const idsKey = (ids: string[]) => [...ids].sort().join(",");
const MAIN = "주계약";

/**
 * 계약 단위의 납입 사유 — 그 단위 모든 담보에 공통인 탈퇴 사유(보통 사망) + 납입면제 사유 (옛 조건에서 [납입] 생존자를 만들 때).
 * 납입면제는 **첫 계약 단위(주계약)만** — 특약은 독립특약이라 주계약의 납입면제를 가져오지 않는다(사용자 요청 2026-10-06)
 */
function payCauses(spec: MethodSpec, unit: string): RateRef[] {
  const lists = spec.benefits.filter((b) => unitOf(b) === unit).map((b) => exitsOf(spec, b));
  const common = (lists[0] ?? []).filter((r) => lists.every((l) => l.includes(r)));
  if (unit !== unitNames(spec)[0]) return common;
  return [...common, ...waiverRates(spec).filter((w) => !common.includes(w))];
}

/**
 * 생존자 목록 — 조건에 적힌 것(survivors)이 있으면 그것, 없으면 담보의 탈퇴 위험률(같으면 한 생존자)과
 * 계약 단위마다의 납입(공통 탈퇴 사유 + 납입면제)에서 만든다. 담보마다 쓰는 생존자 id · 단위마다 [납입] 생존자 id 도 돌려준다.
 */
export function survivorsOf(spec: MethodSpec): { survivors: SurvivorSpec[]; benefitOf: string[]; payOf: Map<string, string> } {
  const list: SurvivorSpec[] = (spec.survivors ?? []).map((s) => ({ ...s, exitRateIds: [...s.exitRateIds] }));
  const add = (ids: string[], unit: string) => {
    let n = list.length + 1;
    while (list.some((s) => s.id === `s${n}`)) n++;
    const s: SurvivorSpec = { id: `s${n}`, exitRateIds: ids, ...(unit !== MAIN ? { unit } : {}) };
    list.push(s);
    return s;
  };
  // 같은 탈퇴 사유라도 계약 단위가 다르면 다른 유지자 — 특약은 독립특약이라 주계약의 유지자를 함께 쓰지 않는다
  const byExits = (ids: string[], unit: string) => list.find((s) => idsKey(s.exitRateIds) === idsKey(ids) && (s.unit?.trim() || MAIN) === unit);
  const benefitOf = spec.benefits.map((b) => {
    const named = b.survivorId ? list.find((s) => s.id === b.survivorId) : undefined;
    if (named) return named.id;
    const ids = exitsOf(spec, b).map((r) => r.id);
    const hit = byExits(ids, unitOf(b));
    if (hit) return hit.id;
    return add(ids, unitOf(b)).id;
  });
  const payOf = new Map<string, string>();
  for (const unit of unitNames(spec)) {
    if (!spec.benefits.some((b) => unitOf(b) === unit)) continue;
    const marked = list.find((s) => s.payFor?.includes(unit));
    if (marked) { payOf.set(unit, marked.id); continue; }
    // 적힌 [납입] 이 없으면 — 그 단위 담보 공통 탈퇴 사유 + 납입면제 사유의 생존자(같은 사유의 생존자가 있으면 그것)
    const ids = payCauses(spec, unit).map((r) => r.id);
    const s = byExits(ids, unit) ?? add(ids, unit);
    s.payFor = [...(s.payFor ?? []), unit];
    payOf.set(unit, s.id);
  }
  return { survivors: list, benefitOf, payOf };
}

/** 조건에 생존자가 없을 때 만들어지는 생존자(옛 조건 · 다른 앱의 JSON) — survivorsOf 의 생존자 목록 */
export const deriveSurvivors = (spec: MethodSpec) => survivorsOf({ ...spec, survivors: undefined, benefits: spec.benefits.map((b) => ({ ...b, survivorId: undefined })) });

/**
 * 생존자가 적힌 조건을 담보 쪽 칸과 맞춘다 — 담보의 탈퇴 위험률 = 그 생존자의 것, 납입면제 = [납입] 생존자의 사유 가운데 그 단위 담보 공통이 아닌 것.
 * 다른 앱(자유설계보험)은 담보의 탈퇴 위험률·납입면제로 계산하므로 MethodSpec 을 내기 전에 늘 맞춘다.
 */
export function syncFromSurvivors(spec: MethodSpec): MethodSpec {
  if (!spec.survivors?.length) return spec;
  const { survivors, benefitOf, payOf } = survivorsOf(spec);
  const byId = new Map(survivors.map((s) => [s.id, s]));
  // 탈퇴 사유가 없는 생존자(암입원 — 빠지는 사유 없음)는 담보에 빈 칸을 남기지 않는다(옛 조건과 같게)
  const benefits = spec.benefits.map((b, i) => {
    const ids = byId.get(benefitOf[i])?.exitRateIds ?? [];
    const x: BenefitSpec = { ...b, survivorId: benefitOf[i], exitRateIds: [...ids] };
    if (!ids.length) delete x.exitRateIds;
    return x;
  });
  const synced: MethodSpec = { ...spec, benefits };
  const waiver = new Set<string>();
  for (const [unit, sid] of payOf) {
    const lists = benefits.filter((b) => unitOf(b) === unit).map((b) => b.exitRateIds ?? []);
    const common = (lists[0] ?? []).filter((id) => lists.every((l) => l.includes(id)));
    for (const id of byId.get(sid)?.exitRateIds ?? []) if (!common.includes(id)) waiver.add(id);
  }
  const ids = [...waiver].filter((id) => spec.rates.find((r) => r.id === id)?.role !== "waiver");
  return { ...synced, basis: { ...spec.basis, waiver: waiver.size > 0, waiverRateIds: ids.length ? ids : undefined } };
}

/** 적힌 생존자가 담보·납입면제에서 만들어지는 것과 같으면 지운다 — 되읽은 문서가 옛 조건과 같은 모양으로 남게(이름을 따로 준 것은 둔다) */
export function compactSurvivors(spec: MethodSpec): MethodSpec {
  if (!spec.survivors?.length || spec.survivors.some((s) => s.name)) return spec;
  const synced = syncFromSurvivors(spec);
  const plain: MethodSpec = { ...synced, survivors: undefined, benefits: synced.benefits.map((b) => { const x = { ...b }; delete x.survivorId; return x; }) };
  const d = deriveSurvivors(plain);
  const view = (x: { survivors: SurvivorSpec[]; benefitOf: string[]; payOf: Map<string, string> }) => {
    const key = (id?: string) => { const s = x.survivors.find((y) => y.id === id); return s ? `${idsKey(s.exitRateIds)}@${s.unit?.trim() || MAIN}` : ""; };
    // 차례도 견준다 — lx(k) 의 k 가 바뀌면 같은 조건이 아니다
    return JSON.stringify({ s: x.survivors.map((y) => key(y.id)), b: x.benefitOf.map(key), p: [...x.payOf].map(([u, id]) => `${u}:${key(id)}`).sort() });
  };
  return view(d) === view(survivorsOf(synced)) ? plain : synced;
}

// ── 위험률 합성 ──────────────────────────────────────────────────────────────
/** 합성 이름 — 사유를 잇는다: "사망·80% 이상 장해 결합" */
export const comboLabel = (rates: RateRef[]) => `${rates.map(reasonOf).join("·")} 결합`;

/** 급부 위험률(rateId)이 위험률 합성이면 그 합성 */
export const comboOfId = (spec: MethodSpec, id?: string) => (id ? combosOf(spec).find((c) => c.id === id) : undefined);

/**
 * 위험률 합성 목록 — 조건에 적힌 것(combos), 그 뒤에 유지자의 대상 위험률 · 보험금의 급부 사유 가운데 둘 이상을 묶었는데
 * 아직 합성이 없는 것(옛 조건 · 다른 앱의 JSON). 위험률 차례는 위험률 표의 차례로 맞춘다.
 */
export function combosOf(spec: MethodSpec): ComboSpec[] {
  const order = (ids: string[]) => spec.rates.map((r) => r.id).filter((id) => ids.includes(id));
  const list: ComboSpec[] = (spec.combos ?? []).map((c) => ({ ...c, rateIds: order(c.rateIds) }));
  const has = (ids: string[]) => list.some((c) => idsKey(c.rateIds) === idsKey(ids) || idsKey(illsOf(spec, c.rateIds)) === idsKey(ids));
  const add = (raw: string[]) => {
    const ids = order(raw);
    if (ids.length < 2 || has(ids)) return;
    let n = list.length + 1;
    while (list.some((c) => c.id === `c${n}`) || spec.rates.some((r) => r.id === `c${n}`)) n++;
    list.push({ id: `c${n}`, rateIds: ids });
  };
  for (const s of survivorsOf(spec).survivors) add(s.exitRateIds);
  for (const b of spec.benefits) if (!list.some((c) => c.id === b.rateId)) add(eventCauses(spec, b).map((r) => r.id));
  return list;
}
/** 사망 아닌 위험률만 — 사망과 질병을 함께 묶은 합성은 질병끼리의 곱 R 을 안에 둔다 */
const illsOf = (spec: MethodSpec, ids: string[]) => ids.filter((id) => { const r = spec.rates.find((x) => x.id === id); return r && r.role !== "death"; });

/** 적힌 위험률 합성이 유지자·보험금에서 만들어지는 것과 같으면 지운다(이름을 준 것 · 보험금이 고른 것은 둔다) — 되읽은 문서가 옛 조건과 같은 모양으로 */
export function compactCombos(spec: MethodSpec): MethodSpec {
  if (!spec.combos?.length || spec.combos.some((c) => c.name) || spec.benefits.some((b) => spec.combos!.some((c) => c.id === b.rateId))) return spec;
  const plain: MethodSpec = { ...spec, combos: undefined };
  const view = (cs: ComboSpec[]) => JSON.stringify(cs.map((c) => [c.id, idsKey(c.rateIds)]));
  return view(combosOf(plain)) === view(combosOf(spec)) ? plain : spec;
}

/** 위험률 합성 하나 — 기호 Q^{(j)}(사망이 들면) · R^{(j)}(질병끼리) 와 정의 식 */
export interface ComboModel {
  id: string;
  j: number;
  /** 대표 기호 — Q^{(j)} 또는 R^{(j)} */
  sym: string;
  /** 사망과 질병 둘 이상을 묶으면 안의 질병 곱 R^{(j)} */
  ill?: string;
  label: string;
  /** 조건에 적힌 합성이면 combos[] 의 자리(아니면 -1) */
  index: number;
  rates: RateRef[];
  syms: { sym: string; rate: RateRef }[];
  /** 산출방법서 표의 행 — 기호 · 이름 · 식 */
  rows: { sym: string; label: string; line: string }[];
  /** 계산에 쓰는 정의 식(행의 식) */
  lines: string[];
}

export function comboModels(spec: MethodSpec): ComboModel[] {
  const symOf = rateSymbols(spec);
  return combosOf(spec).map((c, i) => {
    const j = i + 1, sup = `^{(${j})}`;
    const rates = c.rateIds.map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);
    const syms = rates.map((rate) => ({ rate, sym: symOf.get(rate.id) ?? "r" }));
    const ds = syms.filter((x) => x.rate.role === "death").map((x) => x.sym), is = syms.filter((x) => x.rate.role !== "death").map((x) => x.sym);
    const label = c.name?.trim() || comboLabel(rates);
    const rows: ComboModel["rows"] = [];
    const qd = !ds.length ? "" : ds.length === 1 ? at(ds[0]) : `( ${productText(ds)} )`;
    if (is.length > 1) rows.push({ sym: `R${sup}`, label: ds.length ? comboLabel(rates.filter((r) => r.role !== "death")) : label, line: `R${sup}_{x+t} = ${productText(is)}` });
    const R = is.length > 1 ? `R${sup}_{x+t}` : is.length ? at(is[0]) : "";
    if (qd && R) rows.push({ sym: `Q${sup}`, label, line: `Q${sup}_{x+t} = min( 1, ${withDeath(qd, R)} )` });
    else if (ds.length > 1) rows.push({ sym: `Q${sup}`, label, line: `Q${sup}_{x+t} = min( 1, ${productText(ds)} )` });
    else if (!rows.length && syms.length) rows.push({ sym: `${ds.length ? "Q" : "R"}${sup}`, label, line: `${ds.length ? "Q" : "R"}${sup}_{x+t} = ${at(syms[0].sym)}` });
    const main = rows[rows.length - 1]?.sym ?? `R${sup}`;
    const index = (spec.combos ?? []).findIndex((x) => x.id === c.id);
    return { id: c.id, j, sym: main, ...(rows.length > 1 ? { ill: rows[0].sym } : {}), label, index, rates, syms, rows, lines: rows.map((r) => r.line) };
  });
}
/** 위험률 묶음의 합성 기호 — 합성의 대표 기호(같은 묶음) 또는 안의 질병 곱(질병만 같은 묶음) */
export function comboFor(combos: ComboModel[], spec: MethodSpec, ids: string[]): ComboUse | undefined {
  const k = idsKey(ids);
  const hit = (combo: ComboModel, sym: string): ComboUse => ({ combo, sym, lines: combo.lines.slice(0, combo.rows.findIndex((r) => r.sym === sym) + 1) });
  for (const c of combos) if (idsKey(c.rates.map((r) => r.id)) === k) return hit(c, c.sym);
  for (const c of combos) if (c.ill && idsKey(illsOf(spec, c.rates.map((r) => r.id))) === k) return hit(c, c.ill);
  return undefined;
}
/** 합성을 가져다 쓰는 자리 — 쓰는 기호와 계산에 함께 실을 정의 식(그 기호까지) */
export interface ComboUse { combo: ComboModel; sym: string; lines: string[] }

/** 생존자 lx(k) 하나 — 기준 인원 · 결합 탈퇴율(R · Q) · lx · Dx · Nx */
export interface SurvivorModel {
  id: string;
  /** lx(k) 의 k — 1 부터 */
  k: number;
  /** "사망, 80% 이상 장해 아닌 유지자" 또는 적은 이름 */
  label: string;
  /** 산출방법서 유지자 표의 칸 — 대상 위험률(합성 기호 Q^{(j)} 또는 위험률 하나 — 합성 식은 나. 기호의 정의) · 계산기수(l 의 점화식) */
  cells: { rate: string; recur: string };
  /** 대상 위험률이 위험률 합성이면 그 합성 */
  combo?: ComboUse;
  unit?: string;
  /** 그 계약 단위의 보험료 납입기수(N*)에 쓰는지 — 쓰는 단위 */
  payUnits: string[];
  exits: RateRef[];
  syms: { sym: string; rate: RateRef }[];
  lapseRate?: number;
  /** 이 lx 를 쓰는 담보 번호 */
  benefitIdx: number[];
  legend: string[];
  lines: string[];
  note: string;
}

/** 생존자마다 lx(k) 식 — l^{(k)} · Q^{(k)} · R^{(k)} · D^{(k)} · N^{(k)} */
export function survivorModels(spec: MethodSpec, combos: ComboModel[] = comboModels(spec)): SurvivorModel[] {
  const lapseRate = (spec.basis.lapse ?? []).find((l) => l.rate > 0)?.rate;
  const lapse = lapseRate !== undefined;
  const { survivors, benefitOf, payOf } = survivorsOf(spec);
  const symOf = rateSymbols(spec);
  return survivors.map((s, i) => {
    const k = i + 1, sup = `^{(${k})}`;
    const exits = s.exitRateIds.map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);
    const syms = exits.map((rate) => ({ rate, sym: symOf.get(rate.id) ?? "r" }));
    const deaths = syms.filter((x) => x.rate.role === "death");
    const legend = syms.map((x) => `${x.sym}_x : ${x.rate.name}`);
    if (lapse) legend.push("w_x : 적용해지율 (납입기간 중)");
    const lines: string[] = ["기준 인원", `l${sup}_x = 100,000`];
    // 둘 이상이면 위험률 합성(나. 기호의 정의) — 계산에 쓰려고 그 정의 식을 함께 싣는다
    const combo = exits.length > 1 ? comboFor(combos, spec, exits.map((r) => r.id)) : undefined;
    if (combo) lines.push(`탈퇴율 — 위험률 합성 (${combo.combo.j}) ${combo.combo.label}`, ...combo.lines);
    const Q = combo ? at(combo.sym) : syms.length ? at(syms[0].sym) : "";
    const expr = !Q ? "1" : lapse ? `1 − ${Q} − w_{x+t} + ${Q}·w_{x+t}/2` : `1 − ${Q}`;
    lines.push("유지자수 — 탈퇴 사유가 생긴 사람을 뺀다", `l${sup}_{x+t+1} = l${sup}_{x+t} × ( ${expr} )`,
      "현가와 누계", `D${sup}_{x+t} = l${sup}_{x+t}·v^t`, `N${sup}_{x+t} = Σ_{u≥t} D${sup}_{x+u}`);
    const benefitIdx = benefitOf.flatMap((id, bi) => (id === s.id ? [bi] : []));
    const payUnits = [...payOf].filter(([, id]) => id === s.id).map(([u]) => u);
    const notes = [
      benefitIdx.length ? `${benefitIdx.map((bi) => spec.benefits[bi].name).join(" · ")} 보험금이 이 lx 를 쓴다.` : "",
      payUnits.length ? `${payUnits.join(" · ")}의 보험료 납입기수(N*)에 쓴다.` : "",
      !syms.length ? "탈퇴 사유가 없어 기준 인원이 그대로 유지된다." : syms.length && !deaths.length ? "사망은 탈퇴 사유가 아니다 — 사망 시 책임준비금을 지급하므로 질병 발생자만 탈퇴한다." : "",
    ].filter(Boolean);
    const cells = { rate: Q || "없음", recur: lines.find((l) => l.startsWith(`l${sup}_{x+t+1} =`))!.replace(" × ( 1 )", "") };
    return { id: s.id, k, label: s.name?.trim() || keepLabel(exits), ...(s.unit ? { unit: s.unit } : {}), payUnits, exits, syms, lapseRate, benefitIdx, legend, lines, cells, ...(combo ? { combo } : {}), note: notes.join(" ") };
  });
}

/** 질병(사망 아닌 사유)끼리의 결합 — 따로 생긴다고 보고 곱으로: 1 − ( 1 − r⁽¹⁾ )·( 1 − r⁽²⁾ )… */
export function productText(syms: string[]): string {
  return `1 − ${syms.map((x) => `( 1 − ${at(x)} )`).join("·")}`;
}
/** 사망과 (질병을 묶은) 다른 사유의 결합 — 겹치는 부분을 절반으로: q + R − q·R/2 */
const withDeath = (q: string, d: string) => `${q} + ${d} − ${q}·${d}/2`;

// ── 보험금 ──────────────────────────────────────────────────────────────────
export interface BenefitModel {
  idx: number;
  b: BenefitSpec;
  /** 이 담보가 쓰는 생존자 lx(k) */
  survivor: SurvivorModel;
  /** 그 계약 단위의 [납입] 생존자 — 보험료(N*)는 이 lx 로 낸다 */
  pay: SurvivorModel;
  /** 급부 위험률의 기호 — 따로 고른 위험률(rateId), 아니면 생존자의 탈퇴 사유에서 */
  event?: { sym: string; rate: RateRef };
  /** 급부 위험률이 위험률 합성이면 그 합성(따로 고른 것 · 질병 여럿) — 계산에는 그 합성의 위험률 계열이 든다 */
  combo?: ComboUse;
  /** 지급자수에 곱하는 발생률 식 — q_{x+t} · Q^{(k)}_{x+t} · R^{(k)}_{x+t} · r^{(i)}_{x+t} (산출방법서 보험금 표) */
  ev: string;
  legend: string[];
  lines: string[];
  note?: string;
  /**
   * 지급자수 d 의 식. 문서에는 싣지 않는다 — 급부 발생자의 현가 C 식에서 v^{t+½} 를 뺀 부분이다.
   * 계산 표(calc.ts `calcSheets`)가 생존자수와 나란히 보여 주려고 쓴다.
   */
  payout: string;
}

/** 면책 개월 — 계산하는 앱(자유설계보험)과 같은 환산(30.4일 = 1개월) */
export const waitMonths = (days?: number) => (days ? Math.round(days / 30.4) : 0);

/** 급부 위험률 — 따로 고른 rateId(사망형도), 없으면 그 담보의 탈퇴 사유 가운데 사망이 아닌 것이 하나일 때 그것 */
export function eventRate(spec: MethodSpec, b: BenefitSpec): RateRef | undefined {
  const named = spec.rates.find((r) => r.id === b.rateId);
  if (named) return named;
  if (b.role === "death" || spec.combos?.some((c) => c.id === b.rateId)) return undefined;
  const causes = eventCauses(spec, b);
  return causes.length === 1 ? causes[0] : undefined;
}

/** 급부를 일으키는 탈퇴 사유 — 따로 고른 급부 위험률이 없으면 사망이 아닌 탈퇴 사유 전부(3대질병 진단처럼 여럿일 수 있다). 위험률 합성을 골랐으면 그 합성의 사망 아닌 위험률 */
export function eventCauses(spec: MethodSpec, b: BenefitSpec): RateRef[] {
  if (b.role === "death" || spec.rates.some((r) => r.id === b.rateId)) return [];
  const picked = b.rateId ? spec.combos?.find((c) => c.id === b.rateId) : undefined;
  return (picked?.rateIds ?? b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r && r.role !== "death");
}

/** 연령 구간 배수 → if 식. 구간이 있으면 덮이지 않은 나이는 0 배다(자유설계보험 stepMultiple 과 같다) */
function stepsText(b: BenefitSpec): string | undefined {
  if (!b.steps?.length) return undefined;
  return b.steps.reduce((acc, s) => `if( ${s.fromAge} ≤ x+t ≤ ${s.toAge}, ${s.multiple}, ${acc} )`, "0");
}

/** 면책·삭감 → 보장금액 배수의 인자. 기간 mo 개월 동안 지급 비율 ratio (면책 0) — 첫해(12개월 안)면 if, 더 길면 해마다 겹치는 만큼 */
export function waitFactor(b: BenefitSpec): string | undefined {
  // 면책(지급 0)과 삭감(계약일부터, 지급률 ρ)이 함께 — 그 해에 겹치는 만큼: 1 − 면책 몫 − (1 − ρ)·(삭감 몫 − 면책 몫)
  if (b.reduceDays) {
    const c = coverTerms(b), a = waitMonths(c.wait), r = waitMonths(c.reduce), cut = Math.round((1 - (c.ratio ?? 0.5)) * 1e6) / 1e6;
    const part = (mo: number) => `max( 0, min( 1, ${mo}/12 − t ) )`;
    return a ? `( 1 − ${part(a)} − ${cut}×( ${part(r)} − ${part(a)} ) )` : `( 1 − ${cut}×${part(r)} )`;
  }
  const mo = waitMonths(b.waitDays);
  if (!mo) return undefined;
  const ratio = b.waitPayRatio ?? 0;
  const cut = ratio ? `${1 - ratio}×` : "";
  return mo <= 12 ? `if( t = 0, 1 − ${cut}${mo}/12, 1 )` : `( 1 − ${cut}max( 0, min( 1, ${mo}/12 − t ) ) )`;
}
/** 면책·삭감 표기 — "90일 면책" · "2년 50% 삭감" */
/** 기간 표기 — 365 의 배수면 "2년", 아니면 "90일" */
export const daysLabel = (d?: number) => (!d ? "없음" : d % 365 === 0 ? `${d / 365}년` : `${d}일`);
export const waitLabel = (b: BenefitSpec) => {
  if (b.reduceDays) { const c = coverTerms(b); return `${daysLabel(c.wait)} 면책 · ${daysLabel(c.reduce)} ${Math.round((c.ratio ?? 0.5) * 100)}% 삭감`; }
  if (!b.waitDays) return "없음";
  const days = b.waitDays % 365 === 0 ? `${b.waitDays / 365}년` : `${b.waitDays}일`;
  const ratio = b.waitPayRatio ?? 0;
  return `${days} ${ratio ? `${Math.round(ratio * 100)}% 삭감` : "면책"}`;
};

export function benefitModels(spec: MethodSpec): BenefitModel[] {
  const combos = comboModels(spec);
  const survs = survivorModels(spec, combos);
  const { benefitOf, payOf } = survivorsOf(spec);
  const symOf = rateSymbols(spec);
  return spec.benefits.map((b, idx) => {
    const survivor = survs.find((x) => x.id === benefitOf[idx])!;
    const pay = survs.find((x) => x.id === payOf.get(unitOf(b)))!;
    const sup = `^{(${survivor.k})}`, psup = `^{(${pay.k})}`;
    const lapse = survivor.lapseRate !== undefined;
    const half = lapse ? "·( 1 − w_{x+t}/2 )" : "";
    const legend: string[] = [];
    let event: BenefitModel["event"];
    const rate = eventRate(spec, b);
    if (rate) {
      event = survivor.syms.find((x) => x.rate === rate) ?? { sym: symOf.get(rate.id) ?? "g", rate };
      if (!survivor.syms.includes(event)) legend.push(`${event.sym}_x : ${rate.name}`);
    }
    // 사망형은 탈퇴 사유 전부(그 유지자의 대상 위험률), 고른 위험률 합성이면 그 기호, 사망 아닌 탈퇴 사유가 여럿이면(3대질병) 그 합성 R
    const causes = eventCauses(spec, b);
    const pick = combos.find((c) => c.id === b.rateId);
    let combo: ComboUse | undefined = pick ? { combo: pick, sym: pick.sym, lines: pick.lines } : undefined;
    if (!rate && !combo && b.role !== "death" && causes.length > 1) combo = comboFor(combos, spec, causes.map((r) => r.id));
    const one = (r: RateRef) => survivor.syms.find((x) => x.rate === r)?.sym ?? symOf.get(r.id) ?? "g";
    const ev = rate ? at(event!.sym) : combo ? at(combo.sym)
      : b.role === "death" ? (survivor.combo ? at(survivor.combo.sym) : survivor.syms.length ? at(survivor.syms[0].sym) : "g_{x+t}")
      : causes.length ? at(one(causes[0])) : "g_{x+t}";
    // 합성의 정의 식이 유지자 식에 없으면 보험금 식에 함께 싣는다(계산용)
    const defined = (x: ComboUse) => [survivor, pay].some((sv) => sv.combo?.lines.some((l) => l.startsWith(`${x.sym}_{x+t} =`)));
    const payout = `d_{x+t} = l${sup}_{x+t}·${ev}${half}`;
    const lines: string[] = [
      ...(combo && !defined(combo) ? [`급부 위험률 — 위험률 합성 (${combo.combo.j}) ${combo.combo.label}`, ...combo.lines] : []),
      `대상자수 — lx(${survivor.k}) ${survivor.label} 를 가져다 쓴다`, `l_{x+t} = l${sup}_{x+t}`, `D_{x+t} = D${sup}_{x+t}`, `N_{x+t} = N${sup}_{x+t}`,
      `보험료 납입 — 유지자 lx(${pay.k}) (${unitOf(b)} [납입])`, `D′_{x+t} = D${psup}_{x+t}`, `N′_{x+t} = N${psup}_{x+t}`,
    ];
    // 보장금액 배수 S — 연령 구간 배수 × 면책·삭감
    const wf = waitFactor(b), steps = stepsText(b);
    const survival = b.role === "other" && !!b.points?.length;
    const parts = [survival ? "0" : steps ?? "1", ...(wf && !survival ? [wf] : [])];
    lines.push(wf ? `보장금액의 배수 — ${waitLabel(b)}${b.reduceDays ? "" : `이라 그 동안은 ${b.waitPayRatio ? `${Math.round(b.waitPayRatio * 100)}% 만` : "지급하지 않는다"}`}` : "보장금액의 배수", `S_t = ${parts.join(" × ")}`);
    lines.push(b.role === "death" && !rate ? "급부 발생자 — 탈퇴자 전부가 급부 대상이다" : "급부 발생자", `C_{x+t} = l${sup}_{x+t}·${ev}${half}·v^{t+½}`);
    lines.push("보험금 현가의 누계", "M_{x+t} = Σ_{u=t}^{n−1} S_u·C_{x+u}");
    if (survival) {
      lines.push("생존 지급 시점의 배수", `E_t = ${b.points!.map((p) => `if( t = ${p.age} − x, ${p.multiple}, 0 )`).join(" + ")}`,
        "보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x + Σ_{u=0}^{n} E_u·D_{x+u}");
    } else lines.push("보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x");
    // 급부 위험률을 따로 정한 진단형(암수술 등)은 지급 사유가 탈퇴 사유와 달라 "소멸" 문장이 맞지 않는다
    const note = b.role === "incidence" && !b.rateId ? "진단 확정 시 지급하고 그 담보는 소멸한다." : undefined;
    return { idx, b, survivor, pay, event, ...(combo ? { combo } : {}), ev: `${ev}${half}`, legend, lines, payout, ...(note ? { note } : {}) };
  });
}

/**
 * 산출방법서 마. 보장의 보험금의 현가 — 보장마다 배수 × 누계 M 의 차(사용자 양식 2026-10-05):
 *   종신 · 면책 없음        1·M_x
 *   n 년 만기               1·( M_x − M_{x+n} )
 *   90일 면책               0.5·( M_{x+0.25} − M_{x+n} )      — 면책이 끝난 때부터 (M 은 Σ C, 연 단위 자리는 면책 개월 ÷ 12)
 *   면책 + 삭감(ρ)          1·( ρ·( M_{x+a} − M_{x+r} ) + M_{x+r} − M_{x+n} )
 * 문서에 싣는 표시다(계산은 보험금 식의 S_t 로 한다). 연령 구간 배수·생존급부·사람이 S_t 를 고친 보장은 그 S_t 줄과 Σ S_u·C 로 적는다.
 * spec 은 withFormulas 를 거친 것 — 고친 식(edited)을 알아본다.
 */
export function pvbLines(spec: MethodSpec, models: BenefitModel[]): string[] {
  const sLine = (text?: string) => text?.split("\n").find((l) => l.startsWith("S_t ="));
  const at = (mo: number) => (!mo ? "M_x" : `M_{x+${mo % 3 === 0 ? String(mo / 12) : `${mo}/12`}}`);
  const special: string[] = [];
  const terms = models.map((m) => {
    // 정액(일당 등)은 배수 없이. 적립형은 보장금액 1원당(배수는 위험보험료 식 P^{위험} = 배수 × P 에서 곱한다)
    const b = m.b, k = b.multiple !== undefined && !spec.savings ? `${b.multiple}·` : "";
    // 적립형은 보험기간(n — 5·10·15년)이 곧 보장기간이다(만기 나이가 아니다)
    const tail = !spec.savings && (!b.endAge || b.endAge >= WHOLE_LIFE_AGE) ? "" : " − M_{x+n}";
    const own = spec.formulas.find((f) => f.key === `benefit:${b.id}` && f.edited);
    const s = sLine(own?.text);
    if (b.steps?.length || b.points?.length || (s && s !== sLine(m.lines.join("\n")))) {
      special.push(b.name, s ?? sLine(m.lines.join("\n"))!);
      return `${k}Σ_{u=0}^{n−1} S_u·C_{x+u}`;
    }
    const c = coverTerms(b), a = waitMonths(c.wait), r = waitMonths(c.reduce);
    const body = r ? `${c.ratio ?? 0.5}·( ${at(a)} − ${at(r)} ) + ${at(r)}${tail}` : `${at(a)}${tail}`;
    return body === "M_x" ? `${k}M_x` : `${k}( ${body} )`;
  });
  return [...special, `PVB = ${terms.join(" + ")}`];
}

/** 보장금액 표기 — "가입금액의 0.5배" · "50,000,000원" */
export const amountLabel = (b: BenefitSpec) =>
  b.multiple !== undefined ? `${b.base === "premium" ? "보험료" : "가입금액"}의 ${b.multiple}배` : b.amount !== undefined ? `${Math.round(b.amount).toLocaleString("ko-KR")}원${b.role === "recurring" ? "/일" : ""}` : "—";

// ── 공통 — 현가와 보험료 ─────────────────────────────────────────────────────
/** 담보마다 똑같은 식: 현가(D′ · N′ · N* — 보험료 쪽 / D · N — 보험금 쪽)와 보험료(P · G · 반올림) */
export function commonModels(spec: MethodSpec): { key: string; section: string; label: string; path: string; lines: string[]; note?: string }[] {
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const meth = isMethodExpenses(spec);
  const I = "basis.interest";
  const BEN = "보험금", PREM = "순보험료 및 영업보험료";
  return [
    ...(lapse ? [{ key: "pv:H", section: BEN, label: "해지자의 현가 (H)", path: `${I}|basis.lapse`, lines: ["H_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}"],
      note: "l 은 그 담보가 쓰는 생존자 lx 다." }] : []),
    { key: "pv:NStar", section: PREM, label: "연납 환산 납입기수 (N*)", path: `${I}|expenses`,
      lines: ["N* = k · [ ( N′_x − N′_{x+m} ) − ( k−1 )/( 2·k )·( D′_x − D′_{x+m} ) ]"] },
    { key: "premium:P", section: PREM, label: "순보험료 (P)", path: "benefits", lines: ["P = PVB / N*"] },
    { key: "premium:base", section: PREM, label: "기준연납순보험료", path: "benefits|expenses", lines: ["P_base = PVB / ( N′_x − N′_{x+min(n,20)} )"] },
    { key: "premium:G", section: PREM, label: "영업보험료", path: "expenses", lines: [meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/k + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )"],
      note: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다." },
    { key: "premium:round", section: PREM, label: "1원당 보험료의 반올림과 10만원당 보험료", path: "benefits", lines: [
      "1원당 영업보험료 — 소수 여섯째 자리까지", "G₁ = round₆( G )",
      "10만원당 보험료 — 원 단위로 반올림", "G_{10만} = round( G₁ × 100,000 )"],
      note: "담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000) 에서 10원 미만을 버린다(10원 단위). 보장금액 = 보험가입금액 × 배수. 여러 담보는 담보 보험료를 더한다." },
  ];
}

/** 담보 칸 — 보험금의 현가 식과 산출방법서 담보 표가 이 칸들에 기댄다 */
export const BENEFIT_FIELDS = ["name", "unit", "role", "endAge", "multiple", "base", "amount", "waitDays", "waitPayRatio", "reduceDays", "reduceRatio", "survivorId", "exitRateIds", "rateId"] as const;

// ── 산출방법서에 실을 식 ─────────────────────────────────────────────────────
export function generateFormulas(spec: MethodSpec): FormulaSpec[] {
  const out: FormulaSpec[] = [];
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const low = lapse && spec.basis.lowRatio !== undefined;
  const idx = (r: RateRef) => `rates[${spec.rates.indexOf(r)}]`;
  const multi = spec.benefits.length > 1;
  // 싣는 차례 — 계약 단위(주계약 → 특약 순) 안에서 조건의 담보 순서. 담보를 더하면 그 단위의 끝에 붙는다
  const units = unitNames(spec);
  const rank = (i: number) => units.indexOf(unitOf(spec.benefits[i])) * 1e4 + i;
  const benefits = benefitModels(spec).sort((a, b) => rank(a.idx) - rank(b.idx));

  // 다. 생존자 — lx(k) 마다(유지자수·납입자수를 나누지 않는다). 담보의 생존자 칸·탈퇴 위험률·생존자 행 어느 것을 골라도 이 식이 비친다
  for (const sv of survivorModels(spec)) {
    const j = (spec.survivors ?? []).findIndex((x) => x.id === sv.id);
    out.push({
      section: "유지자", key: `surv:${sv.id}`,
      path: [...(j >= 0 ? [`survivors[${j}]`] : []), ...sv.benefitIdx.flatMap((bi) => [`benefits[${bi}].survivorId`, `benefits[${bi}].exitRateIds`]), ...sv.exits.map(idx),
        ...(sv.payUnits.length ? ["basis.waiver", "basis.waiverRateIds"] : []), ...(lapse ? ["basis.lapse"] : []), "basis.interest"].join("|"),     // 이율 → 현가 Dx · 누계 Nx
      label: `유지자수 lx(${sv.k}) — ${sv.label}`,
      text: [...sv.legend, ...(sv.legend.length ? [""] : []), ...sv.lines].join("\n"),
      ...(sv.note ? { note: sv.note } : {}),
    });
  }

  // 라. 보험금 — 담보마다(해지율이 있으면 해지자의 현가 먼저)
  const common = commonModels(spec);
  const put = (c: (typeof common)[number]) => out.push({ section: c.section, key: c.key, label: c.label, path: c.path, text: c.lines.join("\n"), ...(c.note ? { note: c.note } : {}) });
  common.filter((c) => c.key === "pv:H").forEach(put);
  for (const m of benefits) {
    out.push({
      section: "보험금", key: `benefit:${m.b.id}`,
      // 담보 칸마다(이름·유형·보험기간·배수·면책·생존자·급부 위험률) — 그 칸을 고르면 이 식이 비친다
      path: [...BENEFIT_FIELDS.map((k) => `benefits[${m.idx}].${k}`), ...(m.event && !m.survivor.syms.includes(m.event) ? [idx(m.event.rate)] : [])].join("|"),
      label: `보험금 — ${multi ? `${m.b.unit ? `${m.b.unit} ` : ""}${m.b.name}` : m.b.name}`,
      text: [...m.legend, ...(m.legend.length ? [""] : []), ...m.lines].join("\n"),
      ...(m.note ? { note: m.note } : {}),
    });
  }
  // 적립형(공시이율형 저축보험) — 유지자·보험금은 그대로, 보험료는 정해져 있으므로 N* · P(보장부분 순보험료)까지만 내고
  // 보험료의 구성(위험보험료 · 사업비 · 적립보험료) · 계약자적립액 · 환급금 식을 더한다(savings.ts)
  if (spec.savings) {
    common.filter((c) => c.key === "pv:NStar" || c.key === "premium:P").forEach((c) => put({ ...c, section: SAVE_PREMIUM }));
    out.push(...savingsFormulas(spec));
    return out;
  }
  common.filter((c) => c.key === "pv:NStar").forEach(put);
  common.filter((c) => c.key.startsWith("premium:")).forEach(put);

  // 보험료의 계산에 딸린 것 — 저해지·무해지
  if (low) out.push({ section: "순보험료 및 영업보험료", key: "premium:low", label: "저해지·무해지환급형", path: "basis.lowRatio", text: [
    "납입기간 중 해지하면 돌려주는 금액의 현가",
    "CSV_t = Σ_{u≥t} H_{x+u} · ρ · ( W^{표준}_u + W^{표준}_{u+1} ) / 2",
    "저해지·무해지환급형 순보험료 — 해지 시 돌려주는 금액의 현가를 더한다",
    "PVB′ = PVB + CSV_0",
    "P = PVB′ / N*",
  ].join("\n"),
    note: "ρ : 납입기간 중 해지환급금 비율(무해지 0). W^{표준} : 같은 조건의 표준형(완전 환급) 해지환급금. 적용해지율 w = 0 이면 CSV = 0 이고 보험료가 표준형과 같아진다. 납입기간 뒤(u ≥ m)에는 H = 0 이라 더해지지 않는다. CSV 는 표준형 환급금과 서로 맞물려 되풀이 계산이 필요하므로 이 앱의 시산은 CSV = 0 으로 두고(표준형 보험료), 그 값은 자유설계보험이 낸다." });

  const dy = spec.surrender.deductionYears ?? 7;
  const meth = isMethodExpenses(spec);
  const survival = benefits.some((m) => m.b.role === "other" && m.b.points?.length);
  const R = "책임준비금의 계산에 관한 사항", S = "해지환급금의 계산에 관한 사항";
  out.push(
    { section: R, key: "reserve:P", label: "준비금 산출용 순보험료", path: "basis.standardInterest",
      text: ["납입 후 유지비를 포함한 순보험료 — 납입기간의 [납입] 유지자 현가로 나눈다",
        `P_β = ( PVB${low ? " + CSV_0" : ""} + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )`].join("\n") },
    { section: R, key: "reserve:V", label: "연말 책임준비금", path: "basis.standardInterest", text: [
      "t 년도 말 책임준비금 (보장금액 1원당) — 장래 보험금의 현가와 장래 유지비의 현가에서 장래 순보험료의 현가를 뺀 것을 t 시점 유지자수의 현가로 나눈다",
      `V_t = [ M_{x+t}${survival ? " + Σ_{u>t} E_u·D_{x+u}" : ""}${low ? " + CSV_t" : ""} + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}`,
      "10만원당 책임준비금 — 원 단위로 반올림",
      "V^{10만}_t = round( V_t × 100,000 )",
      ...(spec.basis.standardInterest !== undefined ? ["회계연도말 보험료적립금 — 둘 중 큰 금액", "V^{결산}_t = max( V_t, V^{표준}_t )"] : [])].join("\n"),
      note: "순보식에 납입 후 유지비 β′를 더한 형태. [t≤m] 은 납입기간 중이면 1, 아니면 0 이다. 표준준비금은 표준이율로 같은 식을 계산한다." },
    { section: S, key: "surrender:alpha", label: "해약공제 기준 신계약비", path: "surrender",
      text: meth ? "α^{공제} = min( α_S + α_P·round₅( P_base ), α^{표준} )" : "α^{공제} = α",
      ...(meth ? { note: "α^{표준} : 표준이율로 같은 식(P_base)을 계산해 구한 신계약비. 영업보험료 G 에는 반올림 전 P_base 를 쓴다." } : {}) },
    { section: S, key: "surrender:deduct", label: "해약공제", path: "surrender",
      text: [`납입기간과 ${dy}년 중 짧은 기간에 걸쳐 매년 균등하게 줄어든다`, `해약공제_t = α^{공제} · max( min(m,${dy}) − t, 0 ) / min(m,${dy})`].join("\n") },
    { section: S, key: "surrender:W", label: "표준형 해지환급금", path: "surrender",
      text: ["책임준비금에서 해약공제를 뺀 것 (0 미만이면 0)", "W^{표준}_t = max( V_t − 해약공제_t, 0 )", ...(low ? [] : ["W_t = W^{표준}_t"])].join("\n") },
    ...(low ? [{ section: S, key: "surrender:low", label: "저해지·무해지환급형 해지환급금", path: "surrender|basis.lowRatio",
      text: ["납입기간 중에는 표준형의 ρ 배, 납입 완료 후에는 표준형과 같다", "W_t = if( t < m, ρ·W^{표준}_t, W^{표준}_t )"].join("\n") }] : []),
    { section: S, key: "surrender:paid", label: "납입누계", path: "surrender", text: ["t 년까지 낸 보험료 (보장금액 1원당)", "납입누계_t = min(t, m) × k × G"].join("\n") },
    { section: S, key: "surrender:ratio", label: "환급률", path: "surrender", text: "환급률_t = W_t / 납입누계_t" },
  );
  return out;
}

/**
 * 조건의 식(사용자가 따로 적은 것)을 자동 생성 식에 얹는다. 같은 절·제목이면 사용자 글이 이기고,
 * 자리(path)와 짝(key)은 자동 식의 것을 그대로 지킨다 — 고친 식도 계산(calc.ts)과 대응 표시에 그대로 쓰인다.
 */
export function withFormulas(spec: MethodSpec): MethodSpec {
  const mine = new Map(spec.formulas.map((f, i) => [`${f.section}|${f.label}`, { f, i }]));
  const used = new Set<number>();
  const auto = generateFormulas(spec).map((a) => {
    const hit = mine.get(`${a.section}|${a.label}`);
    if (!hit) return a;
    used.add(hit.i);
    return { ...a, text: hit.f.text, ...(hit.f.note !== undefined ? { note: hit.f.note } : {}), edited: true as const };
  });
  return { ...spec, formulas: [...auto, ...spec.formulas.map((f, i) => ({ ...f, path: f.path ?? `formulas[${i}]` })).filter((_, i) => !used.has(i))] };
}
