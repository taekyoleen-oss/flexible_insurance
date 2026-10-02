import { amountLabel, eventCauses, eventRate, groupModels, payerModels, waitLabel } from "./formulas";
import { endAgeLabel, hasContract, hasProduct, RATE_ROLE_LABEL, waiverRates, type ExpenseItem, type MethodSpec, type ProductInfo, type RateRef, type Sex } from "./spec";

/**
 * MethodSpec → 산출방법서. 앱에 딸리지 않는다(import 는 spec 하나뿐).
 * 블록 구조 하나에서 화면(JSX)·Markdown·HTML·LaTeX 를 모두 만든다 — 마크다운 파서가 필요 없다.
 * 목차와 문구는 참조한 원본 산출방법서(1.기초율 2.보험료 3.책임준비금 4.해지환급금 5.가입금액 변경)를 따른다.
 *
 * 블록마다 조건 경로(path)를 단다 — "basis.interest", "expenses[2]", "benefits[0]".
 * 한 블록이 여러 조건에서 나오면 "|" 로 잇는다("basis.lapse|basis.lowRatio").
 * 편집기는 이 경로로 조건 줄 ↔ 산출방법서 블록을 서로 짝짓는다.
 */
export type DocBlock =
  /**
   * kind "label" = 수식 제목. 편집용 내보내기(Word·Markdown·LaTeX)는 앞에 "[식]" 을 붙여 되읽을 때 식의 시작을 안다.
   * kind "sub" = 절 안의 소제목("가. 예정기초율") — 실무 산출방법서의 가·나·다 항목이다.
   */
  | { t: "p"; text: string; path?: string; kind?: "label" | "sub" }
  | { t: "formula"; text: string; path?: string }
  | { t: "note"; text: string; path?: string }
  | { t: "table"; head: string[]; rows: (string | number)[][]; rowPaths?: (string | undefined)[] };
export interface DocSection { id: string; title: string; blocks: DocBlock[] }

const pctOf = (x?: number, d = 3) => (x === undefined ? "—" : `${(x * 100).toFixed(d)}%`);
const wonOf = (x?: number) => (x === undefined ? "—" : `${Math.round(x).toLocaleString("ko-KR")}원`);
const yearsOf = (y?: number, a?: number) => (y ? `${y}년` : a ? `${a}세 만기` : "—");

/**
 * 표준 산출방법서 — 이 모듈이 내는 산출방법서의 모양 자체다. 개요 표의 "양식" 행이 표시이고,
 * parse 는 이 표시를 보면 수식·주석·절까지 정해진 순서대로 되읽는다(parseStandard).
 * 모양을 바꾸면 판을 올리고 parse 가 옛 판도 읽게 둔다.
 *  v2 (2026-09-22): 기호의 정의 절 · 담보마다 세로 표 · 식은 한 줄에 하나(설명은 위) · 납입주기 k · 현가율 값 행 없음
 *     (2026-09-24) 값 표가 있는 위험률은 맨 뒤 "별첨 — 위험률 표"(연령 × 열) — 판은 그대로(없던 절이 늘었을 뿐, 옛 파서도 넘긴다)
 *  v3 (2026-09-27): 식을 산출 순서의 절로 나눈다 — 3. 탈퇴자·유지자·납입자(집단마다 l·l′) · 4. 보험료의 현가(D·N·N*) ·
 *     5. 보험금의 현가(담보마다 S·C·M·PVB) · 6. 보험료의 계산(P·G). 담보 표에 "집단" 행이 늘고, 탈퇴율 Q 를 따로 적는다.
 *     이 표기는 calc.ts 가 읽어 그대로 계산한다 — 문서의 식이 계산의 정의다. v1·v2 도 계속 읽는다(parse 의 옛 자동 식 걸러내기).
 *  v4 (2026-09-28): 실무 산출방법서의 장 구성을 따른다 — **1. 보험료의 계산에 관한 사항**(가. 예정기초율 · 나. 보장 내용 ·
 *     다. 기호의 정의 · 라. 유지자수·납입자수 · 마. 계산기수 — 보험료 · 바. 계산기수 — 보험금 · 사. 순보험료 및 영업보험료) →
 *     **2. 책임준비금의 계산에 관한 사항** → **3. 해지환급금의 계산에 관한 사항**. 소제목은 `kind: "sub"` 블록이다.
 *  v5 (2026-10-01): 담보 표가 실무 모양 — 보험기간(종료 나이) · 보장금액은 **가입금액의 배수**(1배 · 0.5배) · 면책·삭감(기간과 지급 비율).
 *     라. 는 집단마다 유지자수(l)와 납입자수(l′) 두 덩이, 마. 는 납입자수 쪽(D′ · N′ · N*), 바. 는 유지자수 쪽(D · N)과 담보의 S · C · M · PVB.
 *     사. 에 1원당 반올림(G₁ = round₆) → 10만원당(G_{10만}). 2·3 장의 준비금·환급금 식은 모두 계산할 수 있는 식이다(V · P_β · 해약공제 · W · 환급률).
 */
