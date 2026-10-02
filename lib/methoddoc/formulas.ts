import { endAgeLabel, waiverRates, type BenefitSpec, type FormulaSpec, type MethodSpec, type RateRef } from "./spec";

/**
 * 조건(MethodSpec) → 산출식. 앱 엔진 없이 조건만으로 산출방법서의 3장 이후를 만든다.
 *
 * 식은 산출 순서대로 묶는다 — 카드(조건 화면)와 절(산출방법서)이 같은 순서다.
 *   1장 라. 유지자수·납입자수     집단마다 유지자수 l (기준 인원·탈퇴율 Q·l) 과 납입자수 l′ (f·l′) — 두 덩이
 *   1장 마. 계산기수 — 보험료     납입자수 쪽: D′ · N′ · N*                      (카드 M05 보험료)
 *   1장 바. 계산기수 — 보험금     유지자수 쪽: D · N, 담보마다 S · C · M · PVB   (카드 B01 보장)
 *   1장 사. 순보험료 및 영업보험료 P · 기준연납순보험료 · G · 1원당 반올림 → 10만원당
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

// ── 집단 ────────────────────────────────────────────────────────────────────
/** 집단 이름 — 빠지는 사유에 X: "유지자(사망X, 80% 이상 장해X)" · "납입자(사망X, 80% 이상 장해X, 암X)" */
export const crowdLabel = (kind: "유지자" | "납입자", rates: RateRef[]) =>
  `${kind}(${rates.length ? rates.map((r) => `${reasonOf(r)}X`).join(", ") : "빠지는 사유 없음"})`;

/**
 * 유지자 집단 — 보험금을 받을 사람. 탈퇴 사유가 같은 담보는 l 이 똑같으므로 한 집단으로 묶어 한 번만 적는다.
 * 조건에 따로 적는 항목이 아니라 담보의 탈퇴 위험률(benefits[].exitRateIds)에서 나온다 — 집단을 고치면 그 담보들의 탈퇴 위험률이 바뀐다.
 * 보험금의 현가(C·M)와 유지자수의 현가 D·N(납입 후 유지비 · 책임준비금)이 이 l 을 쓴다. 납입자수 l′ 는 계약 단위마다 하나(payerModels).
 */
export interface GroupModel {
  id: string;
  /** "유지자(사망X, 80% 이상 장해X)" */
  label: string;
  exits: RateRef[];
  /** 탈퇴 위험률의 기호 */
  syms: { sym: string; rate: RateRef }[];
  /** 적용해지율 (없으면 undefined) */
  lapseRate?: number;
  /** 이 집단을 쓰는 담보 번호 */
  benefitIdx: number[];
  /** 유지자수 l 의 식 (기준 인원 · 탈퇴율 Q · l) */
  keep: { legend: string[]; lines: string[]; note: string };
}

const exitsOf = (spec: MethodSpec, b: BenefitSpec) =>
  (b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);

export function groupModels(spec: MethodSpec): GroupModel[] {
  const lapseRate = (spec.basis.lapse ?? []).find((l) => l.rate > 0)?.rate;
  const out: GroupModel[] = [];
  const keys: string[] = [];                            // 집단을 가르는 열쇠 — 탈퇴 위험률 id 를 이은 것
  spec.benefits.forEach((b, bi) => {
    const exits = exitsOf(spec, b);
    const key = exits.map((r) => r.id).join(",");
    const at = keys.indexOf(key);
    if (at >= 0) { out[at].benefitIdx.push(bi); return; }
    keys.push(key);
    const deaths = exits.filter((c) => c.role === "death"), others = exits.filter((c) => c.role !== "death");
    const dq = numbered("q", deaths.length), dr = numbered("r", others.length);
    const syms = exits.map((rate) => ({ rate, sym: rate.role === "death" ? dq[deaths.indexOf(rate)] : dr[others.indexOf(rate)] }));
    out.push({ id: `g${out.length + 1}`, label: crowdLabel("유지자", exits), exits, syms, lapseRate, benefitIdx: [bi], keep: keepText(syms, lapseRate) });
  });
  return out;
}

