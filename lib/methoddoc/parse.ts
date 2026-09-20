import type { DocTable, ExtractedDoc } from "./extract";
import { emptySpec, validateSpec, type Confidence, type Evidence, type ExpenseItem, type MethodSpec, type ParseResult, type RateRef, type RateRole } from "./spec";

/**
 * 산출방법서 → MethodSpec. 규칙(표 먼저, 본문 다음)만으로 돌아간다 — LLM 은 선택이다.
 * 실제 산출방법서 2건(DOCX·HWP, DRM 없음)에 맞춰 사전을 짰다.
 * 뽑은 값마다 Evidence(원문·출처·확신도)를 남겨, 검수 화면이 사람에게 확인받을 수 있게 한다.
 */

// ── 단위 정규화 ──────────────────────────────────────────────────────────────
const NUM = String.raw`(-?[\d,]+(?:\.\d+)?)`;
const n = (s: string) => Number(s.replace(/,/g, ""));

/** "2.5%" · "80/1000" · "6.8/1,000" · "1‰" · "0.15" → 소수 */
export function parseRate(raw: string): number | null {
  const s = raw.replace(/\s/g, "");
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
  { path: "basis.interest", label: "적용이율", kind: "rate",
    words: /(적용이율|예정이율|적용\s*기초율[^가-힣]*이율|보장부분\s*:?\s*적용이율)/,
    value: new RegExp(`(?:연\\s*복리|연)?\\s*${NUM}\\s*%`), not: /(표준이율|최저보증|평균공시)/ },
  { path: "basis.standardInterest", label: "표준이율", kind: "rate",
    words: /표준이율/, value: new RegExp(`${NUM}\\s*%`) },
  { path: "basis.minGuaranteed", label: "최저보증이율", kind: "rate",
    words: /최저\s*보증\s*이율/, value: new RegExp(`${NUM}\\s*%`) },
  { path: "basis.averagePublished", label: "평균공시이율", kind: "rate",
    words: /평균\s*공시\s*이율/, value: new RegExp(`${NUM}\\s*%`) },
  { path: "contract.age", label: "가입연령", kind: "int",
    words: /(가입\s*연령|가입\s*나이|피보험자.*연령)/, value: new RegExp(`${NUM}\\s*세`) },
  { path: "contract.termAge", label: "보험기간(세만기)", kind: "int",
    words: /보험\s*기간/, value: new RegExp(`${NUM}\\s*세\\s*만기`) },
  { path: "contract.termYears", label: "보험기간(년)", kind: "int",
    words: /보험\s*기간/, value: new RegExp(`${NUM}\\s*년\\s*만기`), not: /납입/ },
  { path: "contract.payYears", label: "납입기간", kind: "int",
    words: /(납입\s*기간|보험료\s*납입)/, value: new RegExp(`${NUM}\\s*년\\s*납?`) },
  { path: "benefits.waitDays", label: "면책기간", kind: "int",
    words: /(면책\s*기간|보장\s*개시|감액\s*지급)/, value: new RegExp(`${NUM}\\s*일`) },
];

/** 적용해지율 — 종류별로 여러 줄일 수 있어 따로 다룬다 */
const LAPSE_WORDS = /(적용\s*해지율|해지율)/;
const LAPSE_DURING = /(납입\s*기간\s*중|납입기간중)/;
const LAPSE_NONE = /(적용하지\s*않|해당\s*없|0\s*%)/;
const LOW_KIND = /(무해지|저해지)\s*환급/;

/** 사업비 표의 기준 문구 → 기호 */
const EXPENSE_SYMBOL: { re: RegExp; symbol: string; group: string; phase?: string }[] = [
  { re: /계약\s*체결|신계약비/, symbol: "α", group: "계약체결비용" },
  { re: /유지\s*관련|계약\s*관리.*유지|계약\s*관리\s*비용/, symbol: "β", group: "계약관리비용", phase: "납입중" },
  { re: /기타\s*비용/, symbol: "β_기타", group: "계약관리비용(기타)" },
  { re: /수금/, symbol: "γ", group: "수금비용" },
];
const isAmountBasis = (s: string) => /(보험\s*가입\s*금액|가입금액|보험금)/.test(s);
const isPremiumBasis = (s: string) => /(영업\s*보험료|보험료)/.test(s);
const isAnnualNet = (s: string) => /기준\s*연납\s*순보험료/.test(s);

const ROLE_WORDS: { re: RegExp; role: RateRole }[] = [
  { re: /(사망률|사망\s*위험률)/, role: "death" },
  { re: /(장해|납입\s*면제)/, role: "waiver" },
  { re: /(입원율|입원\s*일|통원|수술율)/, role: "recurring" },
  { re: /(발생률|진단률|진단율|지급률|이환율)/, role: "incidence" },
  { re: /해지율/, role: "lapse" },
];
const roleOf = (name: string): RateRole => ROLE_WORDS.find((x) => x.re.test(name))?.role ?? "other";

