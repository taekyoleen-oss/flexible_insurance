import type { DocTable, ExtractedDoc } from "./extract";
import { emptySpec, hasProduct, RATE_ROLE_LABEL, validateSpec, type BenefitSpec, type Confidence, type EntryRow, type Evidence, type ExpenseItem, type MethodSpec, type ParseResult, type ProductInfo, type RateRef, type RateRole } from "./spec";

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
  { path: "contract.age", label: "가입연령", kind: "int",
    words: /(가입\s*연령|가입\s*나이|피보험자.*연령)/, value: new RegExp(`${NUM}\\s*세`) },
  { path: "contract.termAge", label: "보험기간(세만기)", kind: "int",
    words: /보험\s*기간/, value: new RegExp(`${NUM}\\s*세\\s*만기`) },
  { path: "contract.termYears", label: "보험기간(년)", kind: "int",
    words: /보험\s*기간/, value: new RegExp(`${NUM}\\s*년\\s*만기`), not: /납입/ },
  // 사업비 표의 "납입기간 5년이하 경우" 같은 구간 표기를 계약 납입기간으로 오인하지 않게 한다
  { path: "contract.payYears", label: "납입기간", kind: "int",
    words: /(납입\s*기간|보험료\s*납입)/, value: new RegExp(`${NUM}\\s*년\\s*납?`),
    not: /(이하|이상|미만|초과|년수|경과|기간\s*중)/ },
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
const isAnnualNet = (s: string) => /기준\s*연납\s*순보험료/.test(s);
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

export function parseMethodDoc(doc: ExtractedDoc, opt: ParseOptions = {}): ParseResult {
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
  //      이 표의 "110세만기 · 만15세" 를 본문 규칙이 계약(시산 기준 한 점)으로 읽지 않게, 그 줄들은 아래 규칙에서 지운다.
  const productTables = readProduct(doc, spec, evidence);
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

  // 3) 위험률 — "○ …률" 목록과 "…를 사용함" 문구
  for (const [li, line] of paragraphs.entries()) {
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
    const head = t.head.map((c) => squeeze(c).trim());
    if (!/^위험[률율]$/.test(head[0] ?? "")) continue;
    const roleCol = head.findIndex((c) => /^유형$/.test(c));
    const srcCol = head.findIndex((c) => /(근거|출처)/.test(c));
    for (const row of t.rows) {
      const name = (row[0] ?? "").replace(/\s+/g, " ").trim();
      if (!name || name.length > 80 || spec.rates.some((r) => r.name === name)) continue;
      // 이름이 "주계약 · 암발생률" 처럼 계약 단위를 달고 있으면 유형 판정은 뒤쪽만 본다
      const bare = name.includes(" · ") ? name.slice(name.lastIndexOf(" · ") + 3) : name;
      const role = (roleCol >= 0 ? ROLE_BY_LABEL.get((row[roleCol] ?? "").trim()) : undefined) ?? roleOf(bare);
      if (role === "lapse") continue;
      const src = srcCol >= 0 ? (row[srcCol] ?? "").trim() : "";
      spec.rates.push({ id: `r${spec.rates.length + 1}`, name, role, source: src || undefined });
      evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: name,
        raw: row.filter(Boolean).join(" | ").slice(0, 140), source: `표 ${ti + 1}`, confidence: "high" });
    }
  }

  // 표에 적힌 위험률 근거도 줍는다
  for (const t of doc.tables) {
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

  // 3-0) 계약 표("항목 | 내용")와 담보 표("담보 | 단위 | 급부 유형 | …") — 이 모듈이 낸 산출방법서를 되읽을 때 조건이 온전히 돌아오게
  readContractTable(doc, add);
  readBenefitTable(doc, spec, evidence);

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

  // 4) 원문 절 보존 — 모델에 자리가 없는 내용을 잃지 않게
  spec.sections = outlineSections(doc);

  const missing = ["meta.productName", "basis.interest", "contract.payYears"]
    .filter((p) => !evidence.some((e) => e.path === p))
    .map((p) => FIELD_RULES.find((r) => r.path === p)?.label ?? p);
  if (!spec.expenses.length) missing.push("사업비");
  if (!spec.rates.length) missing.push("위험률");

  return { spec, evidence, missing, warnings: [...new Set([...warnings, ...validateSpec(spec)])] };
}

type Add = (path: string, label: string, value: string | number | boolean, raw: string, source: string, confidence: Confidence, setValue?: boolean) => void;

const numIn = (s: string) => { const m = /(-?[\d,]+(?:\.\d+)?)/.exec(s); return m ? n(m[1]) : null; };

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

