import type { DocTable, ExtractedDoc } from "./extract";
import { comboLabel, compactCombos, compactSurvivors, crowdLabel, eventRate, generateFormulas, isAutoKeepLabel, keepLabel, legacyRateSymbols, rateSymbols, syncFromSurvivors } from "./formulas";
import { FORMULA_MARK, NOTE_MARK } from "./render";
import { coverFields, emptySpec, hasProduct, RATE_ROLE_LABEL, validateSpec, type BenefitSpec, type Confidence, type EntryRow, type Evidence, type ExpenseItem, type ExtraSection, type FormulaSpec, type MethodSpec, type ParseResult, type ProductInfo, type RateRef, type RateRole, type SurvivorSpec } from "./spec";

/**
 * 산출방법서 → MethodSpec. 규칙(표 먼저, 본문 다음)만으로 돌아간다 — LLM 은 선택이다.
 * 실제 산출방법서 2건(DOCX·HWP, DRM 없음)에 맞춰 사전을 짰다.
 * 뽑은 값마다 Evidence(원문·출처·확신도)를 남겨, 검수 화면이 사람에게 확인받을 수 있게 한다.
 */

// ── 단위 정규화 ──────────────────────────────────────────────────────────────
const NUM = String.raw`(-?[\d,]+(?:\.\d+)?)`;
/** 전각 ％·﹪ 도 백분율이다 (HWP→PDF 에서 자주 나온다) */
const PCT = "[%％﹪]";
const n = (s: string) => Number(s.replace(/,/g, ""));

/**
 * PDF 는 글자 사이에 공백을 넣어 뽑히는 일이 잦다 — "표 준 이 율", "유 지 비".
 * 규칙 대조용으로만 쓰는 납작한 사본이다(한글 사이 공백만 지운다. 숫자·기호는 그대로).
 * 사전의 낱말은 모두 붙여 쓰거나 `\s*` 를 쓰므로, 지워도 못 찾던 게 찾아질 뿐 새로 틀리지 않는다.
 */
export const squeeze = (s: string) => s.replace(/(?<=[가-힣])\s+(?=[가-힣])/g, "");

/** 문장 안에 섞인 비율 하나 — "초년도 보험가입금액의 2.50 / 1,000", "영업보험료의 8.75%" */
const RATE_TOKEN = new RegExp(`${NUM}\\s*(?:/\\s*[\\d,]+|${PCT}|‰)`);
export function pickRate(text: string): { value: number; raw: string } | null {
  const m = RATE_TOKEN.exec(text);
  if (!m) return null;
  const v = parseRate(m[0]);
  return v === null ? null : { value: v, raw: m[0].replace(/\s+/g, "") };
}

/** "2.5%" · "80/1000" · "6.8/1,000" · "1‰" · "0.15" → 소수 */
export function parseRate(raw: string): number | null {
  const s = raw.replace(/\s/g, "").replace(/[％﹪]/g, "%");
  let m = new RegExp(`^${NUM}%$`).exec(s);
  if (m) return n(m[1]) / 100;
  m = new RegExp(`^${NUM}/${NUM}$`).exec(s);
  if (m) { const d = n(m[2]); return d ? n(m[1]) / d : null; }
  m = new RegExp(`^${NUM}(?:‰|퍼밀)$`).exec(s);
  if (m) return n(m[1]) / 1000;
  m = new RegExp(`^${NUM}$`).exec(s);
  if (m) { const v = n(m[1]); return v > 1 ? null : v; }   // 맨 숫자는 1 이하일 때만 비율로 본다
  return null;
}
/** "15%" 가 배수인지 비율인지는 기준 문구로 가른다 */
export function parseTimes(raw: string): number | null {
  const m = new RegExp(`^${NUM}\\s*배$`).exec(raw.replace(/\s/g, ""));
  return m ? n(m[1]) : null;
}

// ── 사전 ────────────────────────────────────────────────────────────────────
export interface FieldRule {
  path: string;
  label: string;
  /** 이 낱말이 줄에 있어야 한다 */
  words: RegExp;
  /** 값 패턴 — 첫 그룹이 값 */
  value: RegExp;
  kind: "rate" | "int" | "text";
  /** 같은 줄에 이 낱말이 있으면 건너뛴다(오인식 방지) */
  not?: RegExp;
}