/** 위험률 계열 이름으로 볼 만한지 — 수익성 분석의 '최적OO율·할인율·수익률' 같은 잡음을 거른다 */
const RISK_WORD = /(사망|발생|진단|이환|입원|통원|수술|장해|치매|암|상해|질병|간병|지급률|해지율|재해|후유)/;
const NOT_RISK = /(최적|목표|할인|투자|수익|법인세|사업비|기초율|물가|인플레|환율|(?<!무)배당률)/;   // "무배당"이 걸리지 않게
export function looksLikeRateName(name: string): boolean {
  const s = name.trim();
  if (s.length < 3 || s.length > 40) return false;
  if (!/(률|율)$/.test(s)) return false;
  if (/^\(?\d/.test(s)) return false;          // "(1) …", "2) …"
  if (NOT_RISK.test(s)) return false;
  return RISK_WORD.test(s);
}

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

  // 0) 상품명 — 표지 문단
  const title = doc.paragraphs.find((p) => /(보험|공제)/.test(p) && !/산출방법서/.test(p) && p.length < 60)
    ?? doc.paragraphs[0];
  if (title) add("meta.productName", "상품명", title, title, "표지", "medium");
  const kindLine = doc.paragraphs.find((p) => LOW_KIND.test(p));
  if (kindLine) add("meta.kind", "종류", LOW_KIND.exec(kindLine)![0], kindLine, "본문", "medium");

  // 1) 표 먼저 — 적중률이 가장 높다
  doc.tables.forEach((t, ti) => {
    readExpenseTable(t, ti, spec, add);
    readBasisTable(t, ti, add, spec);
  });

  // 2) 본문 규칙. 산출방법서는 "가. 적용이율" 다음 줄에 값이 오는 일이 잦아 바로 위 제목을 함께 본다
  let heading = "";
  doc.paragraphs.forEach((line, li) => {
    if (isHeading(line)) heading = line;
    const withHead = heading && heading !== line ? `${heading} ${line}` : line;
    for (const r of FIELD_RULES) {
      // 값은 항상 이 줄에서만 읽는다(제목에서 숫자를 주워 오지 않게)
      const m = r.value.exec(line);
      if (!m) continue;
      const scope = r.words.test(line) ? line : r.words.test(withHead) ? withHead : null;
      if (!scope || r.not?.test(scope)) continue;
      const v = r.kind === "rate" ? parseRate(`${m[1]}%`) : Math.round(n(m[1]));
      if (v === null || !Number.isFinite(v)) continue;
      add(r.path === "benefits.waitDays" ? "surrender.waitDays" : r.path, r.label, v,
        scope === line ? line : `${heading} / ${line}`, `본문 ${li + 1}줄`, "medium");
    }
    readLapse(withHead, li, spec, add);
  });

  // 3) 위험률 — "○ …률" 목록과 "…를 사용함" 문구
  for (const [li, line] of doc.paragraphs.entries()) {
    const m = /^[○◦\-·•]?\s*([가-힣A-Za-z0-9()\s]*?(?:률|율|지급률))\s*(?:×\s*([^:]*))?[:：]?\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (!looksLikeRateName(name)) continue;
    if (spec.rates.some((r) => r.name === name)) continue;
    const source = m[3]?.trim();
    const ref: RateRef = { id: `r${spec.rates.length + 1}`, name, role: roleOf(name) };
    if (m[2]) ref.adjustment = `× ${m[2].trim()}`;
    if (source && /(보험개발원|제\s*\d|호|경험|참조)/.test(source)) ref.source = source.slice(0, 200);
    spec.rates.push(ref);
    evidence.push({ path: `rates[${spec.rates.length - 1}]`, label: "위험률", value: name, raw: line, source: `본문 ${li + 1}줄`, confidence: source ? "medium" : "low" });
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

  // 4) 원문 절 보존 — 모델에 자리가 없는 내용을 잃지 않게
  spec.sections = outlineSections(doc);

  const missing = ["meta.productName", "basis.interest", "contract.payYears"]
    .filter((p) => !evidence.some((e) => e.path === p))
    .map((p) => FIELD_RULES.find((r) => r.path === p)?.label ?? p);
  if (!spec.expenses.length) missing.push("사업비");
  if (!spec.rates.length) missing.push("위험률");

  return { spec, evidence, missing, warnings: [...warnings, ...validateSpec(spec)] };
}

type Add = (path: string, label: string, value: string | number | boolean, raw: string, source: string, confidence: Confidence, setValue?: boolean) => void;

/** 사업비 표 — "구분 | 기준 | 비율" 모양을 찾아 항목으로 만든다 */
function readExpenseTable(t: DocTable, ti: number, spec: MethodSpec, add: Add) {
  const head = t.head.join(" ");
  const looksExpense = /(적용\s*사업비|비\s*율|비율)/.test(head) && /(구\s*분|기\s*준|적용\s*기준)/.test(head);
  if (!looksExpense) return;
  for (const row of t.rows) {
    const cells = row.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const raw = cells[cells.length - 1];
    const rate = parseRate(raw), times = parseTimes(raw);
    if (rate === null && times === null) continue;
    const basis = cells.slice(0, -1).reverse().find((c) => isAmountBasis(c) || isPremiumBasis(c) || isAnnualNet(c)) ?? cells[cells.length - 2] ?? "";
    const label = cells.join(" ");
    const hit = EXPENSE_SYMBOL.find((x) => x.re.test(label));
    const item: ExpenseItem = {
      group: hit?.group ?? cells[0],
      symbol: hit ? (isAnnualNet(basis) ? "α_P" : hit.symbol === "α" ? "α_S" : hit.symbol === "β" ? (isPremiumBasis(basis) ? "β_G" : "β_S") : hit.symbol) : "",
      basis, phase: /납입\s*후/.test(label) ? "납입후" : /납입\s*중/.test(label) ? "납입중" : hit?.phase,
      raw,
    };
    if (isAnnualNet(basis) && rate !== null) item.times = rate;   // "15%" 가 기준연납순보험료 기준이면 배수로 본다
    else if (times !== null) item.times = times;
    else if (rate !== null) item.rate = rate;
    spec.expenses.push(item);
    add(`expenses[${spec.expenses.length - 1}]`, `사업비 ${item.group}`, item.rate ?? item.times ?? 0, `${label} = ${raw}`, `표 ${ti + 1}`, "high", false);
  }
}

/**
 * 기초율 표. 행을 한 줄로 이어 붙여 본문 사전(FIELD_RULES)을 그대로 돌린다 —
 * "이율 | - 연 2.5% 복리" 처럼 이름과 값이 다른 칸에 있어도 잡히고, PDF 처럼 표가 줄로 풀려도 같은 규칙이 쓰인다.
 * 표 값은 본문보다 믿을 만하므로 confidence "high", 그리고 표를 먼저 훑어 본문 값이 덮지 않게 한다.
 */
function readBasisTable(t: DocTable, ti: number, add: Add, spec: MethodSpec) {
  for (const row of [t.head, ...t.rows]) {
    const line = row.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
    if (!line || line.length > 600) continue;
    for (const r of FIELD_RULES) {
      if (!r.words.test(line) || r.not?.test(line)) continue;
      const m = r.value.exec(line);
      if (!m) continue;
      const v = r.kind === "rate" ? parseRate(`${m[1]}%`) : Math.round(n(m[1]));
      if (v === null || !Number.isFinite(v)) continue;
      add(r.path === "benefits.waitDays" ? "surrender.waitDays" : r.path, r.label, v, line.slice(0, 160), `표 ${ti + 1}`, "high");
    }
    readLapse(line, -1, spec, add, `표 ${ti + 1}`, "high");
  }
}

/** 적용해지율 — 종류별 줄을 모아 basis.lapse 로 */
function readLapse(line: string, li: number, spec: MethodSpec, add: Add, source?: string, conf: Confidence = "medium") {
  if (!LAPSE_WORDS.test(line) && !LOW_KIND.test(line)) return;
  const src = source ?? `본문 ${li + 1}줄`;
  const re = new RegExp(`(1종|2종|3종|[가-힣]*형)?[^%]{0,40}?연\\s*${NUM}\\s*%`, "g");
  let m: RegExpExecArray | null, found = false;
  while ((m = re.exec(line))) {
    const rate = n(m[2]) / 100;
    if (rate > 0.5) continue;
    (spec.basis.lapse ??= []).push({ label: m[1]?.trim() || undefined, rate, duringPayOnly: LAPSE_DURING.test(line) });
    found = true;
  }
  if (found) {
    add("basis.lapse", "적용해지율", spec.basis.lapse!.map((l) => `${l.label ?? ""} ${(l.rate * 100).toFixed(1)}%`).join(" / "), line.slice(0, 160), src, conf, false);
    const low = LOW_KIND.exec(line);
    if (low && spec.basis.lowRatio === undefined) {
      // 무해지는 0 으로 확실하고, 저해지는 비율이 문서마다 달라 짐작값이다
      add("basis.lowRatio", "환급률", low[1] === "무해지" ? 0 : 0.5, line.slice(0, 160), src, low[1] === "무해지" ? "medium" : "low");
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