export const STANDARD_FORMAT = "표준 산출방법서 v5";

/** 1장 안의 소제목 차례 — 실무 산출방법서의 "가. 예정기초율 … 사. 순보험료 및 영업보험료" */
const PREMIUM_SUBS = ["유지자수·납입자수", "계산기수 — 보험료", "계산기수 — 보험금", "순보험료 및 영업보험료"];
const RESERVE = "책임준비금의 계산에 관한 사항";
const SURRENDER = "해지환급금의 계산에 관한 사항";

/** 사업비 한 줄의 비율 표기 — 원문이 있으면 원문을, 없으면 정규화 값을 쓴다 */
export function expenseRate(e: ExpenseItem): string {
  if (e.raw) return e.raw;
  if (e.times !== undefined) return `${e.times}배`;
  if (e.rate !== undefined) return e.rate >= 0.01 ? `${(e.rate * 100).toFixed(2)}%` : `${(e.rate * 1000).toFixed(2)}/1,000`;
  return "—";
}

/** 위험률 표 칸 — "40~110세 71행 · 남·여" (값 표가 없으면 별첨) */
function tableNote(r: RateRef): string {
  const sexes = (["M", "F"] as const).filter((x) => r.tables?.[x]);
  const t = r.tables?.M ?? r.tables?.F ?? r.table;
  if (!t?.ages.length) return "별첨";
  const who = sexes.length === 2 ? " · 남·여" : sexes.length === 1 ? ` · ${sexes[0] === "M" ? "남" : "여"}` : r.table?.sex ? ` · ${r.table.sex === "M" ? "남" : "여"}` : "";
  return `${t.ages[0]}~${t.ages[t.ages.length - 1]}세 ${t.ages.length}행${who}`;
}

/**
 * 값 표가 실린 위험률을 연령 × 열로 편 것 — 별첨 위험률 표(render)와 위험률 표 창(앱의 sheetFromSpec)이 같은 모양을 쓴다.
 * 남·여 두 벌(tables)이면 열 둘, 한 벌(table)이면 열 하나. 표가 하나도 없으면 null
 */
export function rateGrid(spec: MethodSpec): { ages: number[]; cols: { i: number; r: RateRef; sex?: Sex; head: string; t: { ages: number[]; values: number[] } }[] } | null {
  const sexName = (s?: Sex) => (s === "M" ? "(남)" : s === "F" ? "(여)" : "");
  const cols = spec.rates.flatMap((r, i) => {
    const both = (["M", "F"] as const).flatMap((x) => (r.tables?.[x]?.ages?.length ? [{ i, r, sex: x as Sex | undefined, head: r.name + sexName(x), t: r.tables[x]! }] : []));
    return both.length ? both : r.table?.ages?.length ? [{ i, r, sex: r.table.sex, head: r.name + sexName(r.table.sex), t: r.table }] : [];
  });
  if (!cols.length) return null;
  return { ages: [...new Set(cols.flatMap((c) => c.t.ages))].sort((a, b) => a - b), cols };
}

/** 별첨 — 위험률 표. 되읽으면(앱의 sheetFromDoc) 위험률 표 창으로 돌아가 값이 문서를 거쳐도 남는다 */
function rateTableBlocks(spec: MethodSpec): DocBlock[] {
  const g = rateGrid(spec);
  if (!g) return [];
  return [
    { t: "p", path: "rates", text: "가.(2) 예정위험률 가운데 값 표가 실린 것. 연령은 피보험자 나이(x+t), 값은 연 발생률이다." },
    table(["연령", ...g.cols.map((c) => c.head)], g.ages.map((a) => [[a, ...g.cols.map((c) => { const k = c.t.ages.indexOf(a); return k < 0 ? "—" : c.t.values[k]; })], "rates"])),
  ];
}

