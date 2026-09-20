import { pct, wonExact } from "./format";
import type { RateKind } from "./plan-rates";
import { isFormula } from "./sheet-formula";
import { FREQS, tabConditions, waitFactorOf, type PlanState, type ProductResult } from "./plan-state";
import { emptySpec, type BenefitSpec, type ExpenseItem, type MethodSpec, type RateRef, type RateRole } from "./methoddoc/spec";
import { renderMethodDoc, type DocSection } from "./methoddoc/render";

export { docToHtml, docToMarkdown, type DocBlock, type DocSection } from "./methoddoc/render";

/**
 * 이 앱의 조건·산출 결과 → 중립 모델(MethodSpec) → 산출방법서.
 * 여기가 앱과 methoddoc 모듈을 잇는 유일한 지점이다 — 다른 앱에 옮길 때 이 파일만 새로 쓴다.
 */

const ROLE: Record<RateKind, RateRole> = { death: "death", incidence: "incidence", recurring: "recurring", other: "other" };
const BENEFIT_ROLE = { death: "death", incidence: "incidence", daily: "recurring", survival: "other" } as const;
const won = (x: number) => wonExact(Math.round(x));

/** PlanState + 산출 결과 → MethodSpec */
export function planToSpec(s: PlanState, p: ProductResult): MethodSpec {
  const spec = emptySpec(s.productName || "상품");
  const base = s.base;
  spec.meta.note = s.memo || undefined;
  spec.meta.kind = base.low.on ? (base.low.ratio === 0 ? "무해지환급형" : `저해지환급형 ${Math.round(base.low.ratio * 100)}%`) : "표준형(완전 환급)";
  spec.contract = { age: s.age, sex: s.sex, termYears: p.n, payYears: base.payYears, freq: base.freq };
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
        source: formulas.length ? `시트 수식 ${formulas.length}칸 (예: ${formulas[0]})` : "시트 직접 입력·표",
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
      const b: BenefitSpec = {
        id, name: c.label, unit: tab.name, role: BENEFIT_ROLE[c.kind],
        amount: c.amount, endAge: c.endAge,
        waitDays: c.waitMonths ? Math.round(c.waitMonths * 30.4) : undefined,
        rateId: c.kind === "survival" ? undefined : `${tab.id}:${c.eventColId}`,
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

  spec.formulas = formulaSpecs(s);
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

function formulaSpecs(s: PlanState): MethodSpec["formulas"] {
  const meth = s.base.expenses.model === "method";
  const low = s.base.low.on;
  const out: MethodSpec["formulas"] = [
    { section: "계산기수", label: "생존자 수", text:
      "l_x = l′_x = 100,000\n" +
      "l_{x+t+1} = l_{x+t} · ( 1 − q_{x+t} − w_{x+t} + q_{x+t}·w_{x+t}/2 )\n" +
      "l′_{x+t+1} = l′_{x+t} · ( 1 − q_{x+t} − f_{x+t} − w_{x+t} + ( q·f + q·w + f·w )_{x+t}/2 )",
      note: "q는 탈퇴율(그 담보가 소멸하는 사유 전부), g는 급부 발생률이다. 사망보장은 둘이 같고, 진단형은 q = 사망률 + 발생률, g = 발생률로 갈라진다." },
    { section: "계산기수", label: "계산기수", text:
      "D_{x+t} = l_{x+t}·v^t    D′_{x+t} = l′_{x+t}·v^t\n" +
      "C_{x+t} = l_{x+t}·g_{x+t}·( 1 − w_{x+t}/2 )·v^{t+½}    W_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}\n" +
      "N_{x+t} = Σ_{u≥t} D_{x+u}    N′_{x+t} = Σ_{u≥t} D′_{x+u}",
      note: "q·(1−w/2) + w = q + w − q·w/2 이므로 급부 탈퇴와 해지 탈퇴의 합이 l_{x+t} − l_{x+t+1}과 정확히 일치한다." },
    { section: "보험료의 계산", label: "급부 현가와 납입기수", text:
      "PVB = Σ_{t=0}^{n−1} S_t·C_{x+t} + Σ_{t=0}^{n} C_t·D_{x+t}\n" +
      "N* = mm · [ ( N′_x − N′_{x+m} ) − ( mm−1 )/( 2·mm )·( D′_x − D′_{x+m} ) ]" },
    { section: "보험료의 계산", label: "순보험료·기준연납순보험료", text:
      "P = PVB / N*        P_base = PVB / ( N′_x − N′_{x+min(n,20)} )" },
    { section: "보험료의 계산", label: "영업보험료", text: meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/mm + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )",
      note: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다. 10만원당 보험료에서 한 번만 반올림하고, 담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000)으로 한다." },
  ];
  if (low) out.push({ section: "보험료의 계산", label: "저해지·무해지환급형", text:
    "CSV_t = Σ_{u≥t, u<m} W_{x+u} · w^r · ( W^표준_u + W^표준_{u+1} ) / 2\n" +
    "Ā_x = PVB + CSV_0        P = Ā_x / N*",
    note: "W^표준은 같은 조건의 표준형(완전 환급) 해지환급금이다. w = 0으로 두면 CSV = 0이고 보험료가 표준형과 완전히 같아진다." });
  out.push(
    { section: "책임준비금의 계산", label: "연말 책임준비금", text:
      "P_β = ( PVB + CSV_0 + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )\n" +
      "V_t = [ Σ_{u≥t} S_u·C_{x+u} + Σ_{u>t} C_u·D_{x+u} + CSV_t + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}",
      note: "순보식에 납입 후 유지비 β′를 더한 형태. 표준준비금은 표준이율로 같은 식을 계산한다." },
    { section: "해지환급금의 계산", label: "해약공제와 해지환급금", text:
      "해약공제_t = α^공제 · max( min(m,7) − t, 0 ) / min(m,7)        α^공제 = min( α, α^std )\n" +
      "W^표준_t = max( V_t − 해약공제_t, 0 )" + (low ? `\n납입기간 중: W_t = ${Math.round(s.base.low.ratio * 100)}% × W^표준_t        납입 완료 후: W_t = W^표준_t` : "") },
    { section: "해지환급금의 계산", label: "환급률", text: "환급률_t = W_t / 납입누계_t,   납입누계_t = min(t, m) × mm × G" },
  );
  return out;
}

/** 산출 결과(담보별 보험료·연도별 표·검증) — 산출방법서 뒤에 붙인다 */
export function resultSections(s: PlanState, p: ProductResult): DocSection[] {
  const freqLabel = FREQS.find((x) => x.v === s.base.freq)?.label ?? `연 ${s.base.freq}회`;
  const sum = p.coverages.reduce((a, c) => a + (p.low ? c.low!.monthlyGross : c.monthlyGross), 0);
  const allCov = s.tabs.flatMap((t) => t.coverages);
  return [
    { id: "premium-result", title: "산출 결과 — 보험료", blocks: [
      { t: "table",
        head: ["단위", "담보", "n / m", "PVB", "N*", "P(1단위)", "G(1단위)", "10만원당 G", "보장금액", `${freqLabel} 보험료`],
        rows: p.coverages.map((c) => {
          const st = allCov.find((x) => x.id === c.id)!;
          return [c.tabName, c.label, `${c.n} / ${c.payYears}`, c.perUnit.pvb.toFixed(4), c.perUnit.nStar.toFixed(2),
            (p.low ? c.low!.net100k / 1e5 : c.per100k.net / 1e5).toPrecision(6),
            (p.low ? c.low!.gross100k / 1e5 : c.per100k.gross / 1e5).toPrecision(6),
            `${(p.low ? c.low!.gross100k : c.per100k.gross).toLocaleString()}원`,
            `${won(st.amount)}${st.kind === "daily" ? "/일" : ""}`,
            won(p.low ? c.low!.monthlyGross : c.monthlyGross)];
        }).concat([["합계", "", "", "", "", "", "", "", "", won(p.effective.monthlyGross)]]) },
    ] },
    { id: "reserve-result", title: "산출 결과 — 책임준비금·해지환급금", blocks: [
      { t: "table", head: ["경과", "연령", "보장금액", "납입누계", "책임준비금", "해약공제", "해지환급금", "환급률"],
        rows: [0, 1, 3, 5, 10, Math.min(p.payYears, p.n), Math.min(p.payYears + 5, p.n), p.n]
          .filter((t, i, a) => a.indexOf(t) === i && t <= p.n)
          .map((t) => [`${t}년`, `${s.age + t}세`, won(p.benefit[t] ?? 0), won(p.effective.paid[t]), won(p.effective.reserve[t]),
            won(p.effective.deduction[t]), won(p.effective.cash[t]), pct(p.effective.rate[t] ?? 0)]) },
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
      { t: "note", text: "이 산출은 설계형 상품(종신·암)과 같은 엔진을 쓴다. 사망형 담보 하나로 만든 계약은 설계형 산출과 10만원당 보험료·준비금·환급금·환급률이 완전히 일치한다(회귀 테스트로 고정)." },
    ] },
  ];
}

/** 화면·내려받기가 쓰는 한 줄 진입점 */
export const buildPlanDoc = (s: PlanState, p: ProductResult, today?: Date): DocSection[] =>
  renderMethodDoc(planToSpec(s, p), { extra: resultSections(s, p), today });

export const planDocTitle = (s: PlanState) => `${s.productName || "상품"} 보험료 및 책임준비금 산출방법서`;
