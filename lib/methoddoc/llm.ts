import type { ExtractedDoc } from "./extract";
import type { Confidence, Evidence, MethodSpec, ParseResult } from "./spec";

/**
 * 선택적 LLM 보조. 규칙이 못 찾은 항목만, 그 항목이 있을 법한 문단 몇 개만 잘라 물어본다.
 *
 * - 전체 문서를 넣지 않는다: 비용도 환각도 문단 단위가 유리하다.
 * - 결과는 반드시 confidence "low" 로 표시해 검수 화면에서 눈에 띄게 한다.
 * - 이 파일도 앱에 딸리지 않는다. 호출자가 ask 함수를 넘기고(서버 라우트든 뭐든),
 *   넘기지 않으면 기능이 조용히 꺼진다 — 규칙만으로 계속 돌아간다.
 */

export interface LlmField { path: string; label: string; hint: string; kind: "rate" | "int" | "text" | "bool" }

/** 규칙으로 잘 안 잡히는 것들. 순서가 곧 우선순위 */
export const LLM_FIELDS: LlmField[] = [
  { path: "meta.productName", label: "상품명", hint: "표지의 상품 이름. '산출방법서' 같은 문서 종류는 빼고", kind: "text" },
  { path: "basis.interest", label: "적용이율", kind: "rate", hint: "보장부분 적용이율(예정이율). 소수로 (2.5% → 0.025)" },
  { path: "basis.standardInterest", label: "표준이율", kind: "rate", hint: "표준책임준비금 기준 이율. 소수" },
  { path: "basis.lowRatio", label: "저해지 환급률", kind: "rate", hint: "납입기간 중 해지환급금 비율. 무해지면 0, 50%형이면 0.5" },
  { path: "basis.waiver", label: "납입면제 적용", kind: "bool", hint: "보험료 납입면제 제도가 있는지" },
  { path: "surrender.deductionYears", label: "해약공제 기간(년)", kind: "int", hint: "해약공제가 사라지는 데 걸리는 햇수(보통 7)" },
];

export interface LlmRequest {
  /** 물어볼 항목 */
  fields: LlmField[];
  /** 그 항목이 있을 법한 문단 발췌 */
  excerpts: { text: string; where: string }[];
}
/** 호출자가 넘기는 함수. path → 값 (못 찾으면 그 키를 빼면 된다) */
export type LlmAsk = (req: LlmRequest) => Promise<Record<string, unknown>>;

/** 필드 이름과 관계있어 보이는 문단만 고른다 */
export function excerptsFor(doc: ExtractedDoc, fields: LlmField[], limit = 24): LlmRequest["excerpts"] {
  const words = /(이율|해지율|환급|납입|보험기간|만기|가입|연령|사업비|면제|공제|상품)/;
  const out: LlmRequest["excerpts"] = [];
  doc.paragraphs.forEach((p, i) => {
    if (out.length >= limit) return;
    if (p.length < 4 || p.length > 400) return;
    if (!words.test(p)) return;
    out.push({ text: p, where: `본문 ${i + 1}줄` });
  });
  doc.tables.forEach((t, ti) => {
    if (out.length >= limit + 8) return;
    const flat = [t.head.join(" | "), ...t.rows.slice(0, 6).map((r) => r.join(" | "))].join("\n");
    if (words.test(flat)) out.push({ text: flat.slice(0, 900), where: `표 ${ti + 1}` });
  });
  void fields;
  return out;
}

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) cur = (cur[parts[i]] ??= {}) as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
};
/** 모델이 {"rate":0.025}·{"value":20} 처럼 감싸 답하는 경우가 있어 한 겹 벗긴다 */
const unwrap = (v: unknown): unknown => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ["value", "rate", "amount", "years", "answer", "result"]) if (o[k] !== undefined) return o[k];
    const vals = Object.values(o);
    if (vals.length === 1) return vals[0];
  }
  return v;
};

const coerce = (kind: LlmField["kind"], raw: unknown): string | number | boolean | null => {
  const v = unwrap(raw);
  if (v === null || v === undefined || v === "") return null;
  if (kind === "bool") return v === true || v === "true" || v === "예";
  if (kind === "text") return String(v).slice(0, 120);
  const num = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(num)) return null;
  return kind === "int" ? Math.round(num) : num > 1 ? num / 100 : num;   // 2.5 로 오면 % 로 본 것
};

/** 규칙 결과에 LLM 결과를 덧댄다. 규칙이 이미 찾은 항목은 건드리지 않는다 */
export async function fillWithLlm(base: ParseResult, doc: ExtractedDoc, ask: LlmAsk): Promise<ParseResult> {
  const have = new Set(base.evidence.map((e) => e.path));
  const want = LLM_FIELDS.filter((f) => !have.has(f.path));
  if (!want.length) return base;
  let answers: Record<string, unknown> = {};
  try {
    answers = await ask({ fields: want, excerpts: excerptsFor(doc, want) });
  } catch (e) {
    return { ...base, warnings: [...base.warnings, `AI 보조 실패: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const spec: MethodSpec = JSON.parse(JSON.stringify(base.spec));
  const evidence: Evidence[] = [...base.evidence];
  const conf: Confidence = "low";
  for (const f of want) {
    const v = coerce(f.kind, answers[f.path]);
    if (v === null) continue;
    setPath(spec as unknown as Record<string, unknown>, f.path, v);
    const raw = typeof answers[f.path] === "object" ? JSON.stringify(answers[f.path]) : String(answers[f.path]);
    evidence.push({ path: f.path, label: f.label, value: v, raw, source: "AI 추정", confidence: conf });
  }
  const missing = base.missing.filter((m) => !want.some((f) => f.label === m && answers[f.path] !== undefined));
  return { spec, evidence, missing, warnings: base.warnings };
}

/** 서버 라우트가 그대로 쓸 프롬프트 — 모델을 바꿔도 이 문구만 옮기면 된다 */
export function buildPrompt(req: LlmRequest): string {
  const fields = req.fields.map((f) => `- ${f.path} (${f.label}, ${f.kind}): ${f.hint}`).join("\n");
  const body = req.excerpts.map((e) => `[${e.where}] ${e.text}`).join("\n");
  return [
    "너는 한국 보험 산출방법서를 읽는 계리 보조원이다.",
    "아래 발췌에서 요청한 항목만 찾아 JSON 객체 하나로만 답한다. 설명·코드펜스 금지.",
    "찾지 못한 항목은 키를 아예 넣지 마라. 추측해서 채우지 마라.",
    "비율은 소수로(2.5% → 0.025), 기간은 정수 년으로 답한다.",
    "", "## 찾을 항목", fields, "", "## 발췌", body,
  ].join("\n");
}