/** [행, 경로] 쌍으로 표를 만든다 — 행과 경로가 어긋나지 않게 */
function table(head: string[], pairs: [(string | number)[], string | undefined][]): DocBlock {
  return { t: "table", head, rows: pairs.map((p) => p[0]), rowPaths: pairs.map((p) => p[1]) };
}

export interface RenderOptions {
  /** 산출 결과(연도별 표·검증)를 같이 실을 때 */
  extra?: DocSection[];
  /** 작성일이 비어 있을 때 찍을 날짜(인쇄용). 넘기지 않으면 작성일 행을 싣지 않는다 */
  today?: Date;
}

/**
 * 가입 조건(정보) — 사업방법서의 "보험기간 | 보험료 납입기간 | 가입나이" 표와 종류·종목·납입주기·한도·갱신.
 * 머리글을 "가입 조건 | 내용" 과 "보험기간 | …" 으로 둔다 — parse 가 이 두 표를 먼저 떼어 내 계약(시산 기준)과 섞지 않는다.
 */
function productBlocks(p: ProductInfo, withContract: boolean): DocBlock[] {
  const out: DocBlock[] = [{ t: "p", text: "가입 조건", path: "product" }];
  const info = ([
    ["보험의 종류", p.category, "product.category"],
    ["보험종목", p.types?.join(" · "), "product.types"],
    ["보험료 납입주기", p.payFreqs?.join(" · "), "product.payFreqs"],
    ["보험가입금액 한도", p.sumLimit, "product.sumLimit"],
    ["갱신", p.renewal, "product.renewal"],
  ] as const).filter(([, v]) => v);
  if (info.length) out.push(table(["가입 조건", "내용"], info.map(([k, v, path]) => [[k, v!], path])));
  if (p.terms?.length) {
    const label = p.terms.some((r) => r.label), female = p.terms.some((r) => r.ageF);
    out.push(table([...(label ? ["구분"] : []), "보험기간", "보험료 납입기간", female ? "가입나이(남)" : "가입나이", ...(female ? ["가입나이(여)"] : [])],
      p.terms.map((r, i) => [[...(label ? [r.label ?? "—"] : []), r.term || "—", r.pay || "—", r.age || "—", ...(female ? [r.ageF || r.age || "—"] : [])], `product.terms[${i}]`])));
  }
  out.push({ t: "note", path: "product", text: withContract
    ? "가입 조건은 판매 범위를 적은 정보이며, 보험료·책임준비금 예시는 나. 의 시산 기준으로 계산한다."
    : "가입 조건은 판매 범위를 적은 정보이다. 보험료는 이 범위 안의 계약(피보험자·보험기간·납입기간)마다 계산한다." });
  return out;
}

/**
 * 기호의 정의 — 기간·주기·기초율 기호. 위험률 기호(q · r · f)는 담보별 식의 첫 줄들에서 정의한다.
 * 값은 싣지 않는다(1. 기초율 표가 값이다) — 되읽을 때 같은 값이 두 번 잡히지 않게.
 */