/**
 * 납입자 — 보험료를 낼 사람. 보험료 계산에는 계약 단위(주계약 · 특약)마다 하나만 쓴다.
 * 줄이는 사유 = 계약 전체를 끝내는 탈퇴 사유(그 단위 모든 담보에 공통 — 보통 사망) + 납입면제 사유.
 * 질병끼리는 곱으로 먼저 묶고(F), 사망이 있으면 겹치는 부분을 절반으로 결합한다(Q′).
 */
export interface PayerModel {
  id: string;
  unit: string;
  /** "납입자(사망X, 80% 이상 장해X, 암X)" */
  label: string;
  causes: RateRef[];
  syms: { sym: string; rate: RateRef }[];
  lapseRate?: number;
  benefitIdx: number[];
  legend: string[];
  lines: string[];
  note: string;
}

export function payerModels(spec: MethodSpec): PayerModel[] {
  const lapseRate = (spec.basis.lapse ?? []).find((l) => l.rate > 0)?.rate;
  const lapse = lapseRate !== undefined;
  const waivers = waiverRates(spec);
  const unitOfBen = (b: BenefitSpec) => b.unit?.trim() || "주계약";
  const units = [...new Set(spec.benefits.map(unitOfBen))];
  return units.map((unit, ui) => {
    const benefitIdx = spec.benefits.flatMap((b, i) => (unitOfBen(b) === unit ? [i] : []));
    const lists = benefitIdx.map((i) => exitsOf(spec, spec.benefits[i]));
    const common = lists[0].filter((r) => lists.every((l) => l.includes(r)));
    const causes = [...common, ...waivers.filter((w) => !common.includes(w))];
    const deaths = causes.filter((c) => c.role === "death"), ills = causes.filter((c) => c.role !== "death");
    const dq = numbered("q", deaths.length), df = numbered("f", ills.length);
    const syms = causes.map((rate) => ({ rate, sym: rate.role === "death" ? dq[deaths.indexOf(rate)] : df[ills.indexOf(rate)] }));
    const legend = syms.map((x) => `${x.sym}_x : ${x.rate.name}`);
    if (lapse) legend.push("w_x : 적용해지율 (납입기간 중)");
    const qd = !deaths.length ? "" : deaths.length === 1 ? at(dq[0]) : `( ${productText(dq)} )`;
    const lines: string[] = ["기준 인원", "l′_x = 100,000"];
    const F = ills.length > 1 ? "F_{x+t}" : ills.length ? at(df[0]) : "";
    if (ills.length > 1) lines.push("질병 발생률 — 납입을 멈추게 하는 질병끼리는 따로 생긴다고 보고 곱으로 결합한다", `F_{x+t} = ${productText(df)}`);
    let P = qd || F;
    if (qd && F) { P = "Q′_{x+t}"; lines.push("납입 탈퇴율 — 사망과는 겹치는 부분을 절반으로 보고, 1 을 넘지 않는다", `Q′_{x+t} = min( 1, ${withDeath(qd, F)} )`); }
    const expr = !P ? "1" : lapse ? `1 − ${P} − w_{x+t} + ${P}·w_{x+t}/2` : `1 − ${P}`;
    lines.push("납입자수 — 납입을 멈추게 하는 사유가 생긴 사람을 뺀다", `l′_{x+t+1} = l′_{x+t} × ( ${expr} )`);
    const note = `보험료 계산에는 납입자수를 ${units.length > 1 ? "계약 단위마다 " : ""}하나만 쓴다 — `
      + (common.length ? `계약을 끝내는 탈퇴 사유(${common.map(reasonOf).join("·")} — 모든 담보에 공통)` : "모든 담보에 공통인 탈퇴 사유는 없다")
      + (waivers.length ? `, 납입면제 사유(${waivers.map(reasonOf).join("·")})` : "")
      + "가 생긴 사람을 뺀다. 별도의 납입면제율을 곱하지 않는다."
      + (ills.length > 1 ? " 질병끼리는 곱으로, 사망과는 겹치는 부분을 절반으로 결합한다." : "");
    return { id: `p${ui + 1}`, unit, label: crowdLabel("납입자", causes), causes, syms, lapseRate, benefitIdx, legend, lines, note };
  });
}

