import { hasProduct, RATE_ROLE_LABEL, type ExpenseItem, type MethodSpec, type ProductInfo } from "./spec";

/**
 * MethodSpec → 산출방법서. 앱에 딸리지 않는다(import 는 spec 하나뿐).
 * 블록 구조 하나에서 화면(JSX)·Markdown·HTML·LaTeX 를 모두 만든다 — 마크다운 파서가 필요 없다.
 * 목차와 문구는 참조한 원본 산출방법서(1.기초율 2.보험료 3.책임준비금 4.해지환급금 5.가입금액 변경)를 따른다.
 *
 * 블록마다 조건 경로(path)를 단다 — "basis.interest", "expenses[2]", "benefits[0]".
 * 한 블록이 여러 조건에서 나오면 "|" 로 잇는다("contract.age|contract.sex").
 * 편집기는 이 경로로 조건 줄 ↔ 산출방법서 블록을 서로 짝짓는다.
 */
export type DocBlock =
  | { t: "p"; text: string; path?: string }
  | { t: "formula"; text: string; path?: string }
  | { t: "note"; text: string; path?: string }
  | { t: "table"; head: string[]; rows: (string | number)[][]; rowPaths?: (string | undefined)[] };
export interface DocSection { id: string; title: string; blocks: DocBlock[] }

const pctOf = (x?: number, d = 3) => (x === undefined ? "—" : `${(x * 100).toFixed(d)}%`);
const wonOf = (x?: number) => (x === undefined ? "—" : `${Math.round(x).toLocaleString("ko-KR")}원`);
const yearsOf = (y?: number, a?: number) => (y ? `${y}년` : a ? `${a}세 만기` : "—");

/** 사업비 한 줄의 비율 표기 — 원문이 있으면 원문을, 없으면 정규화 값을 쓴다 */
export function expenseRate(e: ExpenseItem): string {
  if (e.raw) return e.raw;
  if (e.times !== undefined) return `${e.times}배`;
  if (e.rate !== undefined) return e.rate >= 0.01 ? `${(e.rate * 100).toFixed(2)}%` : `${(e.rate * 1000).toFixed(2)}/1,000`;
  return "—";
}

/** [행, 경로] 쌍으로 표를 만든다 — 행과 경로가 어긋나지 않게 */
function table(head: string[], pairs: [(string | number)[], string | undefined][]): DocBlock {
  return { t: "table", head, rows: pairs.map((p) => p[0]), rowPaths: pairs.map((p) => p[1]) };
}

export interface RenderOptions {
  /** 산출 결과(연도별 표·검증)를 같이 실을 때 */
  extra?: DocSection[];
  today?: Date;
}

/**
 * 가입 조건(정보) — 사업방법서의 "보험기간 | 보험료 납입기간 | 가입나이" 표와 종류·종목·납입주기·한도·갱신.
 * 머리글을 "가입 조건 | 내용" 과 "보험기간 | …" 으로 둔다 — parse 가 이 두 표를 먼저 떼어 내 계약(시산 기준)과 섞지 않는다.
 */
function productBlocks(p: ProductInfo): DocBlock[] {
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
  out.push({ t: "note", path: "product", text: "가입 조건은 판매 범위를 적은 정보이며, 보험료·책임준비금 예시는 2. 의 시산 기준으로 계산한다." });
  return out;
}