function symbolBlocks(spec: MethodSpec, groups: ReturnType<typeof groupModels>): DocBlock[] {
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const one = groups.length === 1 ? groups[0] : undefined;
  const reasons = (g: (typeof groups)[number]) => g.exits.map((r) => r.name.replace(/\s*(발생)?[율률]\s*$/, "")).join(" · ") || "탈퇴 사유";
  const payers = payerModels(spec);
  const names = (idx: number[]) => idx.map((k) => spec.benefits[k]?.name).filter(Boolean).join(" · ");
  const rows: [string, string][] = [
    ["x", "피보험자의 가입나이"],
    ["t", "경과기간(년), 0 ≤ t < n"],
    ["n", "보험기간(년)"],
    ["m", "보험료 납입기간(년)"],
    ["k", "납입주기별 계수 — 연 납입횟수 (연납 1, 6개월납 2, 3개월납 4, 월납 12)"],
    ["i", "적용이율 (가.(1))"],
    ["v", "현가율 = 1/(1+i)"],
    ["l_{x+t}", `t시점 생존자수 (기준 인원 l_x = 100,000) — ${one ? `${reasons(one)} 가 생기지 않은 사람 수` : "그 집단의 탈퇴 사유가 생기지 않은 사람 수"}`],
    ["l′_{x+t}", `t시점 납입자수 (기준 인원 l′_x = 100,000) — 보험료(N*)에 쓰고 ${payers.length > 1 ? "계약 단위마다" : "계약 전체에"} 하나다. 계약을 끝내는 탈퇴 사유와 납입면제 사유가 생기지 않은 사람 수`],
    ...(groups.length > 1 ? groups.map((g): [string, string] => [g.label, `l — ${names(g.benefitIdx)} 담보의 보험금 현가와 D·N 에 쓴다`]) : []),
    ...payers.map((p): [string, string] => [p.label, `l′ — ${payers.length > 1 ? `${p.unit} ` : ""}보험료(N*)에 쓴다 (${names(p.benefitIdx)})`]),
    ["d_{x+t}", "t시점 지급자수 — 그 담보의 급부가 생긴 사람 수 (바. 의 C 식에 들어간다)"],
    ["S_t", "t년도 보장금액의 배수 — 면책·삭감(기간과 지급 비율)을 반영한다(바.). 보장금액 = 보험가입금액 × 담보의 배수"],
    ["V_t", "t년도 말 책임준비금 (보장금액 1원당, 2.)"],
    ["W_t", "t년도 말 해지환급금 (보장금액 1원당, 3.)"],
    ...(spec.basis.waiver && waiverRates(spec).length ? [["f_{x+t}", "납입을 멈추게 하는 질병(납입면제 사유 등)의 발생률 — 납입자수 식 (라.)"] as [string, string]] : []),
    ...(lapse ? [["w_{x+t}", "적용해지율 (가.(3))"] as [string, string]] : []),
    ...(lapse && spec.basis.lowRatio !== undefined ? [["ρ", "납입기간 중 해지환급금 비율 (가.(3) — 무해지 0)"] as [string, string]] : []),
  ];
  return [table(["기호", "뜻"], rows.map((r) => [r, undefined]))];
}

