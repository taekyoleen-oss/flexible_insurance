import type { DocTable, ExtractedDoc } from "./extract";
import { ExtractError, unbrace } from "./extract";

/**
 * PDF 텍스트 추출. Word·한글에서 "PDF 로 저장" 한 산출방법서를 올리는 길이다.
 *
 * PDF 에는 표 구조도 첨자도 없으므로 글자 좌표로 되살린다:
 *   1. 같은 y 끼리 묶어 줄을 만든다.
 *   2. 칸이 여럿인 줄이 이어지면 표 덩이로 보고, **덩이 안 모든 글자의 x 를 한데 모아 빈 띠(열 사이 여백)를 찾는다** —
 *      줄마다 따로 나누면 좁은 칸이 옆 칸에 붙고(기호+유형), 오른쪽 맞춘 칸은 줄마다 자리가 달라 열이 어긋난다(적용사업비율).
 *   3. 덩이 바로 위 줄이 그 열들에 걸치면 머리글로 끌어올린다 — 쪽마다 되풀이되는 별첨 위험률 표 머리글이 이것이다.
 *   4. 칸 안에서 줄바꿈된 줄(첫 칸이나 기호 칸이 빈 줄)은 윗줄에 이어 붙인다.
 *   5. 쪽이 바뀌어 머리글이 같으면 같은 표로 잇는다.
 *   6. 본문보다 작고 위·아래로 치우친 글자는 첨자다 — `l_{x+t}` · `v^{t+½}` · `Σ_{u=t}^{n−1}` 로 되살린다.
 *      Word 가 수식을 PDF 로 쓸 때 쓰는 수학 기울임 글자(𝑙 𝑥 𝛴)도 보통 글자로 되돌린다.
 *
 * pdfjs-dist 는 무겁기 때문에 이 파일에서만 동적 import 한다 — 다른 화면 번들에는 들어가지 않는다.
 */

interface Item { str: string; x: number; y: number; w: number; h: number }
interface Row { items: Item[]; y: number; low: number; loose: number }   // y = 줄의 위, low = 그 줄에서 가장 아래(첨자)

/** 절 제목 · 소제목 · 식 제목 · 덧붙임 — 앞 문단에 이어 붙이지 않는 줄 */
const STRUCTURAL = /^(※|\[식\]|\d+\.\s|[가-하]\.\s|\(\d+\)\s)/;

/** 표로 보기 위한 최소 열 수·줄 수 */
const MIN_COLS = 2, MIN_ROWS = 2;

/** 브라우저에서는 워커 경로가 있어야 한다. public/ 으로 복사해 둔 파일을 가리킨다(각 앱의 predev·prebuild 스크립트가 복사).
 *  Node(테스트)에서는 pdfjs 가 워커 파일을 직접 불러오므로 건드리지 않는다. */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

/** 수학 그리스 문자 한 벌의 칸 순서 (Α…Ω · ∇ · α…ω · ∂ · 변이형) */
const GREEK = [..."ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡϴΣΤΥΦΧΨΩ∇αβγδεζηθικλμνξοπρςστυφχψω∂ϵϑϰϕϱϖ"];

/** 수학 기울임 등(Mathematical Alphanumeric Symbols) → 보통 글자. Word 가 수식을 PDF 로 쓸 때 쓴다 */
export function plainMathLetters(s: string): string {
  if (!/[\u{1D400}-\u{1D7FF}]/u.test(s)) return s.replace(/∗/g, "*");
  const banks: [number, number][] = [
    [0x1D400, 0x41], [0x1D41A, 0x61], [0x1D434, 0x41], [0x1D44E, 0x61], [0x1D468, 0x41], [0x1D482, 0x61],
    [0x1D49C, 0x41], [0x1D4B6, 0x61], [0x1D504, 0x41], [0x1D51E, 0x61], [0x1D5A0, 0x41], [0x1D5BA, 0x61],
    [0x1D5D4, 0x41], [0x1D5EE, 0x61], [0x1D608, 0x41], [0x1D622, 0x61], [0x1D670, 0x41], [0x1D68A, 0x61],
  ];
  return [...s].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (c < 0x1D400 || c > 0x1D7FF) return ch;
    for (const [from, to] of banks) if (c >= from && c < from + 26) return String.fromCharCode(to + (c - from));
    if (c >= 0x1D7CE) return String.fromCharCode(0x30 + ((c - 0x1D7CE) % 10));            // 여러 벌의 숫자
    for (const from of [0x1D6A8, 0x1D6E2, 0x1D71C, 0x1D756, 0x1D790]) {                    // 그리스 문자 — 벌마다 58 칸
      if (c >= from && c < from + GREEK.length) return GREEK[c - from];
    }
    return ch;
  }).join("").replace(/∗/g, "*");
}

