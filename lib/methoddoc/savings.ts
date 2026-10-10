import type { BenefitSpec, FormulaSpec, MethodSpec, SavingsSpec } from "./spec";

/**
 * 공시이율형 적립 저축보험(적립형)의 식 — 조건(spec.savings)에서 만든다. 앱에 딸리지 않는다(import 는 spec 뿐).
 *
 * **표준 산출방법서와 같은 모양이다**(사용자 요청 2026-10-10 — 기본 포맷을 지키고 적립형에만 필요한 것을 더한다):
 * 유지자 lx(k) · 보험금(C · M) · 보장(보장금액 기준 = 보험료의 배수) · 순보험료 P 는 보장성과 같은 식(formulas.ts)이고,
 * 여기서 더하는 것은 보험료가 정해진 적립형의 몫이다. 식과 값은 모두 **기본보험료 1원당**이다.
 *   1장 라. 보험금               사망보험금 = 보장금액 + 계약자적립액
 *   1장 바. 보험료의 구성        위험보험료 P^{위험}(= 보장금액 배수 × 순보험료 P) · 계약체결비용 E^{체결} · 적립보험료 P^{적립}
 *   2장 계약자적립액             적용이율 j · 월 적립 계수 s · 계약자적립액 AV
 *   3장 해약환급금 및 만기환급금 해약공제 · 납입누계 · W · 환급률
 * 이 표기도 calc.ts 가 그대로 읽어 계산한다 — 식을 고치면 적립액이 바뀐다.
 * 공시이율의 세 예시(공시이율 · 평균공시이율 · 최저보증이율)는 j^{공시} 값만 바꿔 같은 식으로 낸다(calc.ts SAVINGS_SCENARIOS).
 */
export const SAVE_PREMIUM = "보험료의 구성";
export const SAVE_BENEFIT = "보험금";
export const SAVE_AV = "계약자적립액의 계산에 관한 사항";
export const SAVE_PAYOUT = "해약환급금 및 만기환급금의 계산에 관한 사항";

const num = (x: number) => String(Math.round(x * 1e8) / 1e8);
const pct = (x: number) => `${Math.round(x * 1e6) / 1e4}%`;

/** 최저보증이율 — 경과기간 구간마다: if( t < 5, 0.0125, if( t < 10, 0.01, 0.005 ) ) */
export function guaranteeText(g: SavingsSpec["guarantee"]): string {
  const tiers = [...g].sort((a, b) => a.from - b.from);
  if (!tiers.length) return "0";
  let acc = num(tiers[tiers.length - 1].rate);
  for (let i = tiers.length - 2; i >= 0; i--) acc = `if( t < ${tiers[i + 1].from}, ${num(tiers[i].rate)}, ${acc} )`;
  return acc;
}
/** 최저보증 구간 이름 — "경과 5년 미만" · "경과 5년 이상 10년 미만" · "경과 10년 이상" */
export function guaranteeLabels(g: SavingsSpec["guarantee"]): string[] {
  const tiers = [...g].sort((a, b) => a.from - b.from);
  return tiers.map((x, i) => {
    const to = tiers[i + 1]?.from;
    return !x.from && to !== undefined ? `경과 ${to}년 미만` : to === undefined ? `경과 ${x.from}년 이상` : `경과 ${x.from}년 이상 ${to}년 미만`;
  });
}

/** 적립형 상품의 보험기간(년) 후보 — 가입 조건의 "5년만기 · 10년만기" 에서. 없으면 10년 */
export function savingsTerms(spec: MethodSpec): number[] {
  const ys = (spec.product?.terms ?? []).flatMap((r) => [...(r.term ?? "").matchAll(/(\d+)\s*년/g)].map((m) => Number(m[1])));
  return ys.length ? [...new Set(ys)].sort((a, b) => a - b) : [10];
}
/** 계산할 보험기간 — 고른 납입기간이 후보에 있으면 그것(전기납), 아니면 가운데 후보 */
export const savingsTerm = (spec: MethodSpec, payYears: number) => {
  const ts = savingsTerms(spec);
  return ts.includes(payYears) ? payYears : ts[Math.floor((ts.length - 1) / 2)];
};

/** 위험보험료를 내는 보장 — 첫 보장. ponytail: 보장이 여럿이어도 첫 보장만 위험보험료에 든다(보장마다 P 를 따로 세워 더하려면 calc.ts savingsModel 을 보장마다 돌린다) */
export const savingsBenefit = (spec: MethodSpec): BenefitSpec | undefined => spec.benefits[0];
/** 기본보험료 1원당 보장금액 — 보험료의 배수면 그 배수, 정액이면 보장금액 ÷ 기본보험료(둘 다 원 — 산출 조건에서) */
export function perBase(b?: BenefitSpec): string {
  if (!b) return "0";
  return b.base === "premium" && b.multiple !== undefined ? num(b.multiple) : "보장금액 / 기본보험료";
}