/** 질병(사망 아닌 사유)끼리의 결합 — 따로 생긴다고 보고 곱으로: 1 − ( 1 − r⁽¹⁾ )·( 1 − r⁽²⁾ )… */
export function productText(syms: string[]): string {
  return `1 − ${syms.map((x) => `( 1 − ${at(x)} )`).join("·")}`;
}
/** 사망과 (질병을 묶은) 다른 사유의 결합 — 겹치는 부분을 절반으로: q + R − q·R/2 */
const withDeath = (q: string, d: string) => `${q} + ${d} − ${q}·${d}/2`;

/**
 * 탈퇴율 결합 규칙 (산출방법서와 자유설계보험 엔진이 같다)
 *  - 질병(사망 아닌 사유)끼리는 따로 생긴다고 보고 곱으로 결합한다 — R = 1 − Π(1 − rᵢ)
 *  - 사망과는 겹치는 부분을 절반으로 결합한다 — Q = q + R − q·R/2 (최종 연령에서 1 을 넘지 않게 min)
 *  - 사망이 탈퇴 사유가 아니면(사망 시 책임준비금 지급) 질병 발생자만 탈퇴한다 — Q = R
 */
function keepText(syms: { sym: string; rate: RateRef }[], lapseRate: number | undefined) {
  const lapse = lapseRate !== undefined;
  const deaths = syms.filter((x) => x.rate.role === "death").map((x) => x.sym), ills = syms.filter((x) => x.rate.role !== "death").map((x) => x.sym);
  const legend = syms.map((x) => `${x.sym}_x : ${x.rate.name}`);
  if (lapse) legend.push("w_x : 적용해지율 (납입기간 중)");
  const qd = !deaths.length ? "" : deaths.length === 1 ? at(deaths[0]) : `( ${productText(deaths)} )`;
  const keepLines: string[] = ["기준 인원", "l_x = 100,000"];
  // 질병 쪽 — 둘 이상이면 R 로 묶는다(진단형 담보의 급부 발생률도 이 R 이다)
  const R = ills.length > 1 ? "R_{x+t}" : ills.length ? at(ills[0]) : "";
  if (ills.length > 1) keepLines.push("질병 발생률 — 질병끼리는 따로 생긴다고 보고 곱으로 결합한다", `R_{x+t} = ${productText(ills)}`);
  let Q = "";
  if (qd && R) { Q = "Q_{x+t}"; keepLines.push("탈퇴율 — 사망과는 겹치는 부분을 절반으로 보고, 1 을 넘지 않는다", `Q_{x+t} = min( 1, ${withDeath(qd, R)} )`); }
  else if (deaths.length > 1) { Q = "Q_{x+t}"; keepLines.push("탈퇴율", `Q_{x+t} = min( 1, ${productText(deaths)} )`); }
  else Q = qd || R;
  const keepExpr = !Q ? "1" : lapse ? `1 − ${Q} − w_{x+t} + ${Q}·w_{x+t}/2` : `1 − ${Q}`;
  keepLines.push("유지자수 — 탈퇴 사유가 생긴 사람을 뺀다", `l_{x+t+1} = l_{x+t} × ( ${keepExpr} )`);
  const reasons = syms.map((x) => reasonOf(x.rate)).join("·");
  const keepNote = !syms.length ? "탈퇴 사유가 없어 기준 인원이 그대로 유지된다."
    : `${reasons} 이(가) 생기면 그 담보는 소멸(탈퇴)한다.${!deaths.length ? " 사망은 탈퇴 사유가 아니다 — 사망 시 책임준비금을 지급하므로 질병 발생자만 탈퇴한다." : ""}${ills.length > 1 ? " 질병끼리는 곱으로, 사망과는 겹치는 부분을 절반으로 결합한다." : ""}`;
  return { legend, lines: keepLines, note: `${keepNote} 보험금의 현가와 유지자수의 현가 D·N(납입 후 유지비 · 책임준비금)은 이 l 을 쓴다.` };
}