export async function extractPdf(buf: Uint8Array): Promise<ExtractedDoc> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
  const task = pdfjs.getDocument({ data: buf, useWorkerFetch: false, useSystemFonts: true });
  let doc;
  try { doc = await task.promise; }
  catch (e) { throw new ExtractError(`PDF 를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, "corrupt"); }

  const pages: Item[][] = [];
  let totalChars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      const t = it as { str?: string; transform?: number[]; width?: number; height?: number };
      const s = plainMathLetters((t.str ?? "").replace(/\s+/g, " "));
      if (!s.trim() || !t.transform) continue;
      items.push({ str: s, x: t.transform[4], y: t.transform[5], w: t.width ?? 0, h: t.height ?? 10 });
      totalChars += s.trim().length;
    }
    pages.push(items);
    page.cleanup();
  }
  await task.destroy();

  if (totalChars < 50) {
    throw new ExtractError(
      "글자가 거의 없는 PDF 입니다 — 스캔 이미지로 보입니다. 한글/워드에서 '인쇄 → PDF' 로 다시 저장하거나 DOCX·HWPX 로 올려 주세요.",
      "scanned");
  }
  // 먼저 줄마다 칸을 나눠 읽고(회사 산출방법서에 맞춘 방식), 표준 산출방법서면 열 경계를 맞춰 다시 읽는다
  let read = build(pages, false);
  if (/표준 산출방법서 v\d/.test([...read.paragraphs, ...read.tables.flatMap((t) => [...t.head, ...t.rows.flat()])].join(" "))) {
    read = build(pages, true);
  }
  const warnings = ["PDF 에는 표 구조가 없어 글자 위치로 표를 되살립니다. 병합 셀이 많은 표는 줄로만 나올 수 있습니다."];
  return { kind: "pdf", ...read, warnings };
}

/** 쪽마다 되살려 문단·표로. `grid` 면 표 열 경계를 덩이 전체로 맞춘다(표준 산출방법서) */
function build(pages: Item[][], grid: boolean): { paragraphs: string[]; tables: DocTable[] } {
  const paragraphs: string[] = [], tables: DocTable[] = [];
  for (const items of pages) {
    const { lines, tables: pageTables } = layout(items, grid);
    for (const l of lines) if (l.trim()) paragraphs.push(l.trim());
    for (const t of pageTables) {
      const prev = grid ? tables[tables.length - 1] : undefined;
      // 쪽이 바뀌어도 머리글이 같으면 한 표다 (별첨 위험률 표는 쪽마다 머리글을 되풀이한다)
      if (prev && prev.head.length === t.head.length) {
        if (prev.head.every((h, i) => h === t.head[i])) { prev.rows.push(...t.rows); continue; }
        // 한쪽 조각이 머리글을 잃었으면(값만 있거나 칸이 절반 넘게 빈 머리글) 머리글 있는 쪽을 머리글로 삼아 잇는다
        if (weakHead(prev.head) && !weakHead(t.head)) {
          if (numericRow(prev.head)) prev.rows.unshift([...prev.head]);        // 값 줄이면 줄로 살린다(줄바꿈된 머리글은 버린다)
          prev.head.splice(0, prev.head.length, ...t.head);
          prev.rows.push(...t.rows);
          continue;
        }
        if (weakHead(t.head) && !weakHead(prev.head)) { if (numericRow(t.head)) prev.rows.push([...t.head]); prev.rows.push(...t.rows); continue; }
      }
      tables.push(t);
    }
  }
  // 쪽마다 되풀이되는 표 머리글이 문단으로 새어 나온 것은 버린다(줄바꿈된 칸이 빠져 표의 머리글과 글자가 조금 다르다)
  const heads = tables.map((t) => t.head.join("").replace(/\s/g, "")).filter((h) => h.length >= 12);
  const leaked = (line: string) => {
    const k = line.replace(/\s/g, "");
    return k.length >= 12 && heads.some((h) => k.length >= h.length * 0.5 && subsequence(k, h));
  };
  return { paragraphs: grid ? paragraphs.filter((l) => !leaked(l)) : paragraphs, tables };
}

/** a 의 글자가 b 안에 순서대로 다 나오는지 */
function subsequence(a: string, b: string): boolean {
  let i = 0;
  for (const ch of b) if (ch === a[i] && ++i === a.length) return true;
  return i === a.length;
}

/** 글자 조각 → 줄, 그리고 이어지는 줄 → 표 */
function layout(items: Item[], grid = true): { lines: string[]; tables: DocTable[] } {
  if (!items.length) return { lines: [], tables: [] };
  const medH = median(items.map((i) => i.h)) || 10;
  const charW = charWidth(items);
  // 표준 양식은 첨자를 되살리므로 한 줄로 볼 범위를 넓게 — Word 가 낸 PDF 는 첨자를 본문 줄보다 훨씬 아래에 그린다
  const tol = Math.max(2, medH * (grid ? 1.1 : 0.6));

  const rows: Row[] = [];
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const last = rows[rows.length - 1];
    // 표준 양식은 줄에 이미 든 글자 가운데 가장 아래와 견준다 — 첨자가 본문보다 한참 아래 그려져도 같은 줄로 본다
    if (last && Math.abs((grid ? last.low : last.y) - it.y) <= tol) { last.items.push(it); last.low = Math.min(last.low, it.y); }
    else rows.push({ items: [it], y: it.y, low: it.y, loose: 0 });
  }
  // 칸 수는 표인지 가리는 데만 쓴다 — 예전 방식은 줄마다 글자 너비를 재어 나눴다(회사 산출방법서 PDF 가 그 결과에 맞춰져 있다)
  for (const r of rows) { r.items.sort((a, b) => a.x - b.x); r.loose = looseCells(r.items, grid ? charW : charWidth(r.items)); }

  const lines: string[] = [], tables: DocTable[] = [];
  const asLine = new Map<number, number>();          // 줄 번호 → 문단 번호 (머리글로 끌어올리면 그 문단을 지운다)
  const used = new Set<number>();
  let i = 0;
  while (i < rows.length) {
    if (used.has(i)) { i++; continue; }
    if (rows[i].loose >= MIN_COLS) {
      // 표 덩이 늘리기 — 칸 안에서 줄바꿈된 줄(그 표의 줄 간격보다 좁은 줄)은 칸이 하나라도 함께 들인다
      let j = i;
      const left = rows[i].items[0].x;
      const gaps: number[] = [];
      while (j + 1 < rows.length) {
        const gap = rows[j].y - rows[j + 1].y, med = gaps.length ? median(gaps) : 0;
        // 칸 안 줄바꿈 — 그 표의 줄 간격보다 좁고, 첫 칸(왼쪽 끝)에서 시작하지 않는 줄. 본문 문단은 왼쪽 끝에서 시작한다
        if (grid && med > 0 && gap < med * 0.92 && rows[j + 1].items[0].x > left + charW) { j++; continue; }
        if (rows[j + 1].loose < MIN_COLS) break;                   // 표 밖 문단
        if (grid ? med > 0 && gap > med * 1.8 : Math.abs(rows[j + 1].loose - rows[i].loose) > 1) break;
        gaps.push(gap); j++;
      }
      if (j - i + 1 >= MIN_ROWS) {
        // 바로 위 줄이 같은 열들에 걸치면 머리글로 끌어올린다 (쪽마다 되풀이되는 표 머리글)
        let from = i;
        if (grid && from - 1 >= 0 && !used.has(from - 1)) {
          const cols = columns(rows.slice(from, j + 1), charW);
          const above = rows[from - 1], text = render(above.items, medH, grid);
          const gapOk = gaps.length ? above.y - rows[from].y <= median(gaps) * 2.2 : true;
          // 제목 줄·문장(…다.)은 머리글이 아니다. 열마다 걸쳐 있는 줄만 끌어올린다
          if (gapOk && spread(above.items, cols) >= MIN_COLS && !STRUCTURAL.test(text) && !/[.다]$/.test(text)) {
            const li = asLine.get(from - 1);
            if (li !== undefined) lines[li] = "";      // 문단으로 내보냈던 줄이 표 머리글이 되었다
            from--;
          }
        }
        const block = rows.slice(from, j + 1);
        // 열 경계는 값 줄에서 찾는다 — 머리글은 칸 가운데 맞춤이라 좁은 열끼리 붙는다(기호+유형)
        const cells = grid
          ? toGrid(block, columns(block.length >= 3 ? block.slice(1) : block, charW), medH)
          : perRow(block, medH, charW);
        if (cells.length >= MIN_ROWS && cells[0].length >= MIN_COLS) {
          tables.push({ head: cells[0], rows: cells.slice(1) });
          for (let k = from; k <= j; k++) used.add(k);
          i = j + 1;
          continue;
        }
      }
    }
    const text = render(rows[i].items, medH, grid);
    // ※ 덧붙임은 여러 줄이어도 한 사항이다 — 이어진 줄(제목·식·다음 ※ 가 아닌 줄)을 붙인다
    const last = lines.length ? lines[lines.length - 1] : "";
    if (grid && /^※/.test(last) && !STRUCTURAL.test(text)) lines[lines.length - 1] = `${last} ${text}`;
    else { asLine.set(i, lines.length); lines.push(text); }
    i++;
  }
  return { lines, tables };
}

/** 값(숫자)만 있는 줄인지 — 쪽이 바뀌며 머리글을 잃은 조각을 가린다 */
/** 머리글을 잃은 조각인지 — 값만 있거나 칸이 절반 넘게 빈 줄 */
const weakHead = (r: string[]) => numericRow(r) || r.filter(Boolean).length * 2 <= r.length;

const numericRow = (r: string[]) => r.length >= 3 && r.every((c) => /^[\d.,%\s-]*$/.test(c)) && r.some((c) => /\d/.test(c));

/** 예전 방식 — 줄마다 x 간격으로 칸을 나누고 머리글 열 수에 맞춘다 (회사 산출방법서 PDF 는 이렇게 읽어 왔다) */
function perRow(block: Row[], medH: number, charW: number): string[][] {
  const split = (row: Item[]): string[] => {
    const gap = charW * 3;
    const groups: Item[][] = [[row[0]]];
    let end = row[0].x + row[0].w;
    for (let i = 1; i < row.length; i++) {
      if (row[i].x - end > gap) groups.push([row[i]]);
      else groups[groups.length - 1].push(row[i]);
      end = row[i].x + row[i].w;
    }
    const out = groups.map((g) => render(g, medH, false));
    return out.filter((c, i, a) => c !== "" || i < a.length - 1);
  };
  const n = split(block[0].items).length;
  return block.map((r) => { const c = split(r.items); while (c.length < n) c.push(""); return c.slice(0, n); });
}

/** 글자 하나의 너비 */
const charWidth = (items: Item[]) => median(items.map((i) => (i.w || 6) / Math.max(1, [...i.str].length))) || 6;

/** 그 줄이 몇 칸으로 보이는지 — 표인지 가리는 데만 쓴다(열 경계는 덩이 전체로 정한다) */
function looseCells(row: Item[], charW: number): number {
  let n = 1, end = row[0].x + row[0].w;
  for (let i = 1; i < row.length; i++) {
    if (row[i].x - end > charW * 3) n++;
    end = row[i].x + row[i].w;
  }
  return n;
}

/** 덩이 안 모든 글자의 x 를 한데 모아 열 경계(빈 띠)를 찾는다 */
function columns(block: Row[], charW: number): [number, number][] {
  const spans = block.flatMap((r) => r.items.map((i) => [i.x, i.x + (i.w || charW)] as [number, number])).sort((a, b) => a[0] - b[0]);
  const gap = charW * 1.2;
  const out: [number, number][] = [];
  for (const [x0, x1] of spans) {
    const last = out[out.length - 1];
    if (last && x0 - last[1] <= gap) last[1] = Math.max(last[1], x1);
    else out.push([x0, x1]);
  }
  return out;
}

/** 그 줄의 글자가 몇 개 열에 걸치는지 */
function spread(items: Item[], cols: [number, number][]): number {
  const hit = new Set<number>();
  for (const it of items) hit.add(colOf(it, cols));
  return hit.size;
}

const colOf = (it: Item, cols: [number, number][]): number => {
  const c = it.x + (it.w || 0) / 2;
  let best = 0, dist = Infinity;
  cols.forEach(([x0, x1], k) => {
    const d = c < x0 ? x0 - c : c > x1 ? c - x1 : 0;
    if (d < dist) { dist = d; best = k; }
  });
  return best;
};

/** 줄 × 열 → 글자 표. 칸 안에서 줄바꿈된 줄은 윗줄에 이어 붙인다 */
function toGrid(block: Row[], cols: [number, number][], medH: number): string[][] {
  const out: string[][] = [];
  for (const row of block) {
    const bins: Item[][] = cols.map(() => []);
    for (const it of row.items) bins[colOf(it, cols)].push(it);
    const line = bins.map((g) => (g.length ? render(g, medH, true) : ""));
    // 칸 안에서 줄바꿈된 줄 — 값이 덜 찼고 첫 칸이나 둘째 칸이 빈 줄은 윗줄에 이어 붙인다
    if (out.length && line.filter(Boolean).length < cols.length && (!line[0] || !line[1])) {
      const prev = out[out.length - 1];
      line.forEach((t, c) => { if (t) prev[c] = prev[c] ? `${prev[c]} ${t}` : t; });
      continue;
    }
    out.push(line);
  }
  return out;
}

/** 글자 조각 → 글. `scripts` 면 본문보다 작고 위·아래로 치우친 글자를 첨자로 되살린다(Σ 처럼 위아래 둘 다면 `_{…}^{…}`).
 *  회사 산출방법서는 첨자를 되살리지 않는다 — α₁ 을 `α1` 로 읽어 온 것이 그 문서들의 기호다 */
function render(g: Item[], medH: number, scripts: boolean): string {
  const space = scripts ? medH * 0.3 : 1;
  const base = median(g.filter((i) => i.h >= medH * 0.9).map((i) => i.y));
  const kind = (it: Item): "sub" | "sup" | "" => {
    if (!scripts || !base || it.h >= medH * 0.85) return "";
    if (it.y < base - medH * 0.08) return "sub";
    if (it.y > base + medH * 0.08) return "sup";
    return "";
  };
  let s = "", i = 0, end = g[0].x;
  while (i < g.length) {
    if (!kind(g[i])) { s += (g[i].x - end > space ? " " : "") + g[i].str; end = g[i].x + g[i].w; i++; continue; }
    let j = i;
    while (j < g.length && kind(g[j])) j++;
    const run = g.slice(i, j);
    const sub = run.filter((it) => kind(it) === "sub").map((it) => it.str).join("").trim();
    const sup = run.filter((it) => kind(it) === "sup").map((it) => it.str).join("").trim();
    if (sub) s += `_{${sub}}`;
    if (sup) s += `^{${sup}}`;
    end = run[run.length - 1].x + run[run.length - 1].w;
    i = j;
  }
  return unbrace(s).replace(/\s+/g, " ").trim();
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