/** 산출방법서 본문 */
export function renderMethodDoc(spec: MethodSpec, opt: RenderOptions = {}): DocSection[] {
  // 작성일은 조건에 적힌 것만 싣는다. today 를 넘기면(인쇄용) 비어 있을 때 그 날짜를 쓴다 — 되읽을 때 조건이 아닌 날짜가 섞이지 않게
  const date = spec.meta.date || opt.today?.toLocaleDateString("ko-KR");
  const out: DocSection[] = [];
  const rateName = (id?: string) => spec.rates.find((r) => r.id === id)?.name ?? "—";

  // 0. 표지
  out.push({ id: "cover", title: "개요", blocks: [
    table(["항목", "내용"], [
      [["양식", STANDARD_FORMAT], undefined],
      [["상품명", spec.meta.productName || "(이름 없음)"], "meta.productName"],
      ...(spec.meta.insurer ? [[["회사", spec.meta.insurer], "meta.insurer"] as [string[], string]] : []),
      ...(spec.meta.kind ? [[["종류", spec.meta.kind], "meta.kind"] as [string[], string]] : []),
      ...(date ? [[["작성일", date], "meta.date"] as [string[], string]] : []),
      ...(spec.meta.version ? [[["판", spec.meta.version], "meta.version"] as [string[], string]] : []),
      [["계약 단위", spec.units.length ? spec.units.map((u) => u.name).join(" · ") : "주계약"], "units"],
      ...(spec.meta.note ? [[["비고", spec.meta.note], "meta.note"] as [string[], string]] : []),
    ]),
    ...(hasProduct(spec.product) ? productBlocks(spec.product, hasContract(spec.contract)) : []),
  ] });

  // ── 1. 보험료의 계산에 관한 사항 — 실무 산출방법서의 1장. 기초율·보장·식이 모두 이 안에 가·나·다… 로 들어간다
  const SUBS = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타"];
  let si = 0;
  const sub = (text: string, path?: string): DocBlock => ({ t: "p", kind: "sub", text: `${SUBS[si++] ?? "기타"}. ${text}`, path });

  const basisBlocks: DocBlock[] = [
    sub("예정기초율", "basis"),
    { t: "p", text: "(1) 예정이율", path: "basis" },
    table(["구분", "값"], [
      [["적용이율 i", pctOf(spec.basis.interest)], "basis.interest"],
      [["표준이율", pctOf(spec.basis.standardInterest)], "basis.standardInterest"],
      ...(spec.basis.minGuaranteed !== undefined ? [[["최저보증이율", pctOf(spec.basis.minGuaranteed)], "basis.minGuaranteed"] as [string[], string]] : []),
      ...(spec.basis.averagePublished !== undefined ? [[["평균공시이율", pctOf(spec.basis.averagePublished)], "basis.averagePublished"] as [string[], string]] : []),
    ]),
    { t: "p", text: "(2) 예정위험률", path: "rates" },
  ];
  if (spec.rates.length) {
    basisBlocks.push(table(["위험률", "기호", "유형", "근거·출처", "표"], spec.rates.map((r, i) => [[
      r.name + (r.adjustment ? ` ${r.adjustment}` : ""),
      r.id,
      RATE_ROLE_LABEL[r.role],
      r.source ?? "—",
      tableNote(r),
    ], `rates[${i}]`])));
  } else {
    basisBlocks.push({ t: "p", text: "위험률이 지정되지 않았습니다.", path: "rates" });
  }
  basisBlocks.push({ t: "note", text: "표준위험률이 없는 경우에는 적용위험률을 사용한다." });
  basisBlocks.push({ t: "p", text: "(3) 적용해지율", path: "basis.lapse" });
  if (spec.basis.lapse?.length) {
    basisBlocks.push(table(["구분", "적용해지율", "적용 구간"], spec.basis.lapse.map((l, i) => [[
      l.label ?? "—", pctOf(l.rate, 1), l.duringPayOnly ? "보험료 납입기간 중 (납입 완료 후 0%)" : "전 기간",
    ], `basis.lapse[${i}]`])));
    if (spec.basis.lowRatio !== undefined) {
      basisBlocks.push({ t: "note", path: "basis.lowRatio", text: `납입기간 중 해지환급금 = 표준형(완전 환급) × ${Math.round(spec.basis.lowRatio * 100)}%${spec.basis.lowRatio === 0 ? " (무해지환급형)" : ""}.` });
    }
  } else basisBlocks.push({ t: "p", text: "적용하지 않음 (w = 0).", path: "basis.lapse" });
  basisBlocks.push({ t: "p", text: "(4) 납입면제 사유", path: "basis.waiver" });
  const wr = waiverRates(spec);
  if (spec.basis.waiver && wr.length) {
    basisBlocks.push({ t: "p", path: "basis.waiver|basis.waiverRateIds", text:
      `납입면제 사유는 ${wr.map((r) => r.name).join(" · ")} 이다. 이 사유가 생기면 보장은 그대로 두고 남은 보험료만 면제하므로, 납입자수 l′ 에서만 뺀다.` });
    basisBlocks.push({ t: "p", path: "basis.waiver|basis.waiverRateIds", text:
      "납입자수는 보험료 계산에 하나만 쓴다 — 계약을 끝내는 탈퇴 사유(모든 담보에 공통, 보통 사망)와 이 납입면제 사유로 준다(라. 유지자수·납입자수)." });
    // 첫 줄의 "f_x : A · B" 는 되읽을 때 납입면제 사유를 알아보는 표시다(담보별 식의 f 줄은 "—" 가 붙어 다르다)
    basisBlocks.push({ t: "formula", path: "basis.waiver|basis.waiverRateIds", text: [
      `f_x : ${wr.map((r) => r.name).join(" · ")}`,
      `f_{x+t} : 납입을 멈추게 하는 질병의 발생률 — 납입면제 사유(와 모든 담보에 공통인 질병 탈퇴 사유)`,
      // 결합 규칙 — 질병끼리는 곱, 사망과는 겹치는 부분을 절반(라. 의 납입자수 식)
      "F_{x+t} = 1 − ( 1 − f^{(1)}_{x+t} )·( 1 − f^{(2)}_{x+t} )… — 질병끼리는 따로 생긴다고 보고 곱으로",
      "Q′_{x+t} = q_{x+t} + F_{x+t} − q_{x+t}·F_{x+t}/2 — 사망과는 겹치는 부분을 절반으로",
    ].join("\n") });
  } else {
    basisBlocks.push({ t: "p", path: "basis.waiver", text: spec.basis.waiver
      ? "납입면제를 적용하나 위험률이 지정되지 않았습니다."
      : "별도의 납입면제율을 두지 않는다(f = 0). 납입자수 l′ 는 각 담보의 탈퇴 사유로 유지자수 l 과 똑같이 줄어든다(라. 유지자수·납입자수)." });
  }
  basisBlocks.push({ t: "p", text: "(5) 예정사업비율", path: "expenses" });
  basisBlocks.push(spec.expenses.length
    ? table(["구분", "기호", "기준", "적용사업비율"], spec.expenses.map((e, i) => [[
        e.group + (e.phase ? ` (${e.phase})` : ""), e.symbol || "—", e.basis, expenseRate(e)], `expenses[${i}]`]))
    : { t: "p", text: "사업비가 지정되지 않았습니다.", path: "expenses" });
  // 나. 보장 내용 — 담보 표
  const unitBlocks: DocBlock[] = [];
  if (spec.units.length > 1) {
    unitBlocks.push({ t: "p", path: "units", text: "주계약과 특약을 따로 산출하고 합친다. 특약은 주계약 조건을 물려받고, 아래 표의 '주계약과 다른 조건'만 달리 적용한다." });
    unitBlocks.push(table(["구분", "이름", "담보", "주계약과 다른 조건"], spec.units.map((u, i) => [[
      u.main ? "주계약" : "특약", u.name,
      u.benefitIds.map((id) => spec.benefits.find((b) => b.id === id)?.name ?? id).join(", "),
      Object.keys(u.overrides ?? {}).length ? Object.keys(u.overrides ?? {}).join(", ") : "— (모두 상속)",
    ], `units[${i}]`])));
  }
  // 탈퇴 사유가 같은 담보는 유지자수가 똑같다 — 그 집단 이름을 담보마다 적어 라. 의 식과 이어 준다
  const groups = groupModels(spec);
  if (groups.length) {
    unitBlocks.push({ t: "note", path: groups.flatMap((g) => g.benefitIdx.map((i) => `benefits[${i}]`)).join("|"),
      text: `유지자수 집단 ${groups.length}개 — ${groups.map((g) => `${g.label}(${g.benefitIdx.map((i) => spec.benefits[i].name).join(" · ")})`).join(", ")}. 유지자수 l 은 집단마다, 납입자수 l′ 는 ${payerModels(spec).map((p) => p.label).join(" · ")} 하나로 라. 에서 낸다. 보장금액은 보험가입금액 × 배수이고, 보험료·준비금은 보장금액 1원당으로 낸 뒤 맨 뒤에서 곱한다.` });
  }
  spec.benefits.forEach((b, i) => {
    const ev = eventRate(spec, b);
    unitBlocks.push(table(["담보", b.name], ([
      // 계약 단위는 특약이 있을 때만(주계약뿐이면 적지 않는다)
      ...(b.unit ? [["단위", b.unit] as [string, string]] : []),
      ["급부 유형", RATE_ROLE_LABEL[b.role]],
      // 지급 사유는 담보 이름과 겹치기 쉬워 따로 적었을 때만 싣는다
      ...(b.trigger ? [["지급 사유", b.trigger] as [string, string]] : []),
      ["보험기간", endAgeLabel(b.endAge)],
      ["보장금액", amountLabel(b)],
      ["면책·삭감", waitLabel(b)],
      // 급부 위험률은 탈퇴 사유(집단)에서 정해진다 — 사망형은 탈퇴 사유 전부, 진단형은 그 가운데 사망이 아닌 것
      ["급부 위험률", b.role === "death" ? "탈퇴 사유 전부" : ev?.name ?? (eventCauses(spec, b).length > 1 ? `사망 외 탈퇴 사유 전부 (${eventCauses(spec, b).map((r) => r.name).join(" · ")})` : "—")],
      ["탈퇴 위험률", (b.exitRateIds ?? []).map(rateName).join(" 및 ") || "—"],
      ["집단", groups.find((g) => g.benefitIdx.includes(i))?.label ?? "—"],
    ] as [string, string][]).map((row) => [row, `benefits[${i}]`])));
  });
  spec.benefits.forEach((b, i) => {
    if (b.steps?.length) unitBlocks.push({ t: "note", path: `benefits[${i}].steps`, text: `${b.name}: 연령 구간 배수 ${b.steps.map((x) => `${x.fromAge}~${x.toAge}세 ${x.multiple}배`).join(" · ")}` });
    if (b.points?.length) unitBlocks.push({ t: "note", path: `benefits[${i}].points`, text: `${b.name}: 생존급부 ${b.points.map((x) => `${x.age}세 ${x.multiple}배`).join(" · ")}` });
  });
  // 식은 절(section)별로 묶는다 — 앞 넷은 1장의 라~사, 준비금·환급금은 2·3장
  const bySection = new Map<string, typeof spec.formulas>();
  for (const f of spec.formulas) {
    const list = bySection.get(f.section) ?? [];
    list.push(f);
    bySection.set(f.section, list);
  }
  const formulaBlocks = (list: typeof spec.formulas): DocBlock[] => list.flatMap((f) => {
    // 조건 경로에 식의 짝(formula:pv.N)도 단다 — 조건 카드가 자기 식 덩이만 정확히 짚을 수 있게.
    // 조건 파일의 줄이 아니므로 줄 짝짓기(linesOfPaths)는 그냥 지나간다
    const path = [f.path, f.key ? `formula:${f.key.replace(/:/g, ".")}` : ""].filter(Boolean).join("|") || undefined;
    return [
      { t: "p" as const, text: f.label, path, kind: "label" as const },
      { t: "formula" as const, text: f.text, path },
      ...(f.note ? [{ t: "note" as const, text: f.note, path }] : []),
    ];
  });
  const take = (name: string) => { const l = bySection.get(name); bySection.delete(name); return l; };

  basisBlocks.push(sub("보장 내용", "benefits"));
  // 시산 기준은 계산하는 앱이 채웠을 때만 — 산출방법서를 읽은 조건에는 없다
  if (hasContract(spec.contract)) {
    basisBlocks.push({ t: "p", path: "contract", text: "시산 기준 — 보험료·책임준비금 예시는 아래 계약으로 계산한다." }, table(["항목", "내용"], [
      [["피보험자", `${spec.contract.age ?? "—"}세 ${spec.contract.sex === "F" ? "여" : spec.contract.sex === "M" ? "남" : ""}`], "contract.age|contract.sex"],
      [["보험기간", yearsOf(spec.contract.termYears, spec.contract.termAge)], "contract.termYears|contract.termAge"],
      [["보험료 납입기간", yearsOf(spec.contract.payYears, spec.contract.payAge)], "contract.payYears|contract.payAge"],
      [["납입주기", spec.contract.freq ? (spec.contract.freq === 12 ? "월납" : spec.contract.freq === 1 ? "연납" : `연 ${spec.contract.freq}회`) : "—"], "contract.freq"],
      ...(spec.contract.sumAssured ? [[["보험가입금액", wonOf(spec.contract.sumAssured)], "contract.sumAssured"] as [string[], string]] : []),
    ]));
  }
  basisBlocks.push(...unitBlocks);
  if (spec.formulas.length) basisBlocks.push(sub("기호의 정의"), ...symbolBlocks(spec, groups));
  for (const name of PREMIUM_SUBS) {
    const list = take(name);
    if (list?.length) basisBlocks.push(sub(name), ...formulaBlocks(list));
  }
  out.push({ id: "premium", title: "1. 보험료의 계산에 관한 사항", blocks: basisBlocks });

  // 2·3. 책임준비금·해지환급금 — 식과 관련 사항을 한 장에
  let no = 2;
  for (const [name, notes, path] of [[RESERVE, spec.reserve.notes, "reserve"], [SURRENDER, spec.surrender.notes, "surrender"]] as const) {
    const list = take(name) ?? [];
    const extra: DocBlock[] = [
      ...(name === SURRENDER && spec.surrender.deductionYears
        ? [{ t: "note" as const, path: "surrender.deductionYears", text: `해약공제는 납입기간과 ${spec.surrender.deductionYears}년 중 짧은 기간에 걸쳐 매년 균등하게 줄어든다.` }] : []),
      ...notes.map((t, i) => ({ t: "note" as const, text: t, path: `${path}.notes[${i}]` })),
    ];
    // 관련 사항(글)을 먼저, 식을 나중에 — 실무 문서의 차례이고, 되읽을 때도 글이 식의 ※ 덧붙임으로 붙지 않는다
    if (list.length || extra.length) out.push({ id: path, title: `${no++}. ${name}`, blocks: [...extra, ...formulaBlocks(list)] });
  }
  // 사용자가 새로 만든 절(조건의 formulas 에 새 절 이름을 적은 것)
  for (const [name, list] of bySection) out.push({ id: `formula-${no}`, title: `${no++}. ${name}`, blocks: formulaBlocks(list) });

  spec.sections.forEach((s, si) => {
    out.push({ id: `extra-${no}`, title: `${no++}. ${s.title}`, blocks: [
      ...s.paragraphs.map((p) => ({ t: "p" as const, text: p, path: `sections[${si}]` })),
      ...(s.tables ?? []).map((tb) => ({ t: "table" as const, head: tb.head, rows: tb.rows, rowPaths: tb.rows.map(() => `sections[${si}]`) })),
    ] });
  });

  for (const s of opt.extra ?? []) out.push({ ...s, title: s.title.replace(/^\d+\.\s*/, `${no++}. `) });
  const appendix = rateTableBlocks(spec);
  if (appendix.length) out.push({ id: "rate-tables", title: `${no++}. 별첨 — 위험률 표`, blocks: appendix });
  return out;
}