/** "항목 | 내용" 계약 표: 피보험자 40세 남 · 보험기간 71년 · 납입주기 월납 · 보험가입금액 1억 */
function readContractTable(doc: ExtractedDoc, add: Add) {
  doc.tables.forEach((t, ti) => {
    if (t.head.length !== 2 || !/항목/.test(t.head[0])) return;
    for (const [k, v] of t.rows.map((r) => [squeeze(r[0] ?? ""), (r[1] ?? "").trim()])) {
      const src = `표 ${ti + 1}`, raw = `${k} ${v}`;
      if (/^피보험자/.test(k)) {
        const age = /(\d+)\s*세/.exec(v);
        if (age) add("contract.age", "가입연령", Number(age[1]), raw, src, "high");
        if (/남/.test(v)) add("contract.sex", "성별", "M", raw, src, "high");
        else if (/여/.test(v)) add("contract.sex", "성별", "F", raw, src, "high");
      } else if (/^보험기간/.test(k)) {
        const age = /(\d+)\s*세\s*만기/.exec(v), yrs = /(\d+)\s*년/.exec(v);
        if (age) add("contract.termAge", "보험기간(세만기)", Number(age[1]), raw, src, "high");
        else if (yrs) add("contract.termYears", "보험기간(년)", Number(yrs[1]), raw, src, "high");
      } else if (/^(보험료)?납입주기/.test(k)) {
        const f = /월납/.test(v) ? 12 : /연납/.test(v) ? 1 : /6\s*개월/.test(v) ? 2 : /3\s*개월/.test(v) ? 4 : /연\s*(\d+)\s*회/.test(v) ? Number(/연\s*(\d+)\s*회/.exec(v)![1]) : null;
        if (f) add("contract.freq", "납입주기", f, raw, src, "high");
      } else if (/^보험가입금액/.test(k)) {
        const a = numIn(v);
        if (a) add("contract.sumAssured", "보험가입금액", a, raw, src, "high");
      }
    }
  });
}

/** "담보 | 단위 | 급부 유형 | 지급 사유 | 보장금액 | 보장 종료 | 면책 | 급부 위험률 | 탈퇴 위험률" 표 */
function readBenefitTable(doc: ExtractedDoc, spec: MethodSpec, evidence: Evidence[]) {
  const byName = (name: string) => {
    const s = name.trim();
    return spec.rates.find((r) => r.name === s) ?? spec.rates.find((r) => s && (r.name.endsWith(` · ${s}`) || s.endsWith(r.name)));
  };
  doc.tables.forEach((t, ti) => {
    const h = t.head.map((c) => squeeze(c));
    const col = (re: RegExp) => h.findIndex((c) => re.test(c));
    const cName = col(/^담보$/), cRole = col(/^급부유형$/), cAmt = col(/^보장금액$/);
    if (cName < 0 || cRole < 0 || cAmt < 0) return;
    const cUnit = col(/^단위$/), cTrig = col(/^지급사유$/), cEnd = col(/^보장종료$/), cWait = col(/^면책$/), cEv = col(/^급부위험률$/), cExit = col(/^탈퇴위험률$/);
    t.rows.forEach((r) => {
      const get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
      const name = get(cName);
      if (!name) return;
      const roleRaw = ROLE_BY_LABEL.get(get(cRole));
      const role = roleRaw && roleRaw !== "waiver" && roleRaw !== "lapse" ? roleRaw : "incidence";
      const ev = get(cEv), exits = get(cExit);
      const b: BenefitSpec = {
        id: `b${spec.benefits.length + 1}`, name, role,
        ...(get(cUnit) ? { unit: get(cUnit) } : {}),
        ...(get(cTrig) && get(cTrig) !== "—" ? { trigger: get(cTrig) } : {}),
      };
      const amt = numIn(get(cAmt));
      if (amt !== null) b.amount = amt;
      const end = /(\d+)\s*세/.exec(get(cEnd));
      if (end) b.endAge = Number(end[1]);
      const wait = /(\d+)\s*일/.exec(get(cWait));
      if (wait) b.waitDays = Number(wait[1]);
      if (ev && !/탈퇴\s*사유\s*전부|^—$/.test(ev)) b.rateId = byName(ev)?.id;
      const ids = exits.split(/\s+및\s+|\s*\+\s*|,\s*/).map((x) => byName(x)?.id).filter((x): x is string => !!x);
      if (ids.length) b.exitRateIds = ids;
      spec.benefits.push(b);
      evidence.push({ path: `benefits[${spec.benefits.length - 1}]`, label: "담보", value: name, raw: r.filter(Boolean).join(" | ").slice(0, 160), source: `표 ${ti + 1}`, confidence: "high" });
    });
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
    const basis = tidy(cells.slice(0, -1).reverse().find(isBasis)
      ?? (isBasis(last) ? last.replace(RATE_TOKEN, "").replace(/[의:：]\s*$/, "") : ""));
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
    if (isAnnualNet(basis) && rate !== null) item.times = rate;   // "15%" 가 기준연납순보험료 기준이면 배수로 본다
    else if (times !== null) item.times = times;
    else if (rate !== null) item.rate = rate;
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