/** 적립형이 표준 식에 더하는 식(열쇠 save:*) */
export function savingsFormulas(spec: MethodSpec): FormulaSpec[] {
  const s = spec.savings!;
  const b = savingsBenefit(spec), k = perBase(b);
  const ay = s.alphaYears, dr = num(s.deductRatio), dy = s.deductYears;
  const benPath = b ? `benefits[0].multiple|benefits[0].base|benefits[0].amount` : "benefits";
  return [
    { section: SAVE_BENEFIT, key: "save:death", label: "사망보험금 (계약자적립액 포함)", path: `${benPath}|savings`,
      text: [`t 년도 말 사망 시 — 보장금액(마. 보장)에 계약자적립액을 더한다 (기본보험료 1원당)`, `사망보험금_t = ${k} + AV_t`].join("\n") },
    { section: SAVE_PREMIUM, key: "save:risk", label: "위험보험료", path: `${benPath}|rates|basis.interest`,
      text: [b ? `보장(${b.name})의 순보험료 P 는 보장금액 1원당 매월 — 기본보험료 1원당으로 옮긴다` : "보장이 없어 위험보험료가 없다", `P^{위험} = ${b ? `${k} × P` : "0"}`].join("\n"),
      note: `계약자적립액 부분은 위험보험료가 없다(사망 시 그대로 지급한다).${spec.benefits.length > 1 ? " 보장이 여럿이면 첫 보장만 위험보험료에 넣는다." : ""}` },
    { section: SAVE_PREMIUM, key: "save:alpha", label: "계약체결비용", path: "expenses|savings.alphaYears",
      text: [`계약 후 ${ay}년 이내는 α, 그 뒤는 α′ (기본보험료 대비, 매월)`, `E^{체결}_t = if( t < ${ay}, α, α′ )`].join("\n") },
    { section: SAVE_PREMIUM, key: "save:accum", label: "적립보험료", path: "expenses",
      text: ["기본보험료에서 계약체결비용 · 계약관리비용 β · 위험보험료를 뺀 것 (매월)", "P^{적립}_t = 1 − E^{체결}_t − β − P^{위험}"].join("\n") },
    { section: SAVE_AV, key: "save:rate", label: "적용이율", path: "savings.credited|basis.averagePublished|savings.guarantee",
      text: ["최저보증이율 — 경과기간에 따라", `j^{보증}_t = ${guaranteeText(s.guarantee)}`,
        "적용이율 — 공시이율이 최저보증이율보다 낮으면 최저보증이율", "j_t = max( j^{공시}, j^{보증}_t )"].join("\n"),
      note: "j^{공시} : 매월 회사가 정하는 공시이율. 예시는 공시이율 · 평균공시이율을 계약기간 내내 그대로 쓴 것과, 최저보증이율만 쓴 것(j^{공시} = 0)의 세 가지다." },
    { section: SAVE_AV, key: "save:monthly", label: "월 적립 계수", path: "savings.credited",
      text: ["매월 초 적립보험료 1 을 그 해 말까지 월복리로 부리한 것의 합 (12번)", "s_t = ( ( 1 + j_t )^{13/12} − ( 1 + j_t )^{1/12} ) / ( ( 1 + j_t )^{1/12} − 1 )"].join("\n") },
    { section: SAVE_AV, key: "save:AV", label: "계약자적립액", path: "savings",
      text: ["t 년도 말 계약자적립액 (기본보험료 1원당)", "AV_0 = 0", "AV_{t+1} = AV_t × ( 1 + j_t ) + P^{적립}_t × s_t"].join("\n") },
    { section: SAVE_PAYOUT, key: "save:deduct", label: "해약공제", path: "savings.deductRatio|savings.deductYears",
      text: [`기본보험료의 ${pct(s.deductRatio)} 를 ${dy}년에 걸쳐 매년 균등하게 줄인다`, `해약공제_t = ${dr} × max( 0, ${dy} − t ) / ${dy}`].join("\n") },
    { section: SAVE_PAYOUT, key: "save:paid", label: "납입보험료 누계", path: "savings",
      text: ["t 년까지 낸 기본보험료 (월납 · 전기납)", "납입누계_t = 12 × min( t, n )"].join("\n") },
    { section: SAVE_PAYOUT, key: "save:W", label: "해약환급금 · 만기환급금", path: "savings.maturityFloor|savings.deductRatio",
      text: [`만기(t = n)에는 계약자적립액과 납입보험료의 ${pct(s.maturityFloor)} 중 큰 금액, 그 전에는 계약자적립액에서 해약공제를 뺀 것`,
        `W_t = if( t = n, max( AV_t, ${num(s.maturityFloor)} × 납입누계_t ), max( 0, AV_t − 해약공제_t ) )`].join("\n") },
    { section: SAVE_PAYOUT, key: "save:ratio", label: "환급률", path: "savings", text: "환급률_t = W_t / 납입누계_t" },
  ];
}
