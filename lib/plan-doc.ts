import { pct, wonExact } from "./format";
import type { RateKind } from "./plan-rates";
import { isFormula } from "./sheet-formula";
import { BENEFIT_KINDS } from "./engine/plan";
import { FREQS, tabConditions, waitFactorOf, type PlanState, type ProductResult } from "./plan-state";
import { emptySpec, type BenefitSpec, type ExpenseItem, type MethodSpec, type RateRef, type RateRole } from "./methoddoc/spec";
import { renderMethodDoc, type DocSection } from "./methoddoc/render";
import { withFormulas } from "./methoddoc/formulas";

export { docToHtml, docToMarkdown, isNumericCell, type DocBlock, type DocSection } from "./methoddoc/render";

/**
 * 이 앱의 조건·산출 결과 → 중립 모델(MethodSpec) → 산출방법서.
 * 여기가 앱과 methoddoc 모듈을 잇는 유일한 지점이다 — 다른 앱에 옮길 때 이 파일만 새로 쓴다.
 */

const ROLE: Record<RateKind, RateRole> = { death: "death", incidence: "incidence", recurring: "recurring", other: "other" };
const BENEFIT_ROLE = { death: "death", incidence: "incidence", daily: "recurring", survival: "other" } as const;
const won = (x: number) => wonExact(Math.round(x));
/** 열 이름을 지급 사유 낱말로 — "제7회 경험생명표 사망률 q" → "사망", "80% 이상 장해율" → "80% 이상 장해" */
const shortName = (c: { kind: RateKind; name: string }) => (c.kind === "death" ? "사망" : c.name.replace(/\s*(발생)?[율률]\s*[a-zA-Z]?$/, ""));

/** 급부 유형별 지급 사유 문구 */
const TRIGGER = Object.fromEntries(BENEFIT_KINDS.map((k) => [k.kind, k.kind === "incidence" ? "진단 확정 시" : k.unit])) as Record<(typeof BENEFIT_KINDS)[number]["kind"], string>;

/** PlanState + 산출 결과 → MethodSpec */
export function planToSpec(s: PlanState, p: ProductResult): MethodSpec {
  const spec = emptySpec(s.productName || "상품");
  const base = s.base;
  spec.meta.note = s.memo || undefined;
  spec.meta.kind = base.low.on ? (base.low.ratio === 0 ? "무해지환급형" : `저해지환급형 ${Math.round(base.low.ratio * 100)}%`) : "표준형(완전 환급)";
  spec.contract = { age: s.age, sex: s.sex, termYears: p.n, payYears: base.payYears, freq: base.freq, sumAssured: s.tabs[0].coverages[0]?.amount };
  spec.basis = {
    interest: base.interest, standardInterest: base.standardInterest, waiver: base.waiver,
    lapse: base.low.on ? [{ label: spec.meta.kind, rate: base.low.lapseRate, duringPayOnly: true }] : undefined,
    lowRatio: base.low.on ? base.low.ratio : undefined,
  };
  spec.expenses = expenseItems(base.expenses);

  // 위험률 — 탭마다 이름이 같아도 값이 다를 수 있으므로 탭 이름을 붙여 구분한다
  for (const tab of s.tabs) {
    const tr = p.tabs.find((t) => t.tab.id === tab.id);
    for (const c of tab.sheet.columns) {
      const formulas = c.cells.filter(isFormula);
      const ref: RateRef = {
        id: `${tab.id}:${c.id}`,
        name: s.tabs.length > 1 ? `${tab.name} · ${c.name}` : c.name,
        role: c.waiver ? "waiver" : ROLE[c.kind],
        source: [c.source, formulas.length ? `시트 수식 ${formulas.length}칸 (예: ${formulas[0]})` : ""].filter(Boolean).join(" · ") || "시트 직접 입력·표",
        table: { ages: [...tab.sheet.ages], values: [...(tr?.sheet.byId[c.id] ?? [])], sex: s.sex },
      };
      spec.rates.push(ref);
    }
  }

  // 담보·계약 단위
  for (const tab of s.tabs) {
    const benefitIds: string[] = [];
    for (const c of tab.coverages) {
      const id = `${tab.id}:${c.id}`;
      benefitIds.push(id);
      const exitCols = c.exitColIds.map((x) => tab.sheet.columns.find((y) => y.id === x)).filter((y) => !!y);
      const b: BenefitSpec = {
        id, name: c.label, unit: tab.name, role: BENEFIT_ROLE[c.kind],
        trigger: c.kind === "death" && exitCols.length > 1 ? `${exitCols.map(shortName).join(" 또는 ")} 시` : TRIGGER[c.kind],
        amount: c.amount, endAge: c.endAge,
        waitDays: c.waitMonths ? Math.round(c.waitMonths * 30.4) : undefined,
        rateId: c.kind === "survival" || c.kind === "death" ? undefined : `${tab.id}:${c.eventColId}`,   // 사망형은 급부 = 탈퇴
        exitRateIds: c.exitColIds.map((x) => `${tab.id}:${x}`),
        steps: c.steps.length ? c.steps : undefined,
        points: c.points.length ? c.points : undefined,
      };
      spec.benefits.push(b);
    }
    const cond = tabConditions(s, tab);
    const overrides: NonNullable<MethodSpec["units"][number]["overrides"]> = {};
    for (const k of Object.keys(tab.overrides)) {
      if (k === "termYears") overrides.termYears = cond.termYears;
      else if (k === "payYears") overrides.payYears = cond.payYears;
      else if (k === "freq") overrides.freq = cond.freq;
      else if (k === "interest") overrides.interest = cond.interest;
      else if (k === "standardInterest") overrides.standardInterest = cond.standardInterest;
      else if (k === "waiver") overrides.waiver = cond.waiver;
      else if (k === "low") {
        overrides.lowRatio = cond.low.on ? cond.low.ratio : undefined;
        overrides.lapse = cond.low.on ? [{ rate: cond.low.lapseRate, duringPayOnly: true }] : [];
      }
    }
    spec.units.push({
      id: tab.id, name: tab.name, main: tab.id === s.tabs[0].id,
      overrides: Object.keys(overrides).length ? overrides : undefined,
      benefitIds, rateIds: tab.sheet.columns.map((c) => `${tab.id}:${c.id}`),
    });
  }

  // 산출식은 넣지 않는다 — 문서는 공용 생성기(withFormulas)가 조건에서 만들고, JSON 을 받는 앱도 제 식을 다시 만든다
  spec.surrender.deductionYears = 7;
  spec.surrender.notes = [
    "해약공제 기준 신계약비는 적용기초율과 표준기초율로 구한 신계약비 중 작은 쪽으로 한다.",
    ...(base.low.on ? ["납입기간 완료 후에는 적용해지율이 0이므로 책임준비금이 표준형과 같아지고, 해지환급금도 같다."] : []),
  ];
  spec.reserve.notes = [
    "회계연도말 보험료적립금은 적용기초율 적립금과 표준기초율 적립금 중 큰 금액으로 한다.",
    "연중 보간은 하지 않고 연말 기준으로 산출한다.",
  ];
  return spec;
}