// ── 담보 ────────────────────────────────────────────────────────────────────
export interface BenefitModel {
  idx: number;
  b: BenefitSpec;
  group: GroupModel;
  /** 그 담보가 속한 계약 단위의 납입자 — 보험료(N*)는 이 l′ 로 낸다 */
  payer: PayerModel;
  /** 급부 발생률의 기호 — 탈퇴 사유이면 그 기호, 아니면 따로 준 g (일당형) */
  event?: { sym: string; rate: RateRef };
  legend: string[];
  lines: string[];
  note?: string;
  /**
   * 지급자수 d 의 식. 문서에는 싣지 않는다 — 급부 발생자의 현가 C 식에서 v^{t+½} 를 뺀 부분이다.
   * 계산 표(calc.ts `calcSheets`)가 유지자수·납입자수와 나란히 보여 주려고 쓴다.
   */
  payout: string;
}

/** 면책 개월 — 계산하는 앱(자유설계보험)과 같은 환산(30.4일 = 1개월) */
export const waitMonths = (days?: number) => (days ? Math.round(days / 30.4) : 0);

/** 급부 위험률 — 적힌 rateId, 없으면 그 담보의 탈퇴 사유(집단) 가운데 사망이 아닌 첫 것(진단형은 급부 = 탈퇴) */
export function eventRate(spec: MethodSpec, b: BenefitSpec): RateRef | undefined {
  if (b.role === "death") return undefined;
  const named = spec.rates.find((r) => r.id === b.rateId);
  if (named) return named;
  const causes = eventCauses(spec, b);
  return causes.length === 1 ? causes[0] : undefined;
}

/** 급부를 일으키는 탈퇴 사유 — 따로 적은 급부 위험률이 없으면 사망이 아닌 탈퇴 사유 전부(3대질병 진단처럼 여럿일 수 있다) */
export function eventCauses(spec: MethodSpec, b: BenefitSpec): RateRef[] {
  if (b.role === "death" || spec.rates.some((r) => r.id === b.rateId)) return [];
  return (b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r && r.role !== "death");
}

/** 연령 구간 배수 → if 식. 구간이 있으면 덮이지 않은 나이는 0 배다(자유설계보험 stepMultiple 과 같다) */
function stepsText(b: BenefitSpec): string | undefined {
  if (!b.steps?.length) return undefined;
  return b.steps.reduce((acc, s) => `if( ${s.fromAge} ≤ x+t ≤ ${s.toAge}, ${s.multiple}, ${acc} )`, "0");
}

/** 면책·삭감 → 보장금액 배수의 인자. 기간 mo 개월 동안 지급 비율 ratio (면책 0) — 첫해(12개월 안)면 if, 더 길면 해마다 겹치는 만큼 */
export function waitFactor(b: BenefitSpec): string | undefined {
  const mo = waitMonths(b.waitDays);
  if (!mo) return undefined;
  const ratio = b.waitPayRatio ?? 0;
  const cut = ratio ? `${1 - ratio}×` : "";
  return mo <= 12 ? `if( t = 0, 1 − ${cut}${mo}/12, 1 )` : `( 1 − ${cut}max( 0, min( 1, ${mo}/12 − t ) ) )`;
}
/** 면책·삭감 표기 — "90일 면책" · "2년 50% 삭감" */
export const waitLabel = (b: BenefitSpec) => {
  if (!b.waitDays) return "없음";
  const days = b.waitDays % 365 === 0 ? `${b.waitDays / 365}년` : `${b.waitDays}일`;
  const ratio = b.waitPayRatio ?? 0;
  return `${days} ${ratio ? `${Math.round(ratio * 100)}% 삭감` : "면책"}`;
};