export const FIELD_RULES: FieldRule[] = [
  // "이율(i)" · "이율( 𝐢 )" 처럼 뒤집힌 표기도 잡는다. 공시이율·적립이율·연체이율은 다른 이율이다
  { path: "basis.interest", label: "적용이율", kind: "rate",
    words: /(적용이율|예정이율|적용\s*기초율[^가-힣]*이율|보장부분\s*:?\s*적용이율|이율\s*\(\s*[i𝐢ｉIＩ]|^\s*이율\s*\()/,
    value: new RegExp(`(?:연\\s*복리|연)?\\s*${NUM}\\s*${PCT}`),
    not: /(표준이율|최저보증|평균공시|공시\s*이율|적립\s*이율|연체|할인율\s*[:：=])/ },
  // "표준이율의 125%", "표준이율+1%" 는 표준이율 자체가 아니다
  { path: "basis.standardInterest", label: "표준이율", kind: "rate",
    words: /표준이율/, value: new RegExp(`${NUM}\\s*${PCT}`), not: /(표준이율\s*의|[+＋])/ },
  { path: "basis.minGuaranteed", label: "최저보증이율", kind: "rate",
    words: /최저\s*보증\s*이율/, value: new RegExp(`${NUM}\\s*${PCT}`) },
  { path: "basis.averagePublished", label: "평균공시이율", kind: "rate",
    words: /평균\s*공시\s*이율/, value: new RegExp(`${NUM}\\s*${PCT}`), not: /[+＋]/ },
  // 시산 기준(가입나이·보험기간·납입기간)은 읽지 않는다 — 보험료를 계산하는 앱의 입력이다(spec.ts ContractSpec)
  { path: "benefits.waitDays", label: "면책기간", kind: "int",
    words: /(면책\s*기간|보장\s*개시|감액\s*지급)/, value: new RegExp(`${NUM}\\s*일`) },
];

/** 적용해지율 — 종류별로 여러 줄일 수 있어 따로 다룬다 */
const LAPSE_WORDS = /(적용\s*해지율|해지율)/;
const LAPSE_DURING = /(납입\s*기간\s*중|납입기간중)/;
const LAPSE_NONE = /(적용하지\s*않|해당\s*없|(?<![\d.])0\s*[%％])/;
const LOW_KIND = /(무해지|저해지)\s*환급/;

/** 사업비 표의 기준 문구 → 기호. 납작한(squeeze) 문자열에 대고 본다 */
const EXPENSE_SYMBOL: { re: RegExp; symbol: string; group: string; phase?: string }[] = [
  { re: /기타비용|^β['′]/, symbol: "β_기타", group: "계약관리비용(기타)" },
  { re: /계약체결|신계약비|^α/, symbol: "α", group: "계약체결비용" },
  { re: /유지관련|계약관리.*유지|계약관리비용|유지비|^β(?!['′])/, symbol: "β", group: "계약관리비용", phase: "납입중" },
  { re: /수금|^γ/, symbol: "γ", group: "수금비용" },
];
/** 표에 α1·α2·β1·β2·β′·γ 로만 적힌 줄은 그 기호를 그대로 쓴다 */
const GREEK = /^([αβγ])\s*(['′]|[12])?/;
/** "구분 | 기호 | 기준 | 비율" 처럼 기호가 제 칸에 있으면 그 칸이 가장 정확하다 */
const SYMBOL_CELL = /^[αβγ](['′]|[12]|_(?:S|P|G|기타))?$/;
const isAmountBasis = (s: string) => /(보험\s*가입\s*금액|가입금액|보험금)/.test(s);
// 공제는 "영업공제료·영업부담금" 이라 부른다
const isPremiumBasis = (s: string) => /(영업\s*(보험료|공제료|부담금)|보험료|공제료|부담금)/.test(s);
const isAnnualNet = (s: string) => /기준\s*연납\s*순(보험료|공제료)/.test(s);
/** "12% × MIN(보험기간, 20)" 의 20 — 이 모듈의 α_P 는 20년 기준 배수라 비율 × 20 이 α_P 다(n < 20 이면 식이 n/20 을 곱한다) */
const MIN_CAP = /MIN\s*\(\s*[^,()]*,\s*(\d+)\s*년?\s*\)/i;
const isBasis = (s: string) => isAmountBasis(s) || isPremiumBasis(s) || isAnnualNet(s);

const ROLE_WORDS: { re: RegExp; role: RateRole }[] = [
  { re: /(사망률|사망\s*위험률)/, role: "death" },
  // 납입면제는 "50%이상 장해" 또는 "납입면제" 로 적힌 계열만. 후유장해(80%이상) 담보는 급부다
  { re: /(납입\s*면제|장해.*50\s*[%％]?\s*이상|50\s*[%％]?\s*이상.*장해)/, role: "waiver" },
  { re: /(입원율|입원률|입원\s*일|통원|수술율|수술률)/, role: "recurring" },
  { re: /(발생률|발생율|진단률|진단율|지급률|이환율|장해)/, role: "incidence" },
  { re: /해지율/, role: "lapse" },
];
const roleOf = (name: string): RateRole => ROLE_WORDS.find((x) => x.re.test(name))?.role ?? "other";
/** "사망 · 최초발생 · 반복지급 · 납입면제" 처럼 유형이 칸으로 적힌 표를 되읽을 때 쓴다 */
const ROLE_BY_LABEL = new Map(Object.entries(RATE_ROLE_LABEL).map(([k, v]) => [v, k as RateRole]));

/** 위험률 계열 이름으로 볼 만한지 — 수익성 분석의 '최적OO율·할인율·수익률' 같은 잡음을 거른다 */
const RISK_WORD = /(사망|발생|진단|이환|입원|통원|수술|장해|치매|암|상해|질병|간병|지급률|해지율|재해|후유)/;
const NOT_RISK = /(최적|목표|할인|투자|수익|법인세|사업비|기초율|물가|인플레|환율|(?<!무)배당률)/;   // "무배당"이 걸리지 않게
/** 이름 없이 뜻만 있는 일반명사 — 목록에 넣어 봐야 쓸모가 없다 */
const BARE_WORD = /^(발생률|발생율|지급률|지급율|해지율|이환율|사망률|장해율)$/;
/** 조사·접속사로 시작하면 앞 줄에서 잘려 나온 조각이다 */
const FRAGMENT = /^(으로|로서|인한|및|또는|이나|거나|따른|의한|에서|에는|한다|하는)/;
export function looksLikeRateName(name: string): boolean {
  const s = name.trim();
  if (s.length < 3 || s.length > 40) return false;
  if (!/(률|율)$/.test(s)) return false;
  if (/^\(?\d/.test(s)) return false;          // "(1) …", "2) …"
  if (BARE_WORD.test(s) || FRAGMENT.test(s)) return false;
  // 떨어져 있는 조사("g 는 위 …의 급부 발생률")가 있으면 이름이 아니라 문장이다
  if (/(^|\s)[은는이가을를의에와과]\s/.test(s) || /^[A-Za-z]\s/.test(s)) return false;
  if (NOT_RISK.test(s)) return false;
  return RISK_WORD.test(s);
}

/**
 * 앞 줄이 문장 끝맺음 없이 끊겼으면 이 줄은 그 줄의 이어짐이다 —
 * PDF 는 "…무배당 예정 재해골절(치아파절제외)·골 / 다공증 수술률을 사용함" 처럼 낱말 가운데서 줄을 바꾼다.
 * 이어짐 줄에서 이름을 주우면 "다공증 수술률" 같은 토막이 남는다.
 */
const ENDS_CLEAN = /([함임음다까요]|[).\]」』”"]|호|년|세)\s*$/;
const continuation = (prev: string | undefined) => !!prev && prev.trim().length > 20 && !ENDS_CLEAN.test(prev);

// ── 파서 ────────────────────────────────────────────────────────────────────
const set = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
};

export interface ParseOptions {
  /** 상품명을 못 찾았을 때 쓸 이름 */
  fallbackName?: string;
}

export function parseMethodDoc(input: ExtractedDoc, opt: ParseOptions = {}): ParseResult {
  // 표준 양식 맨 앞의 "작성 안내" 표는 읽지 않는다(안내 글의 예시 값이 조건으로 들어가지 않게)
  const doc = { ...input, tables: input.tables.filter((t) => squeeze(t.head[0] ?? "").replace(/\s/g, "") !== "작성안내") };
  const spec = emptySpec(opt.fallbackName ?? "");
  const evidence: Evidence[] = [];
  const warnings = [...doc.warnings];
  // setValue=false 면 출처만 남기고 spec 은 건드리지 않는다(배열처럼 직접 채운 항목)
  const add: Add = (path, label, value, raw, source, confidence, setValue = true) => {
    if (evidence.some((e) => e.path === path)) return;     // 먼저 찾은 것(= 확신도 높은 것)을 남긴다
    evidence.push({ path, label, value, raw, source, confidence });
    if (setValue) set(spec as unknown as Record<string, unknown>, path, value);
  };

  // 0-0) 가입 조건 표(판매 범위: 보험기간·납입기간·가입나이 목록)를 먼저 떼어 낸다.
  //      이 표의 "110세만기 · 20년납" 이 본문 규칙(면책기간·해지율 등)에 섞이지 않게, 그 줄들은 아래 규칙에서 지운다.
  const productTables = readProduct(doc, spec, evidence);
  // 위험률 값 표(별첨 — 첫 열이 연령, 나머지가 수)는 조건이 아니라 값이다(앱이 위험률 표 창으로 가져간다). 열 이름이 위험률 이름으로 주워지지 않게 뺀다
  doc.tables.forEach((t, ti) => { if (isRateValueTable(t)) productTables.add(ti); });
  const productRows = new Set([...productTables].flatMap((ti) => [doc.tables[ti].head, ...doc.tables[ti].rows].map((r) => squeeze(r.filter(Boolean).join(" ")))));
  const paragraphs = doc.paragraphs.map((p) => (productRows.has(squeeze(p)) ? "" : p));

  // 0) 상품명 — 표지 문단. 수식·항목 제목이 걸리지 않게 거른다
  const NOT_TITLE = /([%％]|에\s*관한\s*사항|계산|산출|별첨|목차|제\s*\d+\s*조|순보험료|영업보험료|기준|비율)/;
  const ok = (p: string) => p.trim().length >= 4 && p.length < 40 && !/산출방법서/.test(p) && !NOT_TITLE.test(p);
  // 상품명은 거의 항상 "…보험 / …공제" 로 끝난다. 그런 줄이 없을 때만 느슨하게 찾고, 그량이면 파일이름을 쓴다
  // 본문 한 줄이 우연히 "… 보험" 으로 끝나는 일이 잦다("…유방암 진단확정으로 진단보험").
  // 상품명은 짧고, 조사·서술어가 없고, 숫자가 있으면 "무배당·(무)" 로 시작한다.
  const NAME_LIKE = (p: string) => {
    const t = p.trim();
    if (!/(보험|공제)\s*$/.test(t) || /[「」『』]/.test(t)) return false;
    if (/(로부터|으로|에서|까지|에는|하여|하는|되는|이후|경우|따라|관한|위한|미만|이상|이내)/.test(t)) return false;
    if (t.split(/\s+/).length > 5) return false;
    return !/\d/.test(t) || /^\(?무\)?배당|^\(무\)/.test(t);
  };
  const title = paragraphs.find((p) => NAME_LIKE(p) && ok(p))
    ?? opt.fallbackName
    ?? paragraphs.find((p) => /(보험|공제)/.test(p) && ok(p))
    ?? doc.paragraphs[0];
  // 표지 표에 "상품명 | …", "종류 | …" 행이 있으면 그것이 가장 정확하다
  const cover = (label: RegExp): [string, number] | undefined => {
    for (const [ti, t] of doc.tables.entries()) for (const r of [t.head, ...t.rows]) {
      if (r.length >= 2 && label.test(squeeze(r[0] ?? "").trim()) && r[1]?.trim()) return [r[1].trim(), ti];
    }
  };
  const coverName = cover(/^상품명$/), coverKind = cover(/^종류$/);
  // 개요 표의 "양식 | 표준 산출방법서 v1" — 이 표시가 있으면 수식·주석·절까지 정해진 순서로 읽는다
  const format = cover(/^양식$/)?.[0];
  const standard = !!format && /표준\s*산출방법서/.test(format);
  if (coverName) add("meta.productName", "상품명", coverName[0], `상품명 ${coverName[0]}`, `표 ${coverName[1] + 1}`, "high");
  if (title) add("meta.productName", "상품명", title, title, "표지", "medium");
  if (coverKind) add("meta.kind", "종류", coverKind[0], `종류 ${coverKind[0]}`, `표 ${coverKind[1] + 1}`, "high");
  const kindLine = paragraphs.find((p) => LOW_KIND.test(p));
  if (kindLine) add("meta.kind", "종류", LOW_KIND.exec(kindLine)![0], kindLine, "본문", "medium");

  // 1) 표 먼저 — 적중률이 가장 높다
  doc.tables.forEach((t, ti) => {
    if (productTables.has(ti)) return;
    readExpenseTable(t, ti, spec, add);
    readBasisTable(t, ti, add, spec);
  });

  // 2) 본문 규칙
  scanLines(paragraphs, (li) => `본문 ${li + 1}줄`, "medium", spec, add);

  // 3) 위험률 — "○ …률" 목록과 "…를 사용함" 문구.
  //    표준 양식은 위험률을 표("위험률 | 기호 | 유형 | 근거·출처")로 싣는다 — 문단(식 설명 "급부 발생률 — …", 납입면제 문장)에서 줍지 않는다
  if (!standard) for (const [li, line] of paragraphs.entries()) {
    if (continuation(paragraphs[li - 1])) continue;          // 앞 줄에서 잘린 토막
    const body = line.replace(/^\s*(?:[가-힣]\s*[).]|\(\s*\d+\s*\)|\d+\s*[).])\s*/, "");   // "가. ", "나) ", "(1) " 머리표 제거
    const m = /^[○◦\-·•]?\s*([가-힣A-Za-z0-9()\s]*?(?:률|율|지급률))\s*(?:×\s*([^:]*))?[:：]?\s*(.*)$/.exec(body);
    if (!m) continue;
    const name = m[1].trim();
    if (!looksLikeRateName(name)) continue;
    if (spec.rates.some((r) => r.name === name)) continue;
    const role = roleOf(name);
    if (role === "lapse") continue;                              // 해지율은 basis.lapse 의 일이다
    const source = m[3]?.trim();
    const ref: RateRef = { id: `r${spec.rates.length + 1}`, name, role };
    if (m[2]) ref.adjustment = `× ${m[2].trim()}`;
    if (source && /(보험개발원|제\s*\d|호|경험|참조)/.test(source)) ref.source = source.slice(0, 200);
    spec.rates.push(ref);
    evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: name, raw: line, source: `본문 ${li + 1}줄`, confidence: source ? "medium" : "low" });
  }
  // 위험률을 통째로 표로 싣는 문서("위험률 | 유형 | 근거·출처 | 표"). 이 앱이 낸 산출방법서가 이 모양이라 왕복이 이어진다
  for (const [ti, t] of doc.tables.entries()) {
    if (productTables.has(ti)) continue;
    const head = t.head.map((c) => squeeze(c).trim());
    if (!/^위험[률율]$/.test(head[0] ?? "")) continue;
    const roleCol = head.findIndex((c) => /^유형$/.test(c));
    const srcCol = head.findIndex((c) => /(근거|출처)/.test(c));
    const idCol = head.findIndex((c) => /^기호$/.test(c));
    for (const row of t.rows) {
      const name = (row[0] ?? "").replace(/\s+/g, " ").trim();
      if (!name || name.length > 80) continue;
      // 이름이 "주계약 · 암발생률" 처럼 계약 단위를 달고 있으면 유형 판정은 뒤쪽만 본다
      const bare = name.includes(" · ") ? name.slice(name.lastIndexOf(" · ") + 3) : name;
      const role = (roleCol >= 0 ? ROLE_BY_LABEL.get((row[roleCol] ?? "").trim()) : undefined) ?? roleOf(bare);
      if (role === "lapse") continue;
      const src = srcCol >= 0 ? (row[srcCol] ?? "").trim() : "";
      const sym = idCol >= 0 ? (row[idCol] ?? "").trim() : "";
      const already = spec.rates.find((r) => r.name === name);
      // 표가 가장 정확하다 — 본문에서 이름만 먼저 주운 계열도 기호·유형을 표대로 맞춘다
      if (already) {
        if (sym && sym !== "—" && !spec.rates.some((r) => r !== already && r.id === sym)) already.id = sym;
        if (roleCol >= 0) already.role = role;
        if (srcCol >= 0) already.source = src && src !== "—" ? src : undefined;
        continue;
      }
      const id = sym && sym !== "—" && !spec.rates.some((r) => r.id === sym) ? sym : `r${spec.rates.length + 1}`;
      spec.rates.push({ id, name, role, source: src && src !== "—" ? src : undefined });
      evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: name,
        raw: row.filter(Boolean).join(" | ").slice(0, 140), source: `표 ${ti + 1}`, confidence: "high" });
    }
  }

  // 표에 적힌 위험률 근거도 줍는다
  for (const [ti, t] of doc.tables.entries()) {
    if (productTables.has(ti)) continue;
    for (const row of t.rows) {
      const cell = row.find((c) => /위험률/.test(c));
      const body = row[row.length - 1];
      if (!cell || !body || body.length < 10) continue;
      for (const seg of body.split(/[-–]\s*(?=무배당|예정)/)) {
        const nm = /((?:무배당\s*)?예정\s*[가-힣\s]*?(?:률|율))/.exec(seg);
        if (!nm) continue;
        const name = nm[1].replace(/\s+/g, " ").trim();
        if (!looksLikeRateName(name.replace(/^(무배당\s*)?예정\s*(경험\s*)?/, ""))) continue;
        const src = seg.replace(/\s+/g, " ").trim().slice(0, 200);
        const already = spec.rates.find((r) => r.name === name);
        if (already) { already.source ??= src; continue; }   // 본문에서 이름만 주운 계열에 근거를 채운다
        spec.rates.push({ id: `r${spec.rates.length + 1}`, name, role: roleOf(name), source: src });
        evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: name, raw: seg.slice(0, 120), source: "표", confidence: "high" });
      }
    }
  }
  if (spec.rates.some((r) => r.role === "waiver")) add("basis.waiver", "납입면제", true, spec.rates.find((r) => r.role === "waiver")!.name, "위험률 목록", "medium");

  // 3-0) 담보 표("담보 | 단위 | 급부 유형 | …") — 이 모듈이 낸 산출방법서를 되읽을 때 조건이 온전히 돌아오게
  readBenefitTable(doc, spec, evidence, warnings);

  // 3-1) 두 단 편집된 PDF 는 "3. 예정이율에 관한 사항" 과 값이 멀리 떨어져 규칙이 못 잇는다.
  //      끝내 못 찾았을 때만 "연 N% 복리" 를 낮은 확신도로 제안한다(기본 미적용, 사람이 확인).
  if (spec.basis.interest === undefined) {
    const RE = new RegExp(`연\\s*복리\\s*${NUM}\\s*${PCT}|연\\s*${NUM}\\s*${PCT}\\s*복리`);
    const all = [...doc.paragraphs, ...doc.tables.flatMap((t) => [t.head, ...t.rows].map((r) => r.join(" ")))];
    for (const line of all) {
      const flat = squeeze(line);
      if (/(공시이율|최저보증|평균공시|적립이율|연체|표준이율)/.test(flat)) continue;
      const m = RE.exec(flat);
      if (!m) continue;
      const v = parseRate(`${m[1] ?? m[2]}%`);
      if (v === null || v <= 0 || v > 0.2) continue;
      add("basis.interest", "적용이율", v, line.slice(0, 160), "본문(추정)", "low");
      break;
    }
  }

  // 3-2) 적립형(공시이율형 저축보험) — "적립 조건 | 값" 표와 예정이율 표의 공시이율·최저보증이율 행. 식 비교(readStandard) 전에 읽는다(자동 식이 이 값으로 만들어진다)
  if (standard) readSavings(doc, spec, evidence);

  // 4) 원문 절 보존 — 모델에 자리가 없는 내용을 잃지 않게. 표준 양식은 정해진 순서대로 수식·주석·절을 읽는다
  if (standard) {
    for (const [k, path] of [["회사", "meta.insurer"], ["판", "meta.version"], ["비고", "meta.note"], ["작성일", "meta.date"]] as const) {
      const v = cover(new RegExp(`^${k}$`));
      if (v) add(path, k, v[0], `${k} ${v[0]}`, `표 ${v[1] + 1}`, "high");
    }
    // 가.(4) 의 문장이 납입면제 여부다 — 위험률 목록에 납입면제 계열이 있어도 쓰지 않을 수 있다
    const w = paragraphs.find((p) => /(납입면제 사유는|납입만 면제되어 더 준다|납입면제를 적용하나|별도의 납입면제율을 두지 않는다)/.test(p));
    if (w) {
      const i = evidence.findIndex((e) => e.path === "basis.waiver");
      if (i >= 0) evidence.splice(i, 1);
      add("basis.waiver", "납입면제", !/두지 않는다/.test(w), w.slice(0, 120), "표준 양식 가.(4)", "high");
    }
    // (식 비교 전에 읽는다 — 자동 식이 납입면제 사유에 따라 달라진다)
    // 1.4 의 "f_x : A · B" — 납입면제 사유. 유형이 납입면제가 아닌 위험률(예: 암진단 담보의 암 발생률)은 basis.waiverRateIds 로 (담보별 식의 f 줄은 "—" 가 붙어 다르다)
    const fx = paragraphs.find((p) => /^f_x\s*:/.test(p.trim()) && !p.includes("—"));
    if (fx && spec.basis.waiver) {
      const ids = fx.trim().replace(/^f_x\s*:\s*/, "").split(/\s*·\s*/)
        .map((nm) => spec.rates.find((r) => r.name === nm.trim())).filter((r): r is RateRef => !!r && r.role !== "waiver").map((r) => r.id);
      spec.basis.waiverRateIds = ids.length ? ids : undefined;
      add("basis.waiverRateIds", "납입면제 사유", ids.join(", ") || "없음", fx.slice(0, 120), "표준 양식 가.(4)", "high", false);
    }
    if (!readV8(doc, spec, evidence, warnings, paragraphs)) readSurvivorTables(doc, spec, evidence, warnings);
    // 담보의 탈퇴 위험률·납입면제를 생존자에 맞춘 뒤에 식을 견준다(자동 식이 그 칸으로 만들어진다)
    if (spec.survivors?.length) { const synced = syncFromSurvivors(spec); spec.benefits = synced.benefits; spec.basis = synced.basis; }
    // v6 은 담보 표가 식 사이(보험금의 현가 바로 위)에 있다 — 글로 뽑힌 표의 행이 앞 식의 줄로 이어지지 않게 지운다(표는 앞에서 읽었다)
    const tableRows = new Set(doc.tables.flatMap((t) => [t.head, ...t.rows].map((r) => squeeze(r.filter(Boolean).join(" ")))));
    readStandard(paragraphs.map((p) => (tableRows.has(squeeze(p)) ? "" : p)), spec, evidence, format!);
  } else spec.sections = outlineSections(doc);

  const missing = ["meta.productName", "basis.interest"]
    .filter((p) => !evidence.some((e) => e.path === p))
    .map((p) => FIELD_RULES.find((r) => r.path === p)?.label ?? p);
  if (!spec.expenses.length) missing.push("사업비");
  if (!spec.rates.length) missing.push("위험률");

  // 생존자가 담보의 탈퇴 위험률·납입면제에서 그대로 만들어지는 것이면 적지 않는다 — 옛 조건과 같은 모양으로 남게
  const out = compactCombos(compactSurvivors(spec));
  return { spec: out, evidence, missing, warnings: [...new Set([...warnings, ...validateSpec(out)])], ...(standard ? { format } : {}) };
}

/**
 * 표준 산출방법서 v8 — 유지자 표 · 보험금 표 · 보장 표. 표는 식 위주라 기호(q · r^{(i)} · Q^{(k)} · l^{(k)})로 위험률·유지자를 되짚는다.
 *  - 유지자 표: "대상 위험률 | Q^{(k)} = … 또는 q_{x+t}" · "계산기수 | l^{(k)}_{x+t+1} = …" · "현가누계 | D′ …(납입이면 D′)". 이름은 앞 문단 "(k) l^{(k)}_x — 이름"
 *  - 보험금 표: "대상자수 | l^{(k)}_{x+t}" · "계산기수 | d^{(k)} = l^{(k)} × 발생률" · "현가 및 누계"(옛 판 "계산기수") — 발생률의 기호로 급부 유형·급부 위험률을 정한다
 *  - 위험률 합성 표(나. 기호의 정의 아래): "기호 | 이름 | 식" — Q^{(j)} · R^{(j)} 를 위험률로 펼친다. 옛 판은 유지자 표의 대상 위험률에 합성 식이 그대로 있다
 *  - 보장 표: "구분 | (계약 단위) | (보험기간) | 보장금액 배수 | 면책 | 삭감기간 | 삭감 시 지급률" — 보험금 표와 같은 차례
 * v8 표가 없으면 false (옛 판은 readSurvivorTables · readBenefitTable 이 읽는다)
 */
function readV8(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[], warnings: string[], paragraphs: string[]): boolean {
  const key = (c: string) => squeeze(c).replace(/\s/g, "");
  type Seg = [string, string][];
  const cells = (t: Seg, k: string) => t.filter(([x]) => x === k).map(([, v]) => v);
  // 표 경계가 아니라 행의 흐름으로 나눈다 — PDF 는 문단만 사이에 둔 표들을 한 표로 이어 읽는다.
  // 유지자 = (계약 단위) · (질병 발생률) · 대상 위험률 · 계산기수 · 현가누계 / 보험금 = (계약 단위) · 대상자수 · 계산기수 · 계산기수
  const ROW_KEYS = ["계약단위", "질병발생률", "대상위험률", "계산기수", "현가누계", "대상자수", "현가및누계"];
  const keepTabs: Seg[] = [], benTabs: Seg[] = [];
  let seg: Seg = [];
  for (const r of doc.tables.flatMap((t) => [t.head, ...t.rows])) {
    const k = key(r[0] ?? ""), v = (r[1] ?? "").trim();
    if (k === "구분" && key(v) === "식") continue;                      // 표 머리
    if (r.length !== 2 || !ROW_KEYS.includes(k)) { seg = []; continue; }
    seg.push([k, v]);
    if (k === "현가누계") { keepTabs.push(seg); seg = []; }
    else if (seg.some(([x]) => x === "대상자수") && (k === "현가및누계" || (k === "계산기수" && seg.filter(([x]) => x === "계산기수").length === 2))) { benTabs.push(seg); seg = []; }
  }
  // 보장 표 — 주계약 · 특약의 부마다 하나씩 있다(특약을 따로 싣는 판). 보험금 표와 같은 차례로 잇는다
  const coverTabs = doc.tables.filter((t) => key(t.head[0] ?? "") === "구분" && t.head.some((h) => key(h) === "보장금액배수"));
  if (!keepTabs.length && !benTabs.length) return false;
  // 기호 → 위험률 — 지금 기호(M04 표의 기호 = 위험률 id) 먼저, 없으면 옛 판 기호(사망 q · 그 밖 r^{(i)} — 위험률 표의 차례)
  const symMap = (m: Map<string, string>) => new Map([...m].map(([id, sym]) => [sym.replace(/[{}\s]/g, ""), id]));
  const bySym = symMap(rateSymbols(spec)), byOld = symMap(legacyRateSymbols(spec));
  /** 식 칸의 기호들 — 첨자 순서·중괄호·빈칸을 고르게 한 뒤 "rc_x+t" · "r_x+t^(1)" 꼴로 찾는다 */
  const symsIn = (text: string) => [...normFormula(text).matchAll(/(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)_x\+t(?:\^\((\d+)\))?/g)].map((m) => ({ letter: m[1], n: m[2] }));
  // 첨자 없는 옛 q · r 은 그 글자의 첫 위험률 — 문서에 위험률을 더하면 기호가 r → r^{(1)} · r^{(2)} 로 바뀌는데, 앞서 적힌 칸은 r 그대로다
  const rateOfSym = (x: { letter: string; n?: string }) => {
    if (x.letter === "Q" || x.letter === "R") return undefined;
    const k = x.n ? `${x.letter}^(${x.n})` : x.letter;
    return bySym.get(k) ?? byOld.get(k) ?? (x.n ? undefined : byOld.get(`${x.letter}^(1)`));
  };
  /** 위험률 기호로 보이는데 위험률을 못 찾은 것 — 식의 계열(l · d · D · N · C …)은 아니다 */
  const STRUCT = /^(l|d|D|N|C|M|S|V|W|F|H|E|P|G|v)$/;
  // 위험률 합성 — "Q^(j)" → 위험률 id 들(안의 R 은 펼친다)과 이름
  const combos = new Map<string, { j: number; ids: string[]; name?: string }>();
  const symKey = (x: { letter: string; n?: string }) => `${x.letter}^(${x.n ?? ""})`;
  const idsOf = (text: string) => {
    const out: string[] = [];
    for (const x of symsIn(text)) for (const id of x.letter === "Q" || x.letter === "R" ? combos.get(symKey(x))?.ids ?? [] : [rateOfSym(x)].filter((y): y is string => !!y)) if (!out.includes(id)) out.push(id);
    return spec.rates.map((r) => r.id).filter((id) => out.includes(id));
  };
  for (const t of doc.tables.filter((x) => x.head.map(key).join("|") === "기호|이름|식")) for (const r of t.rows) {
    const [lhs, rhs] = (r[2] ?? "").split("=");
    const sym = lhs ? symsIn(lhs).find((x) => (x.letter === "Q" || x.letter === "R") && x.n) : undefined;
    if (!sym || !rhs) continue;
    combos.set(symKey(sym), { j: Number(sym.n), ids: idsOf(rhs), name: (r[1] ?? "").trim() || undefined });
  }
  const kOf = (text: string, re: RegExp) => { const m = re.exec(normFormula(text)); return m ? Number(m[1]) : undefined; };
  // 유지자 이름 — 앞 문단 "(k) l^{(k)}_x — 이름" (첨자 순서는 Word 마다 다르다)
  const names = new Map<number, string>();
  for (const p of paragraphs) {
    const m = /^\(\d+\)\s*l(?:\^\{?\((\d+)\)\}?_\{?x\}?|_\{?x\}?\^\{?\((\d+)\)\}?)\s*[—–-]+\s*(.+)$/.exec(p.trim());
    if (m) names.set(Number(m[1] ?? m[2]), m[3].trim());
  }
  const units = new Set<string>();
  const survivors: (SurvivorSpec & { payAll?: boolean })[] = [];
  keepTabs.forEach((t, i) => {
    const k = kOf(cells(t, "계산기수").join(" "), /l_x\+t\+1\^\((\d+)\)/) ?? i + 1;
    if (survivors.some((x) => x.id === `s${k}`)) return;          // 독립특약 부에 다시 실은 같은 유지자 — 한 번만
    const rateText = [...cells(t, "질병발생률"), ...cells(t, "대상위험률")].join(" ");
    const exits = /^없음$/.test(cells(t, "대상위험률")[0] ?? "") ? [] : idsOf(rateText);   // 위험률 표의 차례로 — 합성 기호는 그 위험률들로
    const lost = symsIn(rateText).filter((x) => x.letter !== "Q" && x.letter !== "R" && !STRUCT.test(x.letter) && !rateOfSym(x));
    if (lost.length) warnings.push(`유지자 lx(${k}) 의 기호 ${[...new Set(lost.map((x) => (x.n ? `${x.letter}^{(${x.n})}` : x.letter)))].join(" · ")} 에 맞는 위험률이 가.(2) 예정위험률 표에 없습니다 — 위험률 행을 지웠다면 유지자 표의 대상 위험률도 고치세요`);
    const pv = cells(t, "현가누계").join(" "), pay = /D[′'’]/.test(pv);
    const payList = /납입\s*:\s*(.+)$/.exec(pv)?.[1].split(/\s*·\s*/).map((x) => x.trim()).filter(Boolean);
    const unit = cells(t, "계약단위")[0];
    const name = names.get(k);
    // 기호는 위험률 표의 차례로 되짚는다 — 행을 지우거나 순서를 바꾸면 다른 위험률을 가리킬 수 있어, 이름(탈퇴 사유)과 견준다
    const flat = (x: string) => x.replace(/[^가-힣A-Za-z0-9]/g, "");
    if (name && isAutoKeepLabel(name) && / 아닌 유지자$/.test(name) && flat(name) !== flat(keepLabel(exits.map((id) => spec.rates.find((r) => r.id === id)!))))
      warnings.push(`유지자 lx(${k}) 의 이름(${name})과 대상 위험률의 기호가 가리키는 위험률(${exits.map((id) => spec.rates.find((r) => r.id === id)!.name).join(" · ") || "없음"})이 맞지 않습니다 — 위험률 표의 행을 지우거나 순서를 바꿨다면 유지자 표의 기호도 고치세요`);
    survivors.push({ id: `s${k}`, ...(name && !isAutoKeepLabel(name) ? { name } : {}), ...(unit ? { unit } : {}), exitRateIds: exits,
      ...(payList ? { payFor: payList } : {}), ...(pay && !payList ? { payAll: true } : {}) });
    evidence.push({ path: `survivors[${survivors.length - 1}]`, label: "유지자", value: `lx(${k})`, raw: t.map((r) => r.join(" ")).join(" | ").slice(0, 160), source: "유지자 표", confidence: "high" });
  });
  // 보장 표 — 보험금 표와 같은 차례(표마다 열이 다를 수 있다 — 특약 부에는 계약 단위 열)
  const coverRows = coverTabs.flatMap((t) => t.rows.filter((r) => (r[0] ?? "").trim()).map((r) => ({ r, h: t.head.map(key) })));
  const days = (s: string) => { const d = /(\d+)\s*일/.exec(s), y = /(\d+)\s*년/.exec(s); return d ? Number(d[1]) : y ? Number(y[1]) * 365 : undefined; };
  const n = Math.max(benTabs.length, coverRows.length);
  for (let i = 0; i < n; i++) {
    const t = benTabs[i], cr = coverRows[i], row = cr?.r;
    const get = (k: string) => { const c = cr ? cr.h.findIndex((h) => h.startsWith(k)) : -1; return row && c >= 0 ? (row[c] ?? "").trim() : ""; };
    const name = (row?.[0] ?? "").trim() || `보험금 ${i + 1}`;
    const unit = get("계약단위") || (t ? cells(t, "계약단위")[0] : "") || "";
    const k = t ? kOf(cells(t, "대상자수").join(" "), /l_x\+t\^\((\d+)\)/) : undefined;
    const sv = survivors.find((x) => x.id === `s${k}`);
    const dText = t ? cells(t, "계산기수").find((c) => /^d/.test(c.trim())) ?? "" : "";
    const evText = dText.split(/[×·]/).slice(1).join(" ").trim();
    const ev = symsIn(evText);
    // 기호 대신 위험률 이름을 적었으면 그 위험률 — 위험률 표에 없으면 더하고 알린다(유형은 이름으로 어림)
    let named: RateRef | undefined;
    if (!ev.length && evText && !/[=_^]/.test(evText)) {
      named = spec.rates.find((r) => r.name === evText);
      if (!named) {
        named = { id: `r${spec.rates.length + 1}`, name: evText, role: roleOf(evText) === "lapse" ? "other" : roleOf(evText) };
        spec.rates.push(named);
        evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: evText, raw: dText.slice(0, 120), source: "보험금 표", confidence: "medium" });
        warnings.push(`보험금 "${name}" 의 위험률 "${evText}" 이(가) 1.2. 위험률 표에 없어 "${RATE_ROLE_LABEL[named.role]}" 유형으로 더했습니다 — 유형·근거를 확인하세요`);
      }
    }
    const evRate = named?.id ?? ev.map(rateOfSym).find(Boolean), rate = spec.rates.find((r) => r.id === evRate);
    // 합성 기호 — 유지자의 대상 위험률(사망형) · 그 질병들(진단형)과 같으면 따로 적지 않고, 다르면 급부 위험률로 그 합성을 고른다
    const cx = ev.find((x) => combos.has(symKey(x)));
    const cids = cx ? combos.get(symKey(cx))!.ids : [];
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    const svIlls = (sv?.exitRateIds ?? []).filter((id) => spec.rates.find((r) => r.id === id)?.role !== "death");
    const pickCombo = cx && !(sv && (same(cids, sv.exitRateIds) || (cx.letter === "R" && same(cids, svIlls)))) ? `c${combos.get(symKey(cx))!.j}` : undefined;
    const combined = ev.some((x) => x.letter === "Q"), ill = ev.some((x) => x.letter === "R");
    const role: BenefitSpec["role"] = combined ? "death" : ill ? "incidence" : rate?.role === "death" ? "death" : rate?.role === "recurring" ? "recurring" : "incidence";
    const bs: BenefitSpec = { id: `b${spec.benefits.length + 1}`, name, role, ...(unit && unit !== "주계약" ? { unit } : {}),
      ...(sv ? { survivorId: sv.id, ...(sv.exitRateIds.length ? { exitRateIds: [...sv.exitRateIds] } : {}) } : {}) };
    const mult = get("보장금액배수");
    if (/원/.test(mult)) { const a = numIn(mult); if (a !== null) bs.amount = a; }
    else if (mult && mult !== "—") { const v = Number(mult.replace(/배$/, "")); if (Number.isFinite(v)) bs.multiple = v; }
    const end = /(\d+)\s*세/.exec(get("보험기간"));
    if (end) bs.endAge = Number(end[1]);
    const ratio = /([\d.]+)\s*%/.exec(get("삭감시"));
    Object.assign(bs, Object.fromEntries(Object.entries(coverFields({ wait: days(get("면책")), reduce: days(get("삭감기간")), ratio: ratio ? Number(ratio[1]) / 100 : undefined })).filter(([, v]) => v !== undefined)));
    // 급부 위험률 — 유지자의 탈퇴 사유에서 정해지는 것과 다를 때만 따로 적는다(일당형 · 암수술 등)
    if (pickCombo) bs.rateId = pickCombo;
    if (rate && !combined && !ill) {
      const auto = role === "death" ? (sv?.exitRateIds.length === 1 ? sv.exitRateIds[0] : undefined) : eventRate(spec, { ...bs, rateId: undefined })?.id;
      if (rate.id !== auto) bs.rateId = rate.id;
    }
    if (!t) warnings.push(`보장 "${name}" 의 보험금 표(대상자수 · 계산기수)가 없어 대상자수를 정하지 못했습니다 — 보험금 카드에서 고르세요`);
    spec.benefits.push(bs);
    units.add(unit || "주계약");
    evidence.push({ path: `benefits[${spec.benefits.length - 1}]`, label: "보험금", value: name, raw: [...(row ? [row.join(" | ")] : []), ...(t ? t.map((r) => r.join(" ")) : [])].join(" | ").slice(0, 160), source: "보험금·보장 표", confidence: "high" });
  }
  // 보험기간을 적지 않은 보장은 가입 조건의 그 계약 단위 보험기간(하나일 때)
  for (const b of spec.benefits) if (b.endAge === undefined) {
    const ages = [...new Set((spec.product?.terms ?? []).filter((r) => (r.label?.trim() && !/^주계약/.test(r.label.trim()) ? r.label.trim() : "주계약") === (b.unit ?? "주계약"))
      .map((r) => /(\d+)\s*세/.exec(r.term ?? "")?.[1]).filter(Boolean).map(Number))];
    if (ages.length === 1) b.endAge = ages[0];
  }
  // 합성마다 하나 — 안의 질병 곱 R^{(j)} 행 뒤에 오는 대표 기호 행이 그 합성이다
  const byJ = new Map([...combos.values()].map((c) => [c.j, c]));
  if (byJ.size) spec.combos = [...byJ.values()].sort((a, b) => a.j - b.j).map((c) => {
    const name = c.name && c.name !== comboLabel(c.ids.map((id) => spec.rates.find((r) => r.id === id)!)) ? c.name : undefined;
    return { id: `c${c.j}`, ...(name ? { name } : {}), rateIds: c.ids };
  });
  spec.combos?.forEach((c, i) => evidence.push({ path: `combos[${i}]`, label: "위험률 합성", value: c.name ?? c.id, raw: c.rateIds.join(" · "), source: "위험률 합성 표", confidence: "high" }));
  spec.survivors = survivors.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))).map(({ payAll, ...x }) => (payAll ? { ...x, payFor: [...units] } : x));
  return true;
}