function expenseItems(e: PlanState["base"]["expenses"]): ExpenseItem[] {
  if (e.model === "method") return [
    { group: "계약체결비용", symbol: "α_S", basis: "보험가입금액", rate: e.alphaS, phase: "초년도" },
    { group: "계약체결비용", symbol: "α_P", basis: "기준연납순보험료", times: e.alphaP, phase: "초년도" },
    { group: "계약관리비용", symbol: "β_S", basis: "매년 보험가입금액", rate: e.betaS, phase: "납입중" },
    { group: "계약관리비용", symbol: "β_G", basis: "영업보험료", rate: e.betaG, phase: "납입중" },
    { group: "계약관리비용", symbol: "β′", basis: "매년 보험가입금액", rate: e.betaPrime, phase: "납입후" },
    { group: "수금비용", symbol: "γ", basis: "영업보험료", rate: e.gamma },
  ];
  return [
    { group: "계약체결비용", symbol: "α", basis: "보험가입금액", rate: e.alpha },
    { group: "계약관리비용", symbol: "β", basis: "매년 보험가입금액", rate: e.beta },
    { group: "수금비용", symbol: "γ", basis: "영업보험료", rate: e.gamma },
  ];
}

/** 산출 결과(담보별 보험료·연도별 표·검증) — 산출방법서 뒤에 붙인다 */
export function resultSections(s: PlanState, p: ProductResult): DocSection[] {
  const freqLabel = FREQS.find((x) => x.v === s.base.freq)?.label ?? `연 ${s.base.freq}회`;
  const sum = p.coverages.reduce((a, c) => a + (p.low ? c.low!.monthlyGross : c.monthlyGross), 0);
  const allCov = s.tabs.flatMap((t) => t.coverages);
  return [
    { id: "premium-result", title: "산출 결과 — 보험료", blocks: [
      { t: "table",
        head: ["단위", "담보", "n / m", "PVB", "N*", "P = PVB/N*", "G", "10만원당 G", "보장금액", `${freqLabel} 보험료`],
        rows: p.coverages.map((c) => {
          const st = allCov.find((x) => x.id === c.id)!;
          const u = p.low ? c.low!.perUnit : c.perUnit;       // 저해지는 PVB 에 CSV₀ 가, N* 에 해지 탈퇴가 들어간다
          return [c.tabName, c.label, `${c.n} / ${c.payYears}`, u.pvb.toFixed(4), u.nStar.toFixed(2),
            u.net.toFixed(10), u.gross.toFixed(10),
            `${(p.low ? c.low!.gross100k : c.per100k.gross).toLocaleString()}원`,
            `${won(st.amount)}${st.kind === "daily" ? "/일" : ""}`,
            won(p.low ? c.low!.monthlyGross : c.monthlyGross)];
        }).concat([["합계", "", "", "", "", "", "", "", "", won(p.effective.monthlyGross)]]) },
      { t: "note", text: "PVB·N*·P·G 는 가입금액 1원, 기수 l_x = 100,000 기준의 반올림 전 값이다. 10만원당 G 는 G × 100,000 을 원 단위로 반올림한 값이며, 담보 보험료 = 10만원당 G × (보장금액 ÷ 100,000) 이다." },
      { t: "table", head: ["담보", "기준연납순보험료 P_base", "신계약비 α (적용)", "α^std (표준)", "해약공제 기준 α^공제 = min"],
        rows: p.coverages.map((c) => {
          const st = allCov.find((x) => x.id === c.id)!, k = st.amount / 1e5;
          return [c.label, c.perUnit.base.toFixed(10), won(c.per100k.alpha * k), won(c.per100k.alphaStd * k), won(c.per100k.newBiz * k)];
        }) },
    ] },
    { id: "reserve-result", title: "산출 결과 — 책임준비금·해지환급금", blocks: [
      { t: "table", head: ["경과", "연령", "보장금액", "납입누계", "책임준비금(적용)", "표준준비금", "해약공제", "해지환급금", "환급률"],
        rows: [0, 1, 3, 5, Math.min(7, p.payYears), 10, Math.min(p.payYears, p.n), Math.min(p.payYears + 5, p.n), p.n]
          .filter((t, i, a) => a.indexOf(t) === i && t <= p.n).sort((a, b) => a - b)
          .map((t) => [`${t}년`, `${s.age + t}세`, won(p.benefit[t] ?? 0), won(p.effective.paid[t]), won(p.effective.reserve[t]),
            won(p.effective.reserveStd[t]), won(p.effective.deduction[t]), won(p.effective.cash[t]), pct(p.effective.rate[t] ?? 0)]) },
      { t: "note", text: `해지환급금 = max(책임준비금(적용) − 해약공제, 0). 해약공제는 α^공제 를 min(m,7) = ${Math.min(7, p.payYears)}년에 걸쳐 균등하게 줄인다. 표준준비금은 표준이율로 같은 식을 계산한 값으로, 회계연도말 적립금은 두 값 중 큰 금액으로 한다.` },
    ] },
    { id: "check", title: "검증", blocks: [
      { t: "table", head: ["항목", "값"], rows: [
        ["담보별 보험료 합계", won(sum)],
        ["표시 합계", won(p.effective.monthlyGross)],
        ["차이", won(sum - p.effective.monthlyGross)],
        ["시트 수식 오류 칸", `${p.tabs.reduce((a, t) => a + t.sheet.errorCount, 0)}개`],
        ...(p.low ? [["표준형 대비 인하율", pct(p.low.premiumDiscount)], ["해지급부 현가 CSV₀ 합", p.low.pvCsv.toFixed(4)]] : []),
        ...s.tabs.map((t) => [`${t.name} 면책·증액`, t.coverages.map((c) =>
          `${c.label}${c.waitMonths ? ` 면책 ${c.waitMonths}개월(첫해 ${waitFactorOf(c.waitMonths)})` : ""}${c.steps.length ? ` 구간 ${c.steps.length}개` : ""}`).join(" / ")]),
      ] },
      { t: "note", text: "이 산출은 설계형 상품(종신·암)과 같은 엔진을 쓴다. 사망률 하나만 탈퇴 사유로 둔 사망형 담보는 설계형 산출과 10만원당 보험료·준비금·환급금·환급률이 완전히 일치한다(회귀 테스트로 고정)." },
    ] },
  ];
}

/** 화면·내려받기가 쓰는 한 줄 진입점 */
export const buildPlanDoc = (s: PlanState, p: ProductResult, today?: Date): DocSection[] =>
  renderMethodDoc(withFormulas(planToSpec(s, p)), { extra: resultSections(s, p), today });

export const planDocTitle = (s: PlanState) => `${s.productName || "상품"} 보험료 및 책임준비금 산출방법서`;