export function benefitModels(spec: MethodSpec): BenefitModel[] {
  const groups = groupModels(spec), payers = payerModels(spec);
  return spec.benefits.map((b, idx) => {
    const group = groups.find((g) => g.benefitIdx.includes(idx))!;
    const payer = payers.find((p) => p.benefitIdx.includes(idx))!;
    const lapse = group.lapseRate !== undefined;
    const half = lapse ? "·( 1 − w_{x+t}/2 )" : "";
    const legend: string[] = [];
    let event: BenefitModel["event"];
    const rate = eventRate(spec, b);
    if (rate) {
      const inGroup = group.syms.find((s) => s.rate === rate);
      if (inGroup) event = inGroup;
      else { event = { sym: "g", rate }; legend.push(`g_x : ${rate.name}`); }
    }
    const lines: string[] = [];
    // 사망 아닌 탈퇴 사유가 여럿이면(3대질병) 그 가운데 하나라도 생긴 사람이 급부 대상 — 유지자수 식의 R(질병의 곱 결합)이다
    const causes = eventCauses(spec, b).map((r) => group.syms.find((s) => s.rate === r)!.sym);
    const multi = causes.length > 1;
    const ev = b.role === "death" ? (group.syms.length === 1 ? `${group.syms[0].sym}_{x+t}` : "Q_{x+t}") : multi ? "R_{x+t}" : `${event?.sym ?? "g"}_{x+t}`;
    const payout = `d_{x+t} = l_{x+t}·${ev}${half}`;
    // 보장금액 배수 S — 연령 구간 배수 × 면책·삭감
    const wf = waitFactor(b), steps = stepsText(b);
    const survival = b.role === "other" && !!b.points?.length;
    const parts = [survival ? "0" : steps ?? "1", ...(wf && !survival ? [wf] : [])];
    lines.push(wf ? `보장금액의 배수 — ${waitLabel(b)}이라 그 동안은 ${b.waitPayRatio ? `${Math.round(b.waitPayRatio * 100)}% 만` : "지급하지 않는다"}` : "보장금액의 배수", `S_t = ${parts.join(" × ")}`);
    // 급부 발생자
    lines.push(b.role === "death" ? "급부 발생자 — 탈퇴자 전부가 급부 대상이다" : "급부 발생자", `C_{x+t} = l_{x+t}·${ev}${half}·v^{t+½}`);
    lines.push("보험금 현가의 누계", "M_{x+t} = Σ_{u=t}^{n−1} S_u·C_{x+u}");
    if (survival) {
      lines.push("생존 지급 시점의 배수", `E_t = ${b.points!.map((p) => `if( t = ${p.age} − x, ${p.multiple}, 0 )`).join(" + ")}`,
        "보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x + Σ_{u=0}^{n} E_u·D_{x+u}");
    } else lines.push("보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x");
    const note = b.role === "death" && group.exits.length > 1
      ? `${group.exits.map(reasonOf).join("·")} 모두 같은 보험금을 지급하므로 탈퇴자 전부가 급부 대상이다.`
      : b.role === "incidence" ? "진단 확정 시 지급하고 그 담보는 소멸한다." : undefined;
    return { idx, b, group, payer, event, legend, lines, payout, ...(note ? { note } : {}) };
  });
}

/** 보장금액 표기 — "가입금액의 0.5배" · "50,000,000원" */
export const amountLabel = (b: BenefitSpec) =>
  b.multiple !== undefined ? `가입금액의 ${b.multiple}배` : b.amount !== undefined ? `${Math.round(b.amount).toLocaleString("ko-KR")}원${b.role === "recurring" ? "/일" : ""}` : "—";