/** 산출방법서 본문 */
export function renderMethodDoc(spec: MethodSpec, opt: RenderOptions = {}): DocSection[] {
  const today = opt.today ?? new Date();
  const out: DocSection[] = [];
  const rateName = (id?: string) => spec.rates.find((r) => r.id === id)?.name ?? "—";

  // 0. 표지
  out.push({ id: "cover", title: "개요", blocks: [
    table(["항목", "내용"], [
      [["상품명", spec.meta.productName || "(이름 없음)"], "meta.productName"],
      ...(spec.meta.insurer ? [[["회사", spec.meta.insurer], "meta.insurer"] as [string[], string]] : []),
      ...(spec.meta.kind ? [[["종류", spec.meta.kind], "meta.kind"] as [string[], string]] : []),
      [["작성일", spec.meta.date || today.toLocaleDateString("ko-KR")], "meta.date"],
      ...(spec.meta.version ? [[["판", spec.meta.version], "meta.version"] as [string[], string]] : []),
      [["계약 단위", spec.units.length ? spec.units.map((u) => u.name).join(" · ") : "주계약"], "units"],
    ]),
    ...(spec.meta.note ? [{ t: "note" as const, text: spec.meta.note, path: "meta.note" }] : []),
    ...(hasProduct(spec.product) ? productBlocks(spec.product) : []),
  ] });

  // 1. 기초율
  const basisBlocks: DocBlock[] = [
    { t: "p", text: "1.1. 이율에 관한 사항", path: "basis" },
    table(["구분", "값"], [
      [["적용이율 i", pctOf(spec.basis.interest)], "basis.interest"],
      [["표준이율", pctOf(spec.basis.standardInterest)], "basis.standardInterest"],
      ...(spec.basis.minGuaranteed !== undefined ? [[["최저보증이율", pctOf(spec.basis.minGuaranteed)], "basis.minGuaranteed"] as [string[], string]] : []),
      ...(spec.basis.averagePublished !== undefined ? [[["평균공시이율", pctOf(spec.basis.averagePublished)], "basis.averagePublished"] as [string[], string]] : []),
      ...(spec.basis.interest !== undefined ? [[["현가율 v = 1/(1+i)", (1 / (1 + spec.basis.interest)).toFixed(6)], "basis.interest"] as [string[], string]] : []),
    ]),
    { t: "p", text: "1.2. 위험률에 관한 사항", path: "rates" },
  ];
  if (spec.rates.length) {
    basisBlocks.push(table(["위험률", "유형", "근거·출처", "표"], spec.rates.map((r, i) => [[
      r.name + (r.adjustment ? ` ${r.adjustment}` : ""),
      RATE_ROLE_LABEL[r.role],
      r.source ?? "—",
      r.table ? `${r.table.ages[0]}~${r.table.ages[r.table.ages.length - 1]}세 ${r.table.ages.length}행` : "별첨",
    ], `rates[${i}]`])));
  } else {
    basisBlocks.push({ t: "p", text: "위험률이 지정되지 않았습니다.", path: "rates" });
  }
  basisBlocks.push({ t: "note", text: "표준위험률이 없는 경우에는 적용위험률을 사용한다." });
  basisBlocks.push({ t: "p", text: "1.3. 적용해지율에 관한 사항", path: "basis.lapse" });
  if (spec.basis.lapse?.length) {
    basisBlocks.push(table(["구분", "적용해지율", "적용 구간"], spec.basis.lapse.map((l, i) => [[
      l.label ?? "—", pctOf(l.rate, 1), l.duringPayOnly ? "보험료 납입기간 중 (납입 완료 후 0%)" : "전 기간",
    ], `basis.lapse[${i}]`])));
    if (spec.basis.lowRatio !== undefined) {
      basisBlocks.push({ t: "note", path: "basis.lowRatio", text: `납입기간 중 해지환급금 = 표준형(완전 환급) × ${Math.round(spec.basis.lowRatio * 100)}%${spec.basis.lowRatio === 0 ? " (무해지환급형)" : ""}.` });
    }
  } else basisBlocks.push({ t: "p", text: "적용하지 않음 (w = 0).", path: "basis.lapse" });
  basisBlocks.push({ t: "p", text: "1.4. 납입면제(납입자수)에 관한 사항", path: "basis.waiver" });
  const waiverRates = spec.rates.filter((r) => r.role === "waiver");
  if (spec.basis.waiver && waiverRates.length) {
    basisBlocks.push({ t: "p", path: "basis.waiver", text: "납입자수 l′ 는 담보의 탈퇴 사유로 유지자수와 함께 줄고, 아래 사유가 생기면 보장은 유지한 채 납입만 면제되어 더 준다." });
    basisBlocks.push({ t: "formula", path: "basis.waiver", text: `f_x : ${waiverRates.map((r) => r.name).join(" · ")}` });
  } else {
    basisBlocks.push({ t: "p", path: "basis.waiver", text: spec.basis.waiver
      ? "납입면제를 적용하나 위험률이 지정되지 않았습니다."
      : "별도의 납입면제율을 두지 않는다. 납입자수 l′ 는 각 담보의 탈퇴 사유로 유지자수 l 과 똑같이 줄어든다(3. 계산기수의 담보별 식)." });
  }
  basisBlocks.push({ t: "p", text: "1.5. 시산보험료 계산 시 적용하는 사업비에 관한 사항", path: "expenses" });
  basisBlocks.push(spec.expenses.length
    ? table(["구분", "기호", "기준", "적용사업비율"], spec.expenses.map((e, i) => [[
        e.group + (e.phase ? ` (${e.phase})` : ""), e.symbol || "—", e.basis, expenseRate(e)], `expenses[${i}]`]))
    : { t: "p", text: "사업비가 지정되지 않았습니다.", path: "expenses" });
  out.push({ id: "basis", title: "1. 기초율에 관한 사항", blocks: basisBlocks });

  // 2. 계약 단위와 급부
  const unitBlocks: DocBlock[] = [];
  if (spec.units.length > 1) {
    unitBlocks.push({ t: "p", path: "units", text: "주계약과 특약을 따로 산출하고 합친다. 특약은 주계약 조건을 물려받고, 아래 표의 '주계약과 다른 조건'만 달리 적용한다." });
    unitBlocks.push(table(["구분", "이름", "담보", "주계약과 다른 조건"], spec.units.map((u, i) => [[
      u.main ? "주계약" : "특약", u.name,
      u.benefitIds.map((id) => spec.benefits.find((b) => b.id === id)?.name ?? id).join(", "),
      Object.keys(u.overrides ?? {}).length ? Object.keys(u.overrides ?? {}).join(", ") : "— (모두 상속)",
    ], `units[${i}]`])));
  }
  unitBlocks.push(table(["담보", "단위", "급부 유형", "지급 사유", "보장금액", "보장 종료", "면책", "급부 위험률", "탈퇴 위험률"],
    spec.benefits.map((b, i) => [[
      b.name, b.unit ?? "주계약", RATE_ROLE_LABEL[b.role], b.trigger ?? "—",
      wonOf(b.amount) + (b.role === "recurring" ? "/일" : ""),
      b.endAge ? `${b.endAge}세` : "—",
      b.waitDays ? `${b.waitDays}일` : "없음",
      b.role === "death" && !b.rateId ? "탈퇴 사유 전부" : rateName(b.rateId),
      (b.exitRateIds ?? []).map(rateName).join(" 및 ") || "—",
    ], `benefits[${i}]`])));
  spec.benefits.forEach((b, i) => {
    if (b.steps?.length) unitBlocks.push({ t: "note", path: `benefits[${i}].steps`, text: `${b.name}: 연령 구간 배수 ${b.steps.map((x) => `${x.fromAge}~${x.toAge}세 ${x.multiple}배`).join(" · ")}` });
    if (b.points?.length) unitBlocks.push({ t: "note", path: `benefits[${i}].points`, text: `${b.name}: 생존급부 ${b.points.map((x) => `${x.age}세 ${x.multiple}배`).join(" · ")}` });
  });
  out.push({ id: "units", title: "2. 계약 단위와 급부", blocks: [
    { t: "p", path: "contract", text: "시산 기준 — 보험료·책임준비금 예시는 아래 계약으로 계산한다." },
    table(["항목", "내용"], [
      [["피보험자", `${spec.contract.age ?? "—"}세 ${spec.contract.sex === "F" ? "여" : spec.contract.sex === "M" ? "남" : ""}`], "contract.age|contract.sex"],
      [["보험기간", yearsOf(spec.contract.termYears, spec.contract.termAge)], "contract.termYears|contract.termAge"],
      [["보험료 납입기간", yearsOf(spec.contract.payYears, spec.contract.payAge)], "contract.payYears|contract.payAge"],
      [["납입주기", spec.contract.freq ? (spec.contract.freq === 12 ? "월납" : spec.contract.freq === 1 ? "연납" : `연 ${spec.contract.freq}회`) : "—"], "contract.freq"],
      ...(spec.contract.sumAssured ? [[["보험가입금액", wonOf(spec.contract.sumAssured)], "contract.sumAssured"] as [string[], string]] : []),
    ]),
    ...unitBlocks,
  ] });

  // 3~. 수식 — 절별로 묶는다
  const bySection = new Map<string, typeof spec.formulas>();
  for (const f of spec.formulas) {
    const list = bySection.get(f.section) ?? [];
    list.push(f);
    bySection.set(f.section, list);
  }
  let no = 3;
  for (const [section, list] of bySection) {
    const blocks: DocBlock[] = [];
    for (const f of list) {
      blocks.push({ t: "p", text: f.label, path: f.path });
      blocks.push({ t: "formula", text: f.text, path: f.path });
      if (f.note) blocks.push({ t: "note", text: f.note, path: f.path });
    }
    out.push({ id: `formula-${no}`, title: `${no}. ${section}`, blocks });
    no++;
  }

  if (spec.reserve.notes.length) out.push({ id: "reserve-notes", title: `${no++}. 책임준비금 관련 사항`, blocks: spec.reserve.notes.map((t, i) => ({ t: "note", text: t, path: `reserve.notes[${i}]` })) });
  if (spec.surrender.notes.length || spec.surrender.deductionYears) {
    out.push({ id: "surrender-notes", title: `${no++}. 해지환급금 관련 사항`, blocks: [
      ...(spec.surrender.deductionYears ? [{ t: "note" as const, path: "surrender.deductionYears", text: `해약공제는 납입기간과 ${spec.surrender.deductionYears}년 중 짧은 기간에 걸쳐 매년 균등하게 줄어든다.` }] : []),
      ...spec.surrender.notes.map((t, i) => ({ t: "note" as const, text: t, path: `surrender.notes[${i}]` })),
    ] });
  }

  spec.sections.forEach((s, si) => {
    out.push({ id: `extra-${no}`, title: `${no++}. ${s.title}`, blocks: [
      ...s.paragraphs.map((p) => ({ t: "p" as const, text: p, path: `sections[${si}]` })),
      ...(s.tables ?? []).map((tb) => ({ t: "table" as const, head: tb.head, rows: tb.rows, rowPaths: tb.rows.map(() => `sections[${si}]`) })),
    ] });
  });

  for (const s of opt.extra ?? []) out.push({ ...s, title: s.title.replace(/^\d+\.\s*/, `${no++}. `) });
  return out;
}

/** 블록 → Markdown */
export function docToMarkdown(sections: DocSection[], title?: string): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  if (title) lines.push(`# ${title}`, "");
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
    if (b.t === "p") return `<p>${subSup(b.text)}</p>`;
    if (b.t === "note") return `<blockquote>${subSup(b.text)}</blockquote>`;
    if (b.t === "formula") return formula ? `<div class="formula">${formula(b.text)}</div>` : `<pre>${subSup(b.text)}</pre>`;
    return `<table${b.head.length >= 8 ? ' class="wide"' : ""}><thead><tr>${b.head.map((h) => `<th>${subSup(h)}</th>`).join("")}</tr></thead><tbody>${
      b.rows.map((r) => `<tr>${r.map((c, i) => `<td${i && isNumericCell(c) ? ' class="num"' : ""}>${subSup(String(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }).join("")}</section>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}<style>${DOC_CSS}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;
}