/**
 * 생존자 표(표준 산출방법서 v7) — "생존자 | lx(k) — 이름" 다음 행마다 계약 단위 · 탈퇴 위험률 · 납입(N*).
 * 이름이 탈퇴 사유에서 만든 이름("생존자(사망X, 암X)")과 같으면 적지 않는다.
 */
function readSurvivorTables(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[], warnings: string[]) {
  const key = (c: string) => squeeze(c).replace(/\s/g, "");
  const out: SurvivorSpec[] = [];
  // 생존자 표에만 적은 위험률 — 위험률 표에 없어도 계열로 더한다(담보 표와 같다). 사람이 유형·근거를 채운다
  const rateByName = (name: string, who: string) => {
    const s = name.trim();
    const hit = spec.rates.find((r) => r.name === s) ?? spec.rates.find((r) => s && (r.name.endsWith(` · ${s}`) || s.endsWith(r.name)));
    if (hit || !s || s === "—") return hit;
    const ref: RateRef = { id: `r${spec.rates.length + 1}`, name: s, role: roleOf(s) === "lapse" ? "other" : roleOf(s) };
    spec.rates.push(ref);
    evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: s, raw: `생존자 ${who}`, source: "생존자 표", confidence: "medium" });
    warnings.push(`생존자 ${who} 의 위험률 "${s}" 이(가) 1.2. 위험률 표에 없어 "${RATE_ROLE_LABEL[ref.role]}" 유형으로 더했습니다 — 유형·근거를 확인하세요`);
    return ref;
  };
  doc.tables.forEach((t, ti) => {
    if (t.head.length !== 2 || key(t.head[0]) !== "생존자") return;
    const hm = /lx\((\d+)\)\s*[—-]?\s*(.*)$/.exec(t.head[1].trim());
    if (!hm) return;
    const get = (k: string) => (t.rows.find((r) => key(r[0] ?? "") === k)?.[1] ?? "").trim();
    const names = get("탈퇴위험률");
    const exits = names && names !== "없음" ? names.split(/\s+및\s+|\s*\+\s*|,\s*/).map((nm) => rateByName(nm, `lx(${hm[1]})`)?.id).filter((x): x is string => !!x) : [];
    const pay = get("납입(N*)").replace(/^—$/, "");
    const unit = get("계약단위");
    const rates = exits.map((id) => spec.rates.find((r) => r.id === id)!);
    // 자동 이름(생존자(사망X, …))은 이름이 아니다 — 탈퇴 위험률 행을 고치면 머리의 옛 자동 이름이 남으므로 모양으로 가린다
    const name = hm[2].trim() && hm[2].trim() !== crowdLabel("생존자", rates) && !/^생존자\(.*\)$/.test(hm[2].trim()) ? hm[2].trim() : undefined;
    out.push({ id: `s${hm[1]}`, ...(name ? { name } : {}), ...(unit ? { unit } : {}), exitRateIds: exits,
      ...(pay ? { payFor: pay.split(/\s*·\s*/).filter(Boolean) } : {}) });
    evidence.push({ path: `survivors[${out.length - 1}]`, label: "생존자", value: `lx(${hm[1]})`, raw: [t.head, ...t.rows].map((r) => r.join(" ")).join(" | ").slice(0, 160), source: `표 ${ti + 1}`, confidence: "high" });
  });
  if (out.length) spec.survivors = out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

