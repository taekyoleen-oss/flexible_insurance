import type { DocTable, ExtractedDoc } from "./extract";

/**
 * 스캔 PDF·그림 → 문단·표. 모델은 쪽 그림을 **옮겨 적기만** 하고, 조건은 parseMethodDoc 규칙이 읽는다 —
 * 단위 해석(2.5% → 0.025)·배수 판단(α_P)을 모델에 맡기지 않는다. 글자 있는 문서와 같은 길을 타므로
 * 표준 산출방법서를 스캔한 것도 [식]·※ 까지 읽힌다.
 *
 * 앱에 딸리지 않는다(import 는 이 폴더의 형식뿐). 실제 호출은 호출자가 VisionAsk 로 넘긴다 —
 * 이 앱은 브라우저에서 사용자 키로, 다른 앱은 서버 라우트로.
 */

export interface PageBlock {
  /** text 문단 한 줄 · formula 식 한 줄 · table 표 */
  kind: "text" | "formula" | "table";
  text: string;
  /** table 일 때 행 × 칸 (첫 행이 머리글). 병합 칸은 첫 칸에만 쓰고 나머지는 "" */
  rows: string[][];
}
export interface PageText { blocks: PageBlock[]; unreadable: string }
export interface PageImage { page: number; mediaType: "image/png" | "image/jpeg"; base64: string; width: number; height: number }
/** 쪽 그림 하나를 보내고 PAGE_SCHEMA 모양의 JSON 을 돌려받는 함수 */
export type VisionAsk = (img: PageImage, signal?: AbortSignal) => Promise<unknown>;

/** 구조화 출력(output_config.format)의 JSON Schema — 모든 칸 required, additionalProperties false */
export const PAGE_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["text", "formula", "table"] },
          text: { type: "string" },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["kind", "text", "rows"],
        additionalProperties: false,
      },
    },
    unreadable: { type: "string" },
  },
  required: ["blocks", "unreadable"],
  additionalProperties: false,
} as const;

export const VISION_SYSTEM = `You transcribe one page image of a Korean life-insurance actuarial document (보험료 및 책임준비금 산출방법서, 사업방법서) into structured text. Another program interprets the text afterwards, so transcribe exactly — never interpret, summarize, compute, translate, correct or reorder.

- Go top to bottom in reading order. Keep the original wording, numbers, units, symbols and numbering exactly as printed ("연 2.75% 복리", "8/1,000", "1.1.", "가.", "※").
- Each paragraph or list item is one "text" block (text = the line, rows = []). Join lines that the page layout wrapped in the middle of a sentence.
- Each table is one "table" block (text = "", rows = every row including the header row, one string per cell). For merged cells write the value in the first cell and "" in the cells it covers.
- Each line of a mathematical formula is one "formula" block written in plain linear notation: subscripts _{…}, superscripts ^{…}, × and · for products, (a)/(b) for fractions, Σ_{…}^{…} for sums, Greek letters as characters (α β γ), primes as ′.
- Skip running headers, footers, page numbers and watermarks.
- If part of the page cannot be read, do not guess: leave it out and describe where in "unreadable" (otherwise "").`;

/** 받은 JSON 이 모양에 맞는지 — 구조화 출력이 보장해도 거절·잘림이 있을 수 있어 늘 확인한다 */
export function readPage(raw: unknown): PageText {
  const o = raw as Partial<PageText> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.blocks)) throw new Error("쪽 결과의 모양이 맞지 않습니다 (blocks 없음)");
  const blocks = o.blocks.flatMap((b): PageBlock[] => {
    if (!b || typeof b !== "object") return [];
    const kind = b.kind === "table" || b.kind === "formula" ? b.kind : "text";
    const rows = Array.isArray(b.rows) ? b.rows.filter(Array.isArray).map((r) => r.map((c) => (typeof c === "string" ? c : String(c ?? "")))) : [];
    const text = typeof b.text === "string" ? b.text : "";
    return kind === "table" ? (rows.length ? [{ kind, text: "", rows }] : []) : text.trim() ? [{ kind, text, rows: [] }] : [];
  });
  return { blocks, unreadable: typeof o.unreadable === "string" ? o.unreadable : "" };
}

/** 쪽마다 옮겨 적은 글 → 추출 문서 (DOCX 처럼 문단 목록과 표 목록) */
export function pagesToDoc(pages: { page: number; text: PageText }[]): ExtractedDoc {
  const paragraphs: string[] = [], tables: DocTable[] = [], warnings: string[] = [];
  for (const { page, text } of pages) {
    for (const b of text.blocks) {
      if (b.kind === "table") {
        const width = Math.max(...b.rows.map((r) => r.length));
        const rows = b.rows.map((r) => [...r.map((c) => c.replace(/\s+/g, " ").trim()), ...Array(width - r.length).fill("")]);
        tables.push({ head: rows[0], rows: rows.slice(1) });
      } else for (const line of b.text.split("\n")) if (line.trim()) paragraphs.push(line.replace(/\s+/g, " ").trim());
    }
    if (text.unreadable.trim()) warnings.push(`${page}쪽 읽지 못한 곳: ${text.unreadable.trim()}`);
  }
  warnings.push(`그림 ${pages.length}쪽을 AI 로 옮겨 적은 글에서 읽었습니다 — 값을 원문 그림과 대조하세요.`);
  return { kind: "vision", paragraphs, tables, warnings };
}

/** 쪽들을 차례로(동시에 몇 개씩) 옮겨 적는다. 쪽 순서는 지킨다 */
export async function transcribe(images: PageImage[], ask: VisionAsk, opt: { concurrency?: number; signal?: AbortSignal; onPage?: (done: number) => void } = {}): Promise<ExtractedDoc> {
  const out: { page: number; text: PageText }[] = new Array(images.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < images.length) {
      const i = next++;
      if (opt.signal?.aborted) throw new Error("취소했습니다");
      out[i] = { page: images[i].page, text: readPage(await ask(images[i], opt.signal)) };
      opt.onPage?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opt.concurrency ?? 3, images.length) }, worker));
  return pagesToDoc(out);
}

/**
 * 비용 어림(달러). 그림 토큰 ≈ 가로×세로/750 (쪽당 최대 약 4,800), 출력은 쪽당 약 2,000 토큰(옮겨 적은 글 + 생각).
 * 값은 claude-opus-5 기준 입력 $5 · 출력 $25 / 100만 토큰 — 실제는 응답의 usage 로 확인한다.
 */
export const PRICE = { input: 5 / 1e6, output: 25 / 1e6 };
export function estimate(pages: { width: number; height: number }[]): { tokens: number; usd: number } {
  const input = pages.reduce((s, p) => s + Math.min(Math.round((p.width * p.height) / 750), 4800) + 400, 0);
  const output = pages.length * 2000;
  return { tokens: input + output, usd: input * PRICE.input + output * PRICE.output };
}
