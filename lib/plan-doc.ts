import type { PlanResult } from "@/lib/engine";
import { pct, wonExact } from "./format";
import { kindLabel, RATE_KINDS, type ResolvedSheet } from "./plan-rates";
import { colLetter, isFormula } from "./sheet-formula";
import { FREQS, waitFactorOf, type PlanState } from "./plan-state";

/**
 * 지금 산출한 상품의 산출식 문서. 보험수리 기호를 그대로 쓰고, 옆에 이 상품의 실제 숫자를 붙인다.
 * 구조화된 블록으로 만들어 화면(JSX)과 Markdown 두 곳에 같은 내용을 낸다 — 파서가 필요 없다.
 */
export type DocBlock =
  | { t: "p"; text: string }
  | { t: "formula"; text: string }
  | { t: "note"; text: string }
  | { t: "table"; head: string[]; rows: (string | number)[][] };
export interface DocSection { id: string; title: string; blocks: DocBlock[] }

const f6 = (x: number) => (Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(6));
const won = (x: number) => wonExact(Math.round(x));

/** 문서 전체. sheet는 시트 평가 결과(수식이 들어간 칸의 원본을 같이 싣는다) */
export function buildPlanDoc(s: PlanState, r: PlanResult, sheet: ResolvedSheet, today = new Date()): DocSection[] {
  const freqLabel = FREQS.find((x) => x.v === s.freq)?.label ?? `연 ${s.freq}회`;
  const letter = (id: string) => { const i = s.sheet.columns.findIndex((c) => c.id === id); return i < 0 ? "—" : colLetter(i + 1); };
  const colName = (id: string) => s.sheet.columns.find((c) => c.id === id)?.name ?? "—";
  const waiverColumns = s.sheet.columns.filter((c) => c.waiver);
  const e = s.expenses, meth = e.model === "method";
  const out: DocSection[] = [];

  out.push({ id: "overview", title: "1. 상품 개요", blocks: [
    { t: "table", head: ["항목", "내용"], rows: [
      ["상품명", s.productName || "(이름 없음)"],
      ["작성일", today.toLocaleDateString("ko-KR")],
      ["피보험자", `${s.age}세 ${s.sex === "M" ? "남" : "여"}`],
      ["보험기간", `${r.n}년 (${s.age}~${s.age + r.n - 1}세)`],
      ["납입기간", `${r.payYears}년 · ${freqLabel}`],
      ["담보 수", `${s.coverages.length}개`],
      ["종류", s.low.on ? (s.low.ratio === 0 ? "무해지환급형" : `저해지환급형 ${Math.round(s.low.ratio * 100)}%`) : "표준형(완전 환급)"],
      [`${freqLabel} 영업보험료`, won(r.effective.monthlyGross)],
    ] },
    ...(s.memo ? [{ t: "note" as const, text: s.memo }] : []),
    { t: "p", text: "이 문서는 지금 입력한 조건으로 앱이 실제 수행한 계산을 산출방법서 형식으로 옮긴 것이다. 담보 하나하나를 독립된 소형 상품으로 산출하고 마지막에 합친다." },
  ] });

  // 2. 기초율
  const rateRows = s.sheet.columns.map((c, i) => {
    const vals = sheet.byId[c.id] ?? [];
    const formulas = c.cells.filter(isFormula);
    return [
      colLetter(i + 1), c.name, kindLabel(c.kind), c.waiver ? "포함" : "—",
      `${f6(vals[0] ?? 0)} … ${f6(vals[vals.length - 1] ?? 0)}`,
      formulas.length ? `수식 ${formulas.length}칸 (예: ${formulas[0]})` : "직접 입력·표",
    ];
  });
  out.push({ id: "basis", title: "2. 기초율에 관한 사항", blocks: [
    { t: "p", text: "2.1. 이율" },
    { t: "table", head: ["구분", "값"], rows: [["적용이율 i", pct(s.interest, 3)], ["표준이율", pct(s.standardInterest, 3)], ["현가율 v = 1/(1+i)", f6(1 / (1 + s.interest))]] },
    { t: "p", text: `2.2. 위험률 — 연령 ${s.sheet.ages[0]}~${s.sheet.ages[s.sheet.ages.length - 1]}세, ${s.sheet.columns.length}개 열` },
    { t: "table", head: ["열", "이름", "유형", "납입면제", "값(처음 … 끝)", "입력"], rows: rateRows },
    { t: "note", text: RATE_KINDS.map((k) => `${k.label}: ${k.hint}`).join(" / ") },
    { t: "note", text: "표에 없는 나이는 바로 앞 나이 값을 이어 쓴다(첫 나이 앞은 첫 값, 마지막 뒤는 마지막 값)." },
    { t: "p", text: "2.3. 적용해지율" },
    ...(s.low.on
      ? [{ t: "table" as const, head: ["구분", "값"], rows: [["환급률 w^r", `${Math.round(s.low.ratio * 100)}%`], ["적용해지율 w (납입기간 중)", pct(s.low.lapseRate)], ["납입 완료 후", "0%"]] }]
      : [{ t: "p" as const, text: "표준형(완전 환급)이므로 적용해지율 w = 0." }]),
    { t: "p", text: "2.4. 납입면제" },
    ...(s.waiver && waiverColumns.length
      ? [{ t: "formula" as const, text: `f_x = ${waiverColumns.map((c) => `${letter(c.id)}_x`).join(" + ")}      (${waiverColumns.map((c) => c.name).join(" + ")})` }]
      : [{ t: "p" as const, text: "납입면제 미적용 — f_x = 0." }]),
    { t: "p", text: "2.5. 사업비" },
    { t: "table", head: ["구분", "기호", "값"], rows: e.model === "method"
      ? [["신계약비 정액", "α_S", pct(e.alphaS, 3)], ["신계약비율", "α_P", `${e.alphaP}배`],
         ["유지비 정액", "β_S", pct(e.betaS, 3)], ["유지비율", "β_G", pct(e.betaG, 2)],
         ["납입 후 유지비", "β′", pct(e.betaPrime, 3)], ["수금비", "γ", pct(e.gamma, 2)]]
      : [["신계약비", "α", pct(e.alpha, 3)], ["유지비", "β", pct(e.beta, 3)], ["수금비", "γ", pct(e.gamma, 2)]] },
    { t: "note", text: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다." },
  ] });

  // 3. 계산기수
  out.push({ id: "commutation", title: "3. 계산기수", blocks: [
    { t: "p", text: "담보마다 그 담보의 탈퇴율 q와 급부 발생률로 계산기수를 따로 만든다. l_x = l′_x = 100,000." },
    { t: "formula", text:
      "l_{x+t+1} = l_{x+t} · ( 1 − q_{x+t} − w_{x+t} + q_{x+t}·w_{x+t}/2 )\n" +
      "l′_{x+t+1} = l′_{x+t} · ( 1 − q_{x+t} − f_{x+t} − w_{x+t} + ( q·f + q·w + f·w )_{x+t}/2 )\n" +
      "D_{x+t} = l_{x+t}·v^t    D′_{x+t} = l′_{x+t}·v^t\n" +
      "C_{x+t} = l_{x+t}·g_{x+t}·( 1 − w_{x+t}/2 )·v^{t+½}    W_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}\n" +
      "N_{x+t} = Σ_{u≥t} D_{x+u}    N′_{x+t} = Σ_{u≥t} D′_{x+u}" },
    { t: "note", text: "q는 탈퇴율(그 담보가 소멸하는 사유 전부), g는 급부 발생률이다. 사망보장은 둘이 같고, 진단형은 q = 사망률 + 발생률, g = 발생률로 갈라진다. q·(1−w/2) + w = q + w − q·w/2 이므로 급부 탈퇴와 해지 탈퇴의 합이 l_{x+t} − l_{x+t+1}과 정확히 일치한다." },
    { t: "table", head: ["담보", "급부 발생률 g", "탈퇴율 q", "납입면제 f"],
      rows: s.coverages.map((c) => [
        c.label,
        c.kind === "survival" ? "— (생존급부)" : `${letter(c.eventColId)} (${colName(c.eventColId)})`,
        c.exitColIds.map((id) => letter(id)).join(" + ") || "—",
        s.waiver && waiverColumns.length ? waiverColumns.map((c2) => letter(c2.id)).join(" + ") : "0",
      ]) },
  ] });

  // 4. 담보별 보험료
  const premBlocks: DocBlock[] = [
    { t: "p", text: "보장 스케줄 S_t(연도별 보장금액 배수)와 생존급부 C_t를 급부 현가로 모으고, 월납 보정 납입기수로 나눈다." },
    { t: "formula", text:
      "PVB = Σ_{t=0}^{n−1} S_t·C_{x+t} + Σ_{t=0}^{n} C_t·D_{x+t}\n" +
      "N* = mm · [ ( N′_x − N′_{x+m} ) − ( mm−1 )/( 2·mm )·( D′_x − D′_{x+m} ) ]\n" +
      "P = PVB / N*        P_base = PVB / ( N′_x − N′_{x+min(n,20)} )" },
    { t: "formula", text: meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/mm + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )" },
  ];
  if (s.low.on) premBlocks.push(
    { t: "p", text: "저해지·무해지환급형은 해지급부 현가 CSV를 급부 현가에 더해 다시 산출한다." },
    { t: "formula", text:
      "CSV_t = Σ_{u≥t, u<m} W_{x+u} · w^r · ( W^표준_u + W^표준_{u+1} ) / 2\n" +
      "Ā_x = PVB + CSV_0        P = Ā_x / N*" },
    { t: "note", text: "W^표준은 같은 조건의 표준형(완전 환급) 해지환급금이다. w = 0으로 두면 CSV = 0이고 보험료가 표준형과 완전히 같아진다." },
  );
  premBlocks.push({ t: "table",
    head: ["담보", "n / m", "PVB", "N*", "P (1단위)", "G (1단위)", "10만원당 G", "보장금액", `${freqLabel} 보험료`],
    rows: r.coverages.map((c) => {
      const st = s.coverages.find((x) => x.id === c.id)!;
      return [c.label, `${c.n} / ${c.payYears}`, c.perUnit.pvb.toFixed(4), c.perUnit.nStar.toFixed(2),
        (r.low ? c.low!.net100k / 1e5 : c.per100k.net / 1e5).toPrecision(6),
        (r.low ? c.low!.gross100k / 1e5 : c.per100k.gross / 1e5).toPrecision(6),
        `${(r.low ? c.low!.gross100k : c.per100k.gross).toLocaleString()}원`,
        `${won(st.amount)}${st.kind === "daily" ? "/일" : ""}`,
        won(r.low ? c.low!.monthlyGross : c.monthlyGross)];
    }).concat([["합계", "", "", "", "", "", "", "", won(r.effective.monthlyGross)]]) });
  premBlocks.push({ t: "note", text: "10만원당 보험료에서 한 번만 반올림하고, 담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000)으로 한다." });
  s.coverages.forEach((c) => {
    if (c.waitMonths > 0) premBlocks.push({ t: "note", text: `${c.label}: 면책기간 ${c.waitMonths}개월 → 첫해 급부 배율 ${waitFactorOf(c.waitMonths)} (S_0 에만 곱한다).` });
    if (c.steps.length) premBlocks.push({ t: "note", text: `${c.label}: 연령 구간 배수 ${c.steps.map((x) => `${x.fromAge}~${x.toAge}세 ${x.multiple}배`).join(" · ")}` });
    if (c.kind === "survival" && c.points.length) premBlocks.push({ t: "note", text: `${c.label}: 생존급부 ${c.points.map((p) => `${p.age}세 ${won(p.multiple * c.amount)}`).join(" · ")}` });
  });
  out.push({ id: "premium", title: "4. 보험료의 계산", blocks: premBlocks });

  // 5. 책임준비금
  out.push({ id: "reserve", title: "5. 책임준비금의 계산", blocks: [
    { t: "formula", text:
      "P_β = ( PVB + CSV_0 + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )\n" +
      "V_t = [ Σ_{u≥t} S_u·C_{x+u} + Σ_{u>t} C_u·D_{x+u} + CSV_t + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}" },
    { t: "note", text: "순보식에 납입 후 유지비 β′를 더한 형태. 표준준비금은 표준이율로 같은 식을 계산하고, 표준위험률이 따로 없으면 적용위험률을 쓴다. 회계연도말 적립금은 둘 중 큰 금액으로 한다." },
    { t: "table", head: ["경과", "연령", "보장금액", "납입누계", "책임준비금", "해약공제", "해약환급금", "환급률"],
      rows: [0, 1, 3, 5, 10, Math.min(r.payYears, r.n), Math.min(r.payYears + 5, r.n), r.n].filter((t, i, a) => a.indexOf(t) === i && t <= r.n).map((t) => [
        `${t}년`, `${s.age + t}세`, won(r.benefit[t] ?? 0), won(r.effective.paid[t]), won(r.effective.reserve[t]),
        won(r.effective.deduction[t]), won(r.effective.cash[t]), pct(r.effective.rate[t] ?? 0)]) },
  ] });

  // 6. 해지환급금
  out.push({ id: "surrender", title: "6. 해지환급금의 계산", blocks: [
    { t: "formula", text:
      "해약공제_t = α^공제 · max( min(m,7) − t, 0 ) / min(m,7)        α^공제 = min( 적용 신계약비 α, 표준 신계약비 α^std )\n" +
      "W^표준_t = max( V_t − 해약공제_t, 0 )" },
    ...(s.low.on
      ? [{ t: "formula" as const, text: `납입기간 중: W_t = ${Math.round(s.low.ratio * 100)}% × W^표준_t        납입 완료 후: W_t = W^표준_t` },
         { t: "note" as const, text: "납입 완료 후에는 적용해지율이 0이라 저해지형 책임준비금이 표준형과 정확히 같아지고, 따라서 환급금도 같다. 낸 보험료는 적었으므로 환급률은 표준형보다 높다." }]
      : [{ t: "p" as const, text: "표준형이므로 W_t = W^표준_t." }]),
    { t: "formula", text: "환급률_t = W_t / 납입누계_t,   납입누계_t = min(t, m) × mm × G" },
  ] });

  // 7. 검증
  const sumCheck = r.coverages.reduce((a, c) => a + (r.low ? c.low!.monthlyGross : c.monthlyGross), 0);
  out.push({ id: "check", title: "7. 검증", blocks: [
    { t: "table", head: ["항목", "값"], rows: [
      ["담보별 보험료 합계", won(sumCheck)],
      ["표시 합계", won(r.effective.monthlyGross)],
      ["차이", won(sumCheck - r.effective.monthlyGross)],
      ["시트 수식 오류 칸", `${sheet.errorCount}개`],
      ...(s.low.on ? [["표준형 대비 인하율", pct(r.low!.premiumDiscount)], ["해지급부 현가 CSV₀ 합", r.low!.pvCsv.toFixed(4)]] : []),
      ["납입 완료 후 준비금(저해지 = 표준형)", s.low.on ? (r.low!.reserve[r.payYears] === r.standard.reserve[r.payYears] ? "일치" : "불일치") : "해당 없음"],
    ] },
    { t: "note", text: "이 산출은 설계형 상품(종신·암)과 같은 엔진을 쓴다. 사망형 담보 하나로 만든 계약은 설계형 산출과 10만원당 보험료·준비금·환급금·환급률이 완전히 일치한다(회귀 테스트로 고정)." },
  ] });

  return out;
}

/** 같은 내용을 Markdown으로 */
export function docToMarkdown(sections: DocSection[], title: string): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|");
  const lines: string[] = [`# ${title}`, ""];
  for (const sec of sections) {
    lines.push(`## ${sec.title}`, "");
    for (const b of sec.blocks) {
      if (b.t === "p") lines.push(b.text, "");
      else if (b.t === "note") lines.push(`> ${b.text}`, "");
      else if (b.t === "formula") lines.push("```", b.text, "```", "");
      else {
        lines.push(`| ${b.head.map(esc).join(" | ")} |`, `|${b.head.map(() => "---").join("|")}|`);
        for (const row of b.rows) lines.push(`| ${row.map(esc).join(" | ")} |`);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}