type Add = (path: string, label: string, value: string | number | boolean, raw: string, source: string, confidence: Confidence, setValue?: boolean) => void;

const numIn = (s: string) => { const m = /(-?[\d,]+(?:\.\d+)?)/.exec(s); return m ? n(m[1]) : null; };

/** 식 비교용 — 빈칸·중괄호·표기 차이(LaTeX 를 거쳐 온 ′ − ₅ 등)를 지운다 */
const SCRIPT_ARG = String.raw`(\{[^{}]*\}|[^\s_^{}(),]+)`;   // 쉼표는 첨자가 아니다 — "W^{표준}_t, W^{표준}_t" 의 첫 첨자가 "t," 로 붙지 않게
export const normFormula = (s: string) => s
  .replace(new RegExp(String.raw`\^${SCRIPT_ARG}_${SCRIPT_ARG}`, "g"), "_$2^$1")
  .replace(/[₀-₉]/g, (c) => `_${c.charCodeAt(0) - 0x2080}`).replace(/[\s{}]/g, "")
  .replace(/'/g, "′").replace(/-/g, "−").replace(/∗/g, "*").replace(/≦/g, "≤").replace(/≧/g, "≥");

/**
 * 표준 산출방법서(STANDARD_FORMAT)의 문단을 순서대로 읽는다. 표는 앞에서 이미 읽었다.
 *  - "N. 제목"            절. 기초율·계약 단위 절은 표로 읽었으므로 넘기고, 모르는 절은 원문 절(sections)로 둔다
 *  - "[식] 제목" + 식 줄  그 절의 수식. "※ …" 가 설명이다. 자동으로 만든 식과 같으면 싣지 않는다(고친 식·새 식만)
 *  - 책임준비금·해지환급금 관련 사항 절의 글  reserve.notes · surrender.notes (해약공제 기간 포함)
 *  - "※ 담보: 연령 구간 배수 40~59세 1배 · …" / "생존급부 …"  담보의 steps · points
 */
function readStandard(paragraphs: string[], spec: MethodSpec, evidence: Evidence[], format: string) {
  type Kind = "known" | "reserve" | "surrender" | "other";
  type Read = FormulaSpec & { lines: string[] };
  const TOP = /^\d+\.\s*(\S.*)$/;
  /** 절 안의 소제목 — "가. 예정기초율" (v4). 여기부터 나오는 식은 이 이름의 절로 둔다 */
  const SUB = /^[가-하]\.\s*(\S.*)$/;
  const read: Read[] = [];
  const extras: ExtraSection[] = [], reserve: string[] = [], surrender: string[] = [];
  let kind: Kind = "known", title = "", extra: ExtraSection | null = null;
  let cur: Read | null = null;
  /** 특약 부 안인지 — 그 부의 글은 주계약 부와 같은 것을 가리키므로 관련 사항·원문 절로 넣지 않는다 */
  let rider = false;
  const autoLabels = new Set(generateFormulas(spec).map((f) => f.label));
  const flush = () => { if (cur?.lines.length) read.push(cur); cur = null; };
  for (const raw of paragraphs) {
    const t0 = raw.trim();
    if (!t0 || /^```/.test(t0)) continue;
    const riderHead = /^\[([^\]]+)\]\s*(\d+\.\s*\S.*)$/.exec(t0);
    const t = riderHead ? riderHead[2] : t0;
    const top = !/^\d+\.\d/.test(t) && t.length < 60 ? TOP.exec(t) : null;
    if (top) {
      flush();
      rider = !!riderHead;
      title = top[1].trim();
      kind = /^(기초율에 관한 사항|계약 단위와 급부|기호의 정의|보험료의 계산에 관한 사항)$|^별첨/.test(title) ? "known"
        : /^(책임준비금|계약자적립액).*사항$/.test(title) ? "reserve" : /^(해지환급금|해약환급금).*사항$/.test(title) ? "surrender" : "other";
      extra = kind === "other" ? { title, paragraphs: [] } : null;
      if (extra) extras.push(extra);
      continue;
    }
    // 1장 안의 소제목이면 식의 절 이름만 바꾼다(장의 갈래 kind 는 그대로)
    const sub = kind === "known" && t.length < 60 ? SUB.exec(t) : null;
    if (sub) { flush(); title = sub[1].trim(); continue; }
    if (t.startsWith(FORMULA_MARK)) {
      flush();
      if (extra) { extras.splice(extras.indexOf(extra), 1); extra = null; }   // 식이 있는 절은 수식 절이다
      cur = { section: title || "기타", label: t.slice(FORMULA_MARK.length).trim(), text: "", lines: [] };
      continue;
    }
    const note = t.startsWith(NOTE_MARK) ? t.slice(NOTE_MARK.length).trim() : null;
    // 담보의 연령 구간·생존급부 — v6 은 담보 표가 식들 사이에 있다. 앞 식의 ※ 덧붙임으로 빨려 들지 않게 먼저 본다
    const stepNote = note !== null ? /^(.+?):\s*(연령 구간 배수|생존급부)\s+(.+)$/.exec(note) : null;
    const stepBen = stepNote ? spec.benefits.find((x) => x.name === stepNote[1].trim()) : undefined;
    if (stepNote && stepBen) {
      flush();
      if (stepNote[2] === "연령 구간 배수") stepBen.steps = [...stepNote[3].matchAll(/(\d+)\s*~\s*(\d+)\s*세\s*([\d.]+)\s*배/g)].map((x) => ({ fromAge: +x[1], toAge: +x[2], multiple: +x[3] }));
      else stepBen.points = [...stepNote[3].matchAll(/(\d+)\s*세\s*([\d.]+)\s*배/g)].map((x) => ({ age: +x[1], multiple: +x[2] }));
      continue;
    }
    // v8: 유지자·보험금 항목 머리 "(1) 사망" · "(2) l^{(2)}_x — …" — 앞 식의 줄로 잇지 않는다
    if (/^\(\d+\)\s/.test(t)) { flush(); continue; }
    if (cur) {
      if (note !== null) { cur.note = cur.note ? `${cur.note} ${note}` : note; continue; }
      // Word 는 긴 식을 여러 줄로 나눈다(wrapEquation) — 연산자로 시작하는 줄은 앞줄의 이어짐이다
      if (!cur.note && cur.lines.length && /^[+−\-×·/]\s/.test(t)) { cur.lines[cur.lines.length - 1] += ` ${t}`; continue; }
      // "[식]" 표시를 지운 자동 식 제목("순보험료 (P)") — 앞 식에 붙이지 않고 새 식으로 연다
      if (!t.includes("=") && autoLabels.has(t)) { flush(); cur = { section: title || "기타", label: t, text: "", lines: [] }; continue; }
      if (!cur.note) { cur.lines.push(t); continue; }
      flush();                                   // 설명 다음 글은 식이 아니다
    }
    const body = note ?? t;
    if (rider) continue;
    if (kind === "reserve") reserve.push(body);
    else if (kind === "surrender") {
      const dy = /해약공제는\s*납입기간과\s*(\d+)\s*년\s*중/.exec(body);
      if (dy) spec.surrender.deductionYears = Number(dy[1]);
      else surrender.push(body);
    } else if (extra) extra.paragraphs.push(t);
  }
  flush();
  // v6: 해약공제 기간은 해약공제 식의 min(m, N) 이 정한다(따로 적던 ※ 문장이 없다) — 식 비교 전에 읽어 자동 식과 맞춘다
  const dyF = read.find((f) => f.label === "해약공제")?.lines.map((l) => /min\(\s*m\s*,\s*(\d+)\s*\)/.exec(l)).find(Boolean);
  if (dyF && spec.surrender.deductionYears === undefined) spec.surrender.deductionYears = Number(dyF[1]);
  spec.reserve.notes = reserve;
  spec.surrender.notes = surrender;
  spec.sections = extras.filter((s) => s.paragraphs.length);
  // 자동으로 만든 식(조건에서 늘 다시 만든다)과 같은 것은 빼고, 고친 식·새 식만 조건의 식으로 둔다
  const auto = generateFormulas(spec);
  const same = (a?: string, b?: string) => normFormula(a ?? "") === normFormula(b ?? "");
  //  v5 → v6: 식 줄은 같고 설명 줄·※ 덧붙임만 줄었다 — v5 문서는 "=" 가 든 식 줄만 견준다(설명만 다른 것은 고친 식이 아니다)
  const v5 = /v5\s*$/.test(format);
  const eqs = (x?: string) => (x ?? "").split("\n").filter((l) => l.includes("=")).join("\n");
  // 옛 판의 자동 식은 지금 판에서 나뉘거나 이름이 바뀌었다 — 그 제목은 건너뛰고(사람이 고친 것인지 알 수 없다), 사람이 더한 식만 둔다
  //  v1 → v2: 계산기수가 나뉘고 기호가 바뀌었다(mm → k, 발생률 k → r)
  //  v2 → v3: 계산기수가 "보험료의 현가"·"보험금의 현가" 로 나뉘고, 유지자수·납입자수는 담보가 아니라 집단마다 적는다
  const v1 = /v1\s*$/.test(format), v2 = /v2\s*$/.test(format), v3 = /v3\s*$/.test(format), v4 = /v4\s*$/.test(format);
  const V1_AUTO = /^(유지자수·납입자수 — |(계산기수|급부 현가와 납입기수|순보험료·기준연납순보험료|영업보험료|저해지·무해지환급형|연말 책임준비금|해약공제와 해지환급금|환급률)$)/;
  const V2_AUTO = /^(유지자수·납입자수 — |(유지자수의 현가 \(D\)|납입자수의 현가 \(D′\)|급부 발생자의 현가 \(C\)|유지자수 현가의 누계 \(N\)|납입자수 현가의 누계 \(N′\)|급부 현가 \(PVB\))$)/;
  //  v4 → v5: 집단 식이 유지자수·납입자수 둘로 나뉘고, 현가·준비금·환급금 식의 글과 설명이 모두 바뀌었다 — 옛 자동 식 제목은 전부 건너뛴다
  const V4_AUTO = /^(유지자수·납입자수 — |보험금의 현가 — |(유지자수·납입자수의 현가 \(D · D′\)|해지자의 현가 \(W\)|현가의 누계 \(N · N′\)|연납 환산 납입기수 \(N\*\)|순보험료 \(P\)|기준연납순보험료|영업보험료|저해지·무해지환급형|준비금 산출용 순보험료|연말 책임준비금|해약공제|해약공제 기준 신계약비|표준형 해지환급금|저해지·무해지환급형 해지환급금|환급률|납입누계)$)/;
  //  v6 → v7: 유지자수·납입자수가 "생존자수 lx(k)" 로 합쳐지고 보험금의 현가가 "보험금 — " 이 되었다. 현가 식(D · N · D′ · N′)은 생존자 식 안으로
  const oldLayout = /v[1-6]\s*$/.test(format);
  //  v7 → v8: 생존자 → 유지자(식은 표가 대신한다), 보험료 절의 ※ 덧붙임을 줄였다 — v7 의 생존자 식은 건너뛰고 식 줄만 견준다
  const v7 = /v7\s*$/.test(format);
  const OLD_AUTO = /^(유지자수 — |납입자수 — |보험금의 현가 — |(납입자수의 현가와 누계 \(D′ · N′\)|유지자수의 현가와 누계 \(D · N\)|연납 환산 납입기수 \(N\*\)|해지자의 현가 \([HW]\)))/;
  spec.formulas = read.filter((f) => {
    if (v1 && V1_AUTO.test(f.label)) return false;
    if (v2 && V2_AUTO.test(f.label)) return false;
    if (v4 && V4_AUTO.test(f.label)) return false;
    if (oldLayout && OLD_AUTO.test(f.label)) return false;
    if (v7 && /^생존자수 lx\(\d+\) — /.test(f.label)) return false;
    // 집단 식 제목이 "유지자(…X)" · "납입자(…X)" 로 바뀌기 전(2026-10-02)의 자동 식 — 지금 자동 식에 같은 제목이 없으면 옛 자동 식이다
    if (/^(유지자수|납입자수) — /.test(f.label) && !/(유지자|납입자)\(/.test(f.label) && !auto.some((a) => a.label === f.label)) return false;
    // v3 → v4 는 절 이름만 바뀌었다(제목은 그대로) — 절 이름을 지금 것으로 옮겨 자동 식과 맞춘다
    if (v3) { const a0 = auto.find((x) => x.label === f.label); if (a0) f.section = a0.section; }
    const a = auto.find((x) => x.section === f.section && x.label === f.label);
    if (v5 || v7) return !a || !same(eqs(a.text), eqs(f.lines.join("\n")));
    return !a || !same(a.text, f.lines.join("\n")) || !same(a.note, f.note);
  }).map(({ lines, ...f }) => ({ ...f, text: lines.join("\n") }));
  const push = (path: string, label: string, value: string) =>
    evidence.push({ path, label, value, raw: value, source: "표준 양식", confidence: "high" });
  push("formulas", "수식", `읽은 식 ${read.length}개 · 조건에 둘 식 ${spec.formulas.length}개`);
  push("reserve", "책임준비금 관련 사항", `${reserve.length}줄`);
  push("surrender", "해지환급금 관련 사항", `${surrender.length}줄${spec.surrender.deductionYears ? ` · 해약공제 ${spec.surrender.deductionYears}년` : ""}`);
  push("sections", "원문 절", `${spec.sections.length}개`);
}

/**
 * 적립형 — 이 앱이 낸 적립형 산출방법서의 "적립 조건 | 값" 표(사망보험금 배수 · 만기 최저보증 · α 기간 · 해약공제)와
 * 예정이율 표의 "공시이율 (예시 …)" · "최저보증이율 — 경과 …" 행. 적립 조건 표가 없으면 적립형이 아니다.
 * 최저보증이율 행은 본문 규칙이 basis.minGuaranteed 로도 줍는다 — 적립형은 구간별로 savings 에 두므로 그것은 지운다.
 */
function readSavings(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[]) {
  const rows = doc.tables.flatMap((t) => [t.head, ...t.rows]).map((r) => r.map((c) => squeeze(c).replace(/\s+/g, " ").trim()));
  if (!doc.tables.some((t) => squeeze(t.head[0] ?? "").replace(/\s/g, "") === "적립조건")) return;
  const val = (re: RegExp) => { const r = rows.find((x) => re.test(x[0] ?? "")); return r?.[1]; };
  const rate = (re: RegExp, d: number) => { const v = val(re); const x = v !== undefined ? parseRate(v) : null; return x ?? d; };
  const years = (re: RegExp, d: number) => { const m = /(\d+)\s*년/.exec(val(re) ?? ""); return m ? Number(m[1]) : d; };
  const guarantee = rows.filter((x) => /^최저\s*보증\s*이율\s*—\s*경과/.test(x[0] ?? "")).map((x) => {
    const m = /경과\s*(\d+)\s*년\s*(이상|미만)/.exec(x[0]);
    return { from: m && m[2] === "이상" ? Number(m[1]) : 0, rate: parseRate(x[1] ?? "") ?? 0 };
  });
  spec.savings = {
    credited: rate(/^공시\s*이율/, 0), guarantee,
    deathMultiple: rate(/^사망보험금/, 0), maturityFloor: rate(/^만기환급금\s*최저보증/, 1),
    alphaYears: years(/^계약체결비용.*기간/, 7), deductRatio: rate(/^해약공제\s*—/, 0), deductYears: years(/^해약공제\s*기간/, 7),
  };
  evidence.push({ path: "savings", label: "적립 조건", value: `공시이율 ${spec.savings.credited} · 최저보증 ${guarantee.length}구간`, raw: "적립 조건 표", source: "표준 양식", confidence: "high" });
  delete spec.basis.minGuaranteed;
  const i = evidence.findIndex((e) => e.path === "basis.minGuaranteed");
  if (i >= 0) evidence.splice(i, 1);
}

/**
 * 가입 조건 표 두 가지를 읽어 spec.product 로 둔다. 읽은 표의 번호를 돌려준다(본문 규칙에서 뺄 것).
 *  - "가입 조건 | 내용": 보험의 종류 · 보험종목 · 보험료 납입주기 · 보험가입금액 한도 · 갱신
 *  - "(구분 |) 보험기간 | 보험료 납입기간 | 가입나이 (| 납입주기)": 사업방법서의 판매 범위 표.
 *    병합 칸이 비어 오면 위 행 값을 이어 쓴다(보험기간·구분·가입나이).
 */
function readProduct(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[]): Set<number> {
  const used = new Set<number>();
  const p: ProductInfo = {};
  const list = (v: string, sep: RegExp) => v.split(sep).map((x) => x.trim()).filter(Boolean);
  let first = -1;
  doc.tables.forEach((t, ti) => {
    const head = t.head.map((c) => squeeze(c).replace(/\s+/g, ""));
    const col = (re: RegExp) => head.findIndex((c) => re.test(c));
    if (head.length === 2 && head[0] === "가입조건") {
      used.add(ti); if (first < 0) first = ti;
      for (const row of t.rows) {
        const k = squeeze(row[0] ?? "").replace(/\s+/g, ""), v = (row[1] ?? "").trim();
        if (!v || v === "—") continue;
        if (/종류/.test(k)) p.category = v;
        else if (/종목/.test(k)) p.types = list(v, /\s*[·,，]\s*/);
        else if (/납입주기/.test(k)) p.payFreqs = list(v, /\s*[·,，/]\s*/);
        else if (/한도|가입금액/.test(k)) p.sumLimit = v;
        else if (/갱신/.test(k)) p.renewal = v;
      }
      return;
    }
    const cTerm = col(/^보험기간$/), cPay = col(/납입기간$/), cAge = col(/가입(나이|연령)/);
    if (cTerm < 0 || cPay < 0 || cAge < 0) return;
    used.add(ti); if (first < 0) first = ti;
    const cAgeF = head.findIndex((c, i) => i !== cAge && /가입(나이|연령).*여/.test(c));
    const cFreq = col(/납입주기/), cLabel = col(/^(구분|보장|담보|보장내용|형구분|종목)$/);
    const rows: EntryRow[] = [];
    let prev: EntryRow | undefined;
    for (const r of t.rows) {
      if (!r.some((c) => c.trim())) continue;
      const cell = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
      const get = (c: number) => (cell(c) === "—" ? "" : cell(c));
      // 빈 칸은 병합(위 행과 같음), "—" 는 정말 비어 있음
      const carry = (c: number, above?: string) => (c >= 0 && cell(c) === "" ? above ?? "" : get(c));
      const label = cLabel >= 0 ? carry(cLabel, prev?.label) : "";
      const row: EntryRow = {
        ...(label ? { label } : {}),
        term: carry(cTerm, prev?.term), pay: get(cPay), age: carry(cAge, prev?.age),
        ...(cAgeF >= 0 && get(cAgeF) && get(cAgeF) !== get(cAge) ? { ageF: get(cAgeF) } : {}),
      };
      rows.push(row); prev = row;
      if (cFreq >= 0 && get(cFreq)) p.payFreqs = [...new Set([...(p.payFreqs ?? []), ...list(get(cFreq), /\s*[·,，/]\s*/)])];
    }
    if (rows.length) p.terms = [...(p.terms ?? []), ...rows];
  });
  if (hasProduct(p)) {
    spec.product = p;
    evidence.push({ path: "product", label: "가입 조건", value: `${p.terms?.length ?? 0}행`,
      raw: (p.terms ?? []).slice(0, 3).map((r) => `${r.term} ${r.pay} ${r.age}`).join(" / ").slice(0, 140) || (p.category ?? ""),
      source: `표 ${first + 1}`, confidence: "high" });
  }
  return used;
}

/** "담보 | 단위 | 급부 유형 | 지급 사유 | 보장금액 | 보장 종료 | 면책 | 급부 위험률 | 탈퇴 위험률" 표 */
function readBenefitTable(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[], warnings: string[]) {
  const byName = (name: string, ben: string) => {
    const s = name.trim();
    const hit = spec.rates.find((r) => r.name === s) ?? spec.rates.find((r) => s && (r.name.endsWith(` · ${s}`) || s.endsWith(r.name)));
    if (hit || !s || s === "—") return hit;
    // 담보 표에만 적은 위험률 — 1.2. 위험률 표에 없어도 계열로 더한다(유형은 이름으로 어림). 사람이 유형·근거를 채운다
    const ref: RateRef = { id: `r${spec.rates.length + 1}`, name: s, role: roleOf(s) === "lapse" ? "other" : roleOf(s) };
    spec.rates.push(ref);
    evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: s, raw: `담보 "${ben}"`, source: "담보 표", confidence: "medium" });
    warnings.push(`담보 "${ben}" 의 위험률 "${s}" 이(가) 1.2. 위험률 표에 없어 "${RATE_ROLE_LABEL[ref.role]}" 유형으로 더했습니다 — 유형·근거를 확인하세요`);
    return ref;
  };
  const multi = doc.tables.some((x) => squeeze(x.head.join("")).includes("주계약과다른조건"));
  // v5: 보험기간(= 옛 보장 종료) · 보장금액은 "가입금액의 0.5배" · 면책·삭감(= 옛 면책 + 지급 비율). 옛 열쇠도 그대로 읽는다
  const KEYS = ["담보", "단위", "급부유형", "지급사유", "보장금액", "보장종료", "보험기간", "면책", "면책·삭감", "급부위험률", "탈퇴위험률", "생존자"] as const;
  type Rec = Partial<Record<(typeof KEYS)[number], string>>;
  const add = (f: Rec, raw: string, ti: number) => {
    const get = (k: keyof Rec) => (f[k] ?? "").trim();
    const name = get("담보");
    if (!name) return;
    const roleRaw = ROLE_BY_LABEL.get(get("급부유형"));
    const role = roleRaw && roleRaw !== "waiver" && roleRaw !== "lapse" ? roleRaw : "incidence";
    const ev = get("급부위험률"), exits = get("탈퇴위험률");
    const bs: BenefitSpec = {
      id: `b${spec.benefits.length + 1}`, name, role,
      ...(get("단위") && !(get("단위") === "주계약" && !multi) ? { unit: get("단위") } : {}),
      ...(get("지급사유") && get("지급사유") !== "—" ? { trigger: get("지급사유") } : {}),
    };
    const mult = /([\d.]+)\s*배/.exec(get("보장금액"));
    if (mult) bs.multiple = Number(mult[1]);
    else { const amt = numIn(get("보장금액")); if (amt !== null) bs.amount = amt; }
    const end = /(\d+)\s*세/.exec(get("보험기간") || get("보장종료"));
    if (end) bs.endAge = Number(end[1]);
    const waitText = get("면책·삭감") || get("면책");
    const wait = /(\d+)\s*일/.exec(waitText), waitY = /(\d+)\s*년/.exec(waitText);
    if (wait) bs.waitDays = Number(wait[1]);
    else if (waitY) bs.waitDays = Number(waitY[1]) * 365;
    const cut = /(\d+)\s*%\s*삭감/.exec(waitText);
    if (bs.waitDays && cut) bs.waitPayRatio = Number(cut[1]) / 100;
    const ids = exits.split(/\s+및\s+|\s*\+\s*|,\s*/).map((x) => byName(x, name)?.id).filter((x): x is string => !!x);
    if (ids.length) bs.exitRateIds = ids;
    // v7: 이 보험금이 가져다 쓰는 생존자 lx(k) — 탈퇴 위험률은 생존자 표에서 맞춘다(syncFromSurvivors)
    const sv = /lx\((\d+)\)/.exec(get("생존자"));
    if (sv) bs.survivorId = `s${sv[1]}`;
    // 급부 위험률은 탈퇴 사유에서 정해진다 — 거기서 나오는 것과 다를 때만(일당형 등) 따로 적는다
    if (ev && !/탈퇴\s*사유|^—$/.test(ev)) {     // "탈퇴 사유 전부 — 결합 Q (…)" · "탈퇴 사유에서 — 암발생률" 은 생존자에서 정해진다
      const id = byName(ev, name)?.id;
      if (id && id !== eventRate(spec, bs)?.id) bs.rateId = id;
    }
    spec.benefits.push(bs);
    evidence.push({ path: `benefits[${spec.benefits.length - 1}]`, label: "담보", value: name, raw: raw.slice(0, 160), source: `표 ${ti + 1}`, confidence: "high" });
  };
  const key = (c: string) => squeeze(c).replace(/\s/g, "");
  doc.tables.forEach((t, ti) => {
    const h = t.head.map(key);
    // 세로: "담보 | 사망·80% 이상 장해" 다음 행마다 "급부 유형 | 사망" … (표준 산출방법서 v2)
    if (h.length === 2 && h[0] === "담보" && t.rows.some((r) => key(r[0] ?? "") === "급부유형")) {
      const f: Rec = { 담보: t.head[1] };
      for (const r of t.rows) { const k = key(r[0] ?? "") as keyof Rec; if ((KEYS as readonly string[]).includes(k)) f[k] = r[1] ?? ""; }
      add(f, [t.head, ...t.rows].map((r) => r.join(" ")).join(" | "), ti);
      return;
    }
    // 가로: "담보 | 단위 | 급부 유형 | … " 한 행이 담보 하나 (v1 · 다른 앱)
    const col = (k: string) => h.indexOf(k);
    if (col("담보") < 0 || col("급부유형") < 0 || col("보장금액") < 0) return;
    for (const r of t.rows) {
      const f: Rec = {};
      for (const k of KEYS) if (col(k) >= 0) f[k] = r[col(k)] ?? "";
      add(f, r.filter(Boolean).join(" | "), ti);
    }
  });
}

/**
 * 사업비 표. 회사마다 모양이 달라 두 갈래로 본다.
 *  (1) 머리글이 "구분 | 기준 | (예정)사업비율" 꼴이면 값이 있는 모든 행을 항목으로 본다.
 *  (2) 머리글이 없어도 행 첫머리가 α1·β2·γ 이거나 신계약비·유지비·수금비면 그 행만 항목으로 본다.
 * 값은 칸이 "3/1000" 처럼 숫자만일 수도, "초년도 보험가입금액의 2.50/1,000" 처럼 문장일 수도 있어 문장에서 집어낸다.
 */
function readExpenseTable(t: DocTable, ti: number, spec: MethodSpec, add: Add) {
  const head = squeeze(t.head.join(" "));
  const headLooks = /(적용\s*사업비|사업비율|비\s*율|비율)/.test(head) && /(구\s*분|기\s*준|적용\s*기준)/.test(head);
  const exact = t.head.map((c) => squeeze(c).replace(/\s/g, "")).join("|") === "구분|기호|기준|적용사업비율";
  for (const row of [t.head, ...t.rows]) {
    const cells = row.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const joined = cells.join(" "), flat = squeeze(joined);
    const hit = EXPENSE_SYMBOL.find((x) => x.re.test(flat));
    if (!hit && !headLooks) continue;
    if (/[≦≤<>]/.test(joined)) continue;                       // "20 ≦ m < 25 : 50%" 같은 구간별 환수율 표
    const last = cells[cells.length - 1];
    const picked = pickRate(last) ?? pickRate(joined);
    const times = parseTimes(last);
    if (!picked && times === null) continue;
    const rate = picked?.value ?? null, raw = picked?.raw ?? last;
    // 기준은 앞 칸에서 찾고, 없으면 값이 들어 있던 문장에서 숫자를 뺀 부분을 쓴다
    const tidy = (x: string) => x.replace(/\s+/g, " ").replace(/^[가-힣]\s*[).]\s*/, "").trim().slice(0, 40);
    const cap = MIN_CAP.exec(joined);
    // "× MIN(보험기간, 20)" 은 배수에 녹이므로 기준 문구에서 뺀다
    const rawBasis = cells.slice(0, -1).reverse().find(isBasis)
      ?? (isBasis(last) ? last.replace(RATE_TOKEN, "").replace(/[의:：]\s*$/, "") : "");
    const basis = tidy(cap ? rawBasis.replace(/\s*[×x*]?\s*MIN\s*\([^)]*\)/i, "").replace(/[의:：]\s*$/, "") : rawBasis);
    const explicit = cells.find((c) => SYMBOL_CELL.test(c.replace(/\s/g, "")))?.replace(/\s/g, "");
    const g = GREEK.exec(flat);
    // 병합 셀이 많은 PDF 는 엉뚱한 칸이 첫 칸으로 오기도 한다 — 길거나 문장이면 그냥 "사업비"
    const first = cells[0].replace(/\s+/g, " ").trim();
    const item: ExpenseItem = {
      group: hit?.group ?? (first.length <= 24 && !/[:：]/.test(first) ? first : "사업비"),
      symbol: explicit ?? (g ? g[0].replace(/\s/g, "") : hit
        ? (isAnnualNet(basis) ? "α_P" : hit.symbol === "α" ? "α_S" : hit.symbol === "β" ? (isPremiumBasis(basis) ? "β_G" : "β_S") : hit.symbol)
        : ""),
      basis, phase: /납입\s*후/.test(joined) ? "납입후" : /납입\s*중/.test(joined) ? "납입중" : hit?.phase,
      raw,
    };
    // "15%" 가 기준연납순보험료 기준이면 배수로 본다. "× MIN(보험기간, 20)" 이 붙으면 20년치 배수(12% → 2.4배)
    if (isAnnualNet(basis) && rate !== null) item.times = cap ? Math.round(rate * Number(cap[1]) * 1e10) / 1e10 : rate;
    else if (times !== null) item.times = times;
    else if (rate !== null) item.rate = rate;
    if (exact) {
      const [g, sym, b] = row.map((c) => c.replace(/\s+/g, " ").trim());
      const gm = /^(.+?) \(([^()]+)\)$/.exec(g ?? "");
      item.group = gm ? gm[1] : g || item.group;
      item.phase = gm ? gm[2] : undefined;
      item.symbol = sym && sym !== "—" ? sym : "";
      item.basis = b ?? "";
    }
    // 같은 표가 상품별로 여러 번 실리는 문서가 있다 — 같은 항목은 한 번만
    if (spec.expenses.some((e) => e.group === item.group && e.basis === item.basis && e.raw === item.raw && e.phase === item.phase)) continue;
    spec.expenses.push(item);
    add(`expenses[${spec.expenses.length - 1}]`, `사업비 ${item.group}`, item.rate ?? item.times ?? 0,
      `${joined.slice(0, 140)} = ${raw}`, `표 ${ti + 1}`, headLooks ? "high" : "medium", false);
  }
}

/**
 * 기초율 표. 행을 한 줄로 이어 붙여 본문 사전(FIELD_RULES)을 그대로 돌린다 —
 * "이율 | - 연 2.5% 복리" 처럼 이름과 값이 다른 칸에 있어도 잡히고, PDF 처럼 표가 줄로 풀려도 같은 규칙이 쓰인다.
 * 제목 행("2. 예정이율에 관한 사항")과 값 행("연복리 3.5%")이 갈린 표도 본문과 같은 방식으로 이어 본다.
 * 표 값은 본문보다 믿을 만하므로 confidence "high", 그리고 표를 먼저 훑어 본문 값이 덮지 않게 한다.
 */
function readBasisTable(t: DocTable, ti: number, add: Add, spec: MethodSpec) {
  const lines = [t.head, ...t.rows]
    .map((row) => row.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean).join(" "))
    .filter((l) => l && l.length <= 600);
  scanLines(lines, () => `표 ${ti + 1}`, "high", spec, add);
}

/**
 * 줄 목록에 사전을 돌린다. 본문과 표가 같은 규칙을 쓴다.
 * 산출방법서는 "가. 적용이율" 다음 줄에 값이 오는 일이 잦아 바로 위 제목을 함께 본다.
 * 값은 언제나 그 줄에서만 읽는다(제목에서 숫자를 주워 오지 않게).
 */
function scanLines(lines: string[], source: (i: number) => string, conf: Confidence, spec: MethodSpec, add: Add) {
  let heading = "";
  lines.forEach((line, li) => {
    if (isHeading(line)) heading = line;
    const withHead = heading && heading !== line ? `${heading} ${line}` : line;
    const flat = squeeze(line), flatHead = squeeze(withHead);
    for (const r of FIELD_RULES) {
      const m = r.value.exec(line);
      if (!m) continue;
      const own = r.words.test(line) || r.words.test(flat);
      const scope = own ? flat : r.words.test(flatHead) ? flatHead : null;
      if (!scope || r.not?.test(scope)) continue;
      const v = r.kind === "rate" ? parseRate(`${m[1]}%`) : Math.round(n(m[1]));
      if (v === null || !Number.isFinite(v)) continue;
      add(r.path === "benefits.waitDays" ? "surrender.waitDays" : r.path, r.label, v,
        own ? line : `${heading} / ${line}`, source(li), conf);
    }
    readLapse(squeeze(withHead), li, spec, add, source(li), conf);
  });
}

/** 적용해지율 — 종류별 줄을 모아 basis.lapse 로 */
function readLapse(line: string, li: number, spec: MethodSpec, add: Add, source?: string, conf: Confidence = "medium") {
  if (!LAPSE_WORDS.test(line) && !LOW_KIND.test(line)) return;
  // 경과기간별 해지율 표는 한 줄에 비율이 줄줄이 나온다 — 어느 것이 "그" 해지율인지 규칙으로는 가릴 수 없어 넘긴다
  if ((line.match(/[%％]/g)?.length ?? 0) > 3) return;
  const src = source ?? `본문 ${li + 1}줄`;
  void li;
  // "연 3.0%" 도 "3.0%" 도 읽는다. 0% 는 "납입 완료 후 0%" 같은 꼬리표라 넘긴다(진짜 0 은 LAPSE_NONE 이 맡는다)
  const re = new RegExp(`(1종|2종|3종|[가-힣]*형)?[^%％]{0,40}?(?:연\\s*)?${NUM}\\s*${PCT}`, "g");
  let m: RegExpExecArray | null, found = false;
  while ((m = re.exec(line))) {
    const rate = n(m[2]) / 100;
    if (rate <= 0 || rate >= 0.5) continue;                    // 적용해지율이 50% 이상일 수는 없다
    const label = m[1]?.trim() || undefined;
    const list = (spec.basis.lapse ??= []);
    if (list.some((x) => x.rate === rate && (x.label === label || !x.label || !label))) continue;   // 같은 값이 제목 있이/없이 두 번 나오면 한 번만
    list.push({ label, rate, duringPayOnly: LAPSE_DURING.test(line) });
    found = true;
  }
  if (found) {
    add("basis.lapse", "적용해지율", spec.basis.lapse!.map((l) => `${l.label ?? ""} ${(l.rate * 100).toFixed(1)}%`).join(" / "), line.slice(0, 160), src, conf, false);
    const low = LOW_KIND.exec(line);
    if (low && spec.basis.lowRatio === undefined) {
      // "× 70%" 처럼 환급률이 적혀 있으면 그 값을 쓰고, 없으면 무해지는 0·저해지는 짐작값
      const shown = new RegExp(`[×x]\\s*${NUM}\\s*${PCT}`).exec(line);
      if (shown) add("basis.lowRatio", "환급률", n(shown[1]) / 100, line.slice(0, 160), src, "medium");
      else add("basis.lowRatio", "환급률", low[1] === "무해지" ? 0 : 0.5, line.slice(0, 160), src, low[1] === "무해지" ? "medium" : "low");
    }
  } else if (LAPSE_NONE.test(line) && LAPSE_WORDS.test(line)) {
    add("basis.lapse", "적용해지율", "적용하지 않음", line.slice(0, 160), src, conf, false);
  }
}

/** 위험률 값 표 — 첫 열이 연령(정수)이고 나머지 칸에 수가 있는 표(별첨). 앱이 위험률 표 창으로 가져가고, 조건 규칙은 보지 않는다 */
export function isRateValueTable(t: DocTable): boolean {
  const head = squeeze(t.head[0] ?? "").replace(/\s/g, "");
  if (t.head.length < 2 || t.rows.length < 2 || !/^(연령|나이|가입나이|age|x)$/i.test(head) && !/연령|나이/.test(head)) return false;
  const int = (s: string) => /^\d{1,3}\s*세?$/.test(s.trim());
  return t.rows.every((r) => int(r[0] ?? "")) && t.rows.some((r) => r.slice(1).some((c) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*[%‰]?$/.test(c.replace(/,/g, "").trim())));
}

/** 번호 붙은 제목 줄인지 — "1.", "1.1.", "가.", "(1)", "○", "◦" */
export const isHeading = (s: string) =>
  s.length < 60 && /^(\d+(\.\d+)*\.|[가-힣]\.|\(\d+\)|[○◦▪·])\s*\S/.test(s.trim());

/** "1. …", "가. …", "(1) …" 번호 체계로 원문 절을 나눠 보존한다 */
export function outlineSections(doc: ExtractedDoc) {
  const out: { title: string; paragraphs: string[] }[] = [];
  const isTop = (s: string) => /^\d+\.\s*\S/.test(s) && s.length < 60;
  for (const p of doc.paragraphs) {
    if (isTop(p)) out.push({ title: p, paragraphs: [] });
    else if (out.length) out[out.length - 1].paragraphs.push(p);
  }
  return out.filter((s) => s.paragraphs.length);
}
