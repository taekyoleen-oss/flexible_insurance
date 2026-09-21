import type { DocTable, ExtractedDoc } from "./extract";
import { ExtractError } from "./extract";

/**
 * PDF 텍스트 추출. HWP 를 PDF 로 변환해 올리는 경로를 위해 쓴다.
 *
 * PDF 에는 표 구조가 없으므로 글자 좌표로 표를 되살린다:
 *   같은 y(줄) 끼리 묶고 → x 간격이 벌어지는 곳에서 열을 나눈다 → 열 수가 같은 줄이 이어지면 표로 본다.
 * 사업비 표처럼 칸이 또렷한 표는 이 방식으로 잘 잡히고, 병합 셀이 많은 표는 줄만 남는다.
 *
 * pdfjs-dist 는 무겁기 때문에 이 파일에서만 동적 import 한다 — 다른 화면 번들에는 들어가지 않는다.
 */

interface Item { str: string; x: number; y: number; w: number; h: number }

/** 표로 보기 위한 최소 열 수·줄 수 */
const MIN_COLS = 2, MIN_ROWS = 2;

/** 브라우저에서는 워커 경로가 있어야 한다. public/ 으로 복사해 둔 파일을 가리킨다(각 앱의 predev·prebuild 스크립트가 복사).
 *  Node(테스트)에서는 pdfjs 가 워커 파일을 직접 불러오므로 건드리지 않는다. */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

export async function extractPdf(buf: Uint8Array): Promise<ExtractedDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
  const task = pdfjs.getDocument({ data: buf, useWorkerFetch: false, useSystemFonts: true });
  let doc;
  try { doc = await task.promise; }
  catch (e) { throw new ExtractError(`PDF 를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, "corrupt"); }

  const paragraphs: string[] = [], tables: DocTable[] = [];
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      const t = it as { str?: string; transform?: number[]; width?: number; height?: number };
      const s = (t.str ?? "").replace(/\s+/g, " ");
      if (!s.trim() || !t.transform) continue;
      items.push({ str: s, x: t.transform[4], y: t.transform[5], w: t.width ?? 0, h: t.height ?? 10 });
      totalChars += s.trim().length;
    }
    const { lines, tables: pageTables } = layout(items);
    for (const l of lines) if (l.trim()) paragraphs.push(l.trim());
    tables.push(...pageTables);
    page.cleanup();
  }
  await task.destroy();

  if (totalChars < 50) {
    throw new ExtractError(
      "글자가 거의 없는 PDF 입니다 — 스캔 이미지로 보입니다. 한글/워드에서 '인쇄 → PDF' 로 다시 저장하거나 DOCX·HWPX 로 올려 주세요.",
      "scanned");
  }
  const warnings = ["PDF 에는 표 구조가 없어 글자 위치로 표를 되살립니다. 병합 셀이 많은 표는 줄로만 나올 수 있습니다."];
  return { kind: "pdf", paragraphs, tables, warnings };
}

/** 글자 조각 → 줄, 그리고 열이 맞는 연속 줄 → 표 */
function layout(items: Item[]): { lines: string[]; tables: DocTable[] } {
  if (!items.length) return { lines: [], tables: [] };
  const tol = Math.max(2, median(items.map((i) => i.h)) * 0.6);
  // y 내림차순(위 → 아래)으로 줄 묶기
  const rows: Item[][] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last[0].y - it.y) <= tol) last.push(it);
    else rows.push([it]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);

  // 각 줄을 x 간격으로 칸 나누기 — 평균 글자폭의 2배 이상 벌어지면 다른 칸
  const cellsOf = (row: Item[]): string[] => {
    const gap = Math.max(6, median(row.map((i) => (i.w || 6) / Math.max(1, i.str.length))) * 3);
    const out: string[] = [];
    let cur = row[0].str, end = row[0].x + row[0].w;
    for (let i = 1; i < row.length; i++) {
      const it = row[i];
      if (it.x - end > gap) { out.push(cur.trim()); cur = it.str; }
      else cur += (it.x - end > 1 ? " " : "") + it.str;
      end = it.x + it.w;
    }
    out.push(cur.trim());
    return out.filter((c, i, a) => c !== "" || i < a.length - 1);
  };

  const cells = rows.map(cellsOf);
  const lines: string[] = [], tables: DocTable[] = [];
  let i = 0;
  while (i < cells.length) {
    const n = cells[i].length;
    if (n >= MIN_COLS) {
      let j = i;
      while (j + 1 < cells.length && Math.abs(cells[j + 1].length - n) <= 1 && cells[j + 1].length >= MIN_COLS) j++;
      if (j - i + 1 >= MIN_ROWS) {
        const block = cells.slice(i, j + 1).map((r) => { const c = [...r]; while (c.length < n) c.push(""); return c.slice(0, n); });
        tables.push({ head: block[0], rows: block.slice(1) });
        i = j + 1;
        continue;
      }
    }
    lines.push(cells[i].join(" "));
    i++;
  }
  return { lines, tables };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