/** 편집용 내보내기(Word·Markdown·LaTeX)의 표시 — 수식 제목 앞 "[식]", 주석 앞 "※". 되읽을 때 식·주석의 경계가 된다 */
export const FORMULA_MARK = "[식]";
export const NOTE_MARK = "※";

/** 블록 → Markdown */
export function docToMarkdown(sections: DocSection[], title?: string): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, "");
  for (const sec of sections) {
    lines.push(`## ${sec.title}`, "");
    for (const b of sec.blocks) {
      if (b.t === "p") lines.push(b.kind === "label" ? `${FORMULA_MARK} ${b.text}` : b.kind === "sub" ? `### ${b.text}` : b.text, "");
      else if (b.t === "note") lines.push(`> ${NOTE_MARK} ${b.text}`, "");
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

/** 숫자 칸인지 — 금액·비율·기간 같은 것만 오른쪽 정렬한다("종신보험", "보험가입금액" 같은 글자 칸은 왼쪽) */
export const isNumericCell = (c: string | number) =>
  typeof c === "number" || /^[-−+]?[\d,]+(\.\d+)?(\s*\/\s*[\d,]+(\.\d+)?)?\s*(원\/일|원|%|‰|세|년|배|개|일|행)?$/.test(String(c).trim());

/** 평문 수식의 아래·위첨자를 HTML 로 (KaTeX 가 없는 곳의 대체 표시) */
export const subSup = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string))
  .replace(/_\{([^}]*)\}/g, "<sub>$1</sub>").replace(/\^\{([^}]*)\}/g, "<sup>$1</sup>")
  .replace(/_([A-Za-z0-9α-ωΑ-Ω]+)/g, "<sub>$1</sub>").replace(/\^([A-Za-z0-9가-힣α-ωΑ-Ω]+)/g, "<sup>$1</sup>");