// ── 공통 — 현가와 보험료 ─────────────────────────────────────────────────────
/** 담보마다 똑같은 식: 현가(D′ · N′ · N* — 보험료 쪽 / D · N — 보험금 쪽)와 보험료(P · G · 반올림) */
export function commonModels(spec: MethodSpec): { key: string; section: string; label: string; path: string; lines: string[]; note?: string }[] {
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const meth = isMethodExpenses(spec);
  const I = "basis.interest";
  const PAY = "계산기수 — 보험료", BEN = "계산기수 — 보험금", PREM = "순보험료 및 영업보험료";
  return [
    { key: "pv:D′", section: PAY, label: "납입자수의 현가와 누계 (D′ · N′)", path: I, lines: ["D′_{x+t} = l′_{x+t}·v^t", "N′_{x+t} = Σ_{u≥t} D′_{x+u}"] },
    { key: "pv:NStar", section: PAY, label: "연납 환산 납입기수 (N*)", path: `${I}|expenses`,
      lines: ["N* = k · [ ( N′_x − N′_{x+m} ) − ( k−1 )/( 2·k )·( D′_x − D′_{x+m} ) ]"],
      note: "k 는 납입주기별 계수(연납 1, 6개월납 2, 3개월납 4, 월납 12)이다. 납입방법에 따라 N* 만 달라지고 보험금의 현가는 같다." },
    { key: "pv:D", section: BEN, label: "유지자수의 현가와 누계 (D · N)", path: I, lines: ["D_{x+t} = l_{x+t}·v^t", "N_{x+t} = Σ_{u≥t} D_{x+u}"],
      note: "담보마다 그 담보의 유지자수 l 로 낸다. 납입 후 유지비와 책임준비금(2.)이 N 을 쓴다." },
    ...(lapse ? [{ key: "pv:H", section: BEN, label: "해지자의 현가 (H)", path: `${I}|basis.lapse`, lines: ["H_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}"] }] : []),
    { key: "premium:P", section: PREM, label: "순보험료 (P)", path: "benefits", lines: ["P = PVB / N*"],
      note: "담보마다 그 담보의 보험금 현가 PVB 를 그 계약 단위의 N*(납입자수는 하나)로 나눈다. 보장금액 1원당이다." },
    { key: "premium:base", section: PREM, label: "기준연납순보험료", path: "benefits|expenses", lines: ["P_base = PVB / ( N′_x − N′_{x+min(n,20)} )"] },
    { key: "premium:G", section: PREM, label: "영업보험료", path: "expenses", lines: [meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/k + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )"],
      note: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다." },
    { key: "premium:round", section: PREM, label: "1원당 보험료의 반올림과 10만원당 보험료", path: "benefits", lines: [
      "1원당 영업보험료 — 소수 여섯째 자리까지", "G₁ = round₆( G )",
      "10만원당 보험료 — 원 단위로 반올림", "G_{10만} = round( G₁ × 100,000 )"],
      note: "담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000), 보장금액 = 보험가입금액 × 배수. 여러 담보는 담보 보험료를 더한다." },
  ];
}

// ── 산출방법서에 실을 식 ─────────────────────────────────────────────────────
export function generateFormulas(spec: MethodSpec): FormulaSpec[] {
  const out: FormulaSpec[] = [];
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const low = lapse && spec.basis.lowRatio !== undefined;
  const idx = (r: RateRef) => `rates[${spec.rates.indexOf(r)}]`;
  const groups = groupModels(spec);
  const multi = spec.benefits.length > 1;
  const benefits = benefitModels(spec);

  // 라. 유지자수·납입자수 — 유지자 집단마다 l(보장 카드), 납입자는 계약 단위마다 하나 l′(보험료 카드)
  for (const g of groups) {
    const bens = g.benefitIdx.map((i) => `benefits[${i}]`), exits = g.exits.map(idx);
    out.push({
      section: "유지자수·납입자수", key: `group:${g.id}`,
      path: [...bens, ...exits, ...(lapse ? ["basis.lapse"] : [])].join("|"),
      label: `유지자수 — ${g.label}`,
      text: [...g.keep.legend, "", ...g.keep.lines].join("\n"),
      note: `${g.benefitIdx.map((i) => spec.benefits[i].name).join(" · ")} 담보가 이 유지자수를 쓴다. ${g.keep.note}`,
    });
  }
  const payers = payerModels(spec);
  for (const p of payers) {
    out.push({
      section: "유지자수·납입자수", key: `pay:${p.id}`,
      // 이 단위의 담보 + 줄이는 사유 + (있으면) 납입면제·해지율 — 어느 조건을 골라도 이 식이 표시되게
      path: [...p.benefitIdx.map((i) => `benefits[${i}]`), ...p.causes.map(idx),
        ...(spec.basis.waiver ? ["basis.waiver", ...(spec.basis.waiverRateIds?.length ? ["basis.waiverRateIds"] : [])] : []), ...(lapse ? ["basis.lapse"] : [])].join("|"),
      label: `납입자수 — ${payers.length > 1 ? `${p.unit} ` : ""}${p.label}`,
      text: [...p.legend, ...(p.legend.length ? [""] : []), ...p.lines].join("\n"),
      note: p.note,
    });
  }

  // 마·바·사 — 담보마다 같은 식
  const common = commonModels(spec);
  const put = (c: (typeof common)[number]) => out.push({ section: c.section, key: c.key, label: c.label, path: c.path, text: c.lines.join("\n"), ...(c.note ? { note: c.note } : {}) });
  common.filter((c) => c.key.startsWith("pv:") && c.section === "계산기수 — 보험료").forEach(put);
  common.filter((c) => c.key.startsWith("pv:") && c.section === "계산기수 — 보험금").forEach(put);

  // 바. 보험금의 현가 — 담보마다
  for (const m of benefits) {
    out.push({
      section: "계산기수 — 보험금", key: `benefit:${m.b.id}`,
      path: [`benefits[${m.idx}]`, ...(m.event && !m.group.syms.includes(m.event) ? [idx(m.event.rate)] : [])].join("|"),
      label: `보험금의 현가 — ${multi ? `${m.b.unit ? `${m.b.unit} ` : ""}${m.b.name}` : m.b.name}`,
      text: [...m.legend, ...(m.legend.length ? [""] : []), ...m.lines].join("\n"),
      note: [`보장금액 ${amountLabel(m.b)}${m.b.endAge ? ` · ${endAgeLabel(m.b.endAge)}` : ""} · 면책·삭감 ${waitLabel(m.b)} · ${m.group.label}.`, m.note].filter(Boolean).join(" "),
    });
  }
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
      text: ["납입 후 유지비를 포함한 순보험료 — 납입기간의 납입자수 현가로 나눈다",
        `P_β = ( PVB${low ? " + CSV_0" : ""} + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )`].join("\n") },
    { section: R, key: "reserve:V", label: "연말 책임준비금", path: "basis.standardInterest", text: [
      "t 년도 말 책임준비금 (보장금액 1원당) — 장래 보험금의 현가와 장래 유지비의 현가에서 장래 순보험료의 현가를 뺀 것을 t 시점 유지자수의 현가로 나눈다",
      `V_t = [ M_{x+t}${survival ? " + Σ_{u>t} E_u·D_{x+u}" : ""}${low ? " + CSV_t" : ""} + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}`,
      "10만원당 책임준비금 — 원 단위로 반올림",
      "V^{10만}_t = round( V_t × 100,000 )",
      ...(spec.basis.standardInterest !== undefined ? ["회계연도말 보험료적립금 — 적용기초율과 표준기초율(V^{표준}) 책임준비금 중 큰 금액", "V^{결산}_t = max( V_t, V^{표준}_t )"] : [])].join("\n"),
      note: "순보식에 납입 후 유지비 β′를 더한 형태. [t≤m] 은 납입기간 중이면 1, 아니면 0 이다. 표준준비금은 표준이율로 같은 식을 계산한다." },
    { section: S, key: "surrender:alpha", label: "해약공제 기준 신계약비", path: "surrender",
      text: (meth ? ["적용기초율의 신계약비와 표준기초율의 신계약비 중 작은 쪽", "α^{공제} = min( α_S + α_P·round₅( P_base ), α^{표준} )"] : ["α^{공제} = α"]).join("\n"),
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