export const DOC_CSS = `
@page{size:A4;margin:18mm 16mm}
body{font-family:"Malgun Gothic","맑은 고딕",sans-serif;font-size:10.5pt;line-height:1.55;color:#111}
h1{font-size:18pt;border-bottom:2px solid #1b2845;padding-bottom:6px}
h2{font-size:13pt;margin-top:22px;border-bottom:1px solid #ccc;padding-bottom:3px;break-after:avoid}
h3{font-size:11.5pt;margin-top:16px;break-after:avoid}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:9.5pt;break-inside:avoid}
th,td{border:1px solid #bbb;padding:4px 7px;text-align:left;vertical-align:top;word-break:keep-all}
th{background:#f0f2f5;font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
table.wide{font-size:7.8pt}table.wide th,table.wide td{padding:3px 4px}
blockquote{border-left:3px solid #4a90c2;margin:8px 0;padding:2px 12px;color:#444;background:#f7f9fb}
pre,.formula{background:#f6f7f9;padding:8px 10px;white-space:pre-wrap;font-size:10pt;overflow-x:auto}
`;

/**
 * 블록 → 인쇄용 HTML (브라우저 없이도 파일로 낼 수 있게).
 * formula 를 넘기면 수식 블록을 그 함수로 그린다(예: KaTeX). 없으면 첨자만 살린 평문.
 */
export function docToHtml(sections: DocSection[], title: string, formula?: (text: string) => string, head = ""): string {
  const esc = (s: string | number) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
  const body = sections.map((sec) => `<section><h2>${esc(sec.title)}</h2>${sec.blocks.map((b) => {
    if (b.t === "p") return b.kind === "sub" ? `<h3>${subSup(b.text)}</h3>` : `<p>${subSup(b.text)}</p>`;
    if (b.t === "note") return `<blockquote>${subSup(b.text)}</blockquote>`;
    if (b.t === "formula") return formula ? `<div class="formula">${formula(b.text)}</div>` : `<pre>${subSup(b.text)}</pre>`;
    return `<table${b.head.length >= 8 ? ' class="wide"' : ""}><thead><tr>${b.head.map((h) => `<th>${subSup(h)}</th>`).join("")}</tr></thead><tbody>${
      b.rows.map((r) => `<tr>${r.map((c, i) => `<td${i && isNumericCell(c) ? ' class="num"' : ""}>${subSup(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }).join("")}</section>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}<style>${DOC_CSS}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
