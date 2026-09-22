/**
 * 산출방법서 파일 → 문단 + 표.
 *
 * 앱에 딸리지 않는다. 새 의존성도 없다 — ZIP 은 브라우저·Node 에 다 있는 DecompressionStream
 * ("deflate-raw")으로 풀고, HWP(OLE2 복합문서)는 직접 읽는다. XLSX 만 호출부가 파서를 넘긴다
 * (이 저장소는 SheetJS 가 이미 있어서 adapter 에서 주입한다).
 *
 * 지원: .docx  .hwpx  .hwp(5.x, DRM 없음)  .pdf(텍스트 레이어)  .txt/.md/.csv  · XLSX 는 주입형
 * 못 읽는 것: DRM 걸린 파일, 텍스트 레이어 없는 스캔 PDF, 구형 HWP 3.0 — 모두 why 로 이유를 돌려준다
 */

export interface DocTable { head: string[]; rows: string[][] }
export interface ExtractedDoc {
  kind: string;                 // docx · hwp · hwpx · text · xlsx
  paragraphs: string[];
  tables: DocTable[];
  warnings: string[];
}
export class ExtractError extends Error {
  constructor(message: string, readonly why: "drm" | "scanned" | "unsupported" | "corrupt") { super(message); }
}

const dec = (b: Uint8Array, enc = "utf-8") => new TextDecoder(enc).decode(b);
const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** 사내 DRM("DOCUMENT SAFER" 등)으로 잠긴 파일인지 */
export function drmSignature(buf: Uint8Array): string | null {
  const head = dec(buf.subarray(0, 64), "latin1");
  if (head.startsWith("<DOCUMENT SAFER")) return head.slice(0, head.indexOf(">") + 1);
  if (head.includes("DRM") && head.charCodeAt(0) === 0x3c) return head.slice(0, 32);
  return null;
}

// ── ZIP ──────────────────────────────────────────────────────────────────────
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const out = new Response(new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

/** 중앙 디렉터리만 읽는 최소 ZIP 리더 */
export async function unzip(buf: Uint8Array): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExtractError("ZIP 구조를 찾지 못했습니다", "corrupt");
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) break;
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), cmtLen = u16(buf, p + 32);
    const lho = u32(buf, p + 42);
    const name = dec(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + cmtLen;
    if (u32(buf, lho) !== 0x04034b50) continue;
    const lNameLen = u16(buf, lho + 26), lExtraLen = u16(buf, lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    out.set(name, method === 0 ? raw : await inflateRaw(raw));
  }
  return out;
}

// ── XML ──────────────────────────────────────────────────────────────────────
const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const tagsOf = (xml: string, tag: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

/**
 * Word 에서 적은 식을 평문 표기로 — 수식 편집기(OMML)의 아래·위첨자·분수·Σ, 그리고 글자 서식의 아래·위첨자(Ctrl+=).
 * 태그를 지우기 전에 표기를 끼워 넣는다: l_{x+t+1}, v^{t}, (a)/(b).
 */
export function wordMath(xml: string): string {
  // 서식 첨자: Word 는 한 첨자를 여러 런으로 쪼개곤 한다 — 표지(\u0005 여는, \u0006·\u0007 닫는)를 달아 이웃 런끼리 잇고 괄호로 바꾼다
  let s = xml.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:vertAlign w:val="(subscript|superscript)"\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g,
    (run, v: string) => run.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, v === "subscript" ? "$1_\u0005$2\u0006$3" : "$1^\u0005$2\u0007$3"))
    .replace(/\u0006((?:<[^>]*>)*)_\u0005/g, "$1").replace(/\u0007((?:<[^>]*>)*)\^\u0005/g, "$1")
    .replace(/\u0005/g, "{").replace(/[\u0006\u0007]/g, "}");
  if (s.includes("<m:")) s = s
    .replace(/<m:chr m:val="([^"]*)"\/>/g, "$1")
    .replace(/<m:dPr>[\s\S]*?<\/m:dPr>/g, "")
    .replace(/<m:sub>/g, "_{").replace(/<\/m:sub>/g, "}").replace(/<m:sup>/g, "^{").replace(/<\/m:sup>/g, "}")
    .replace(/<m:num>/g, "(").replace(/<\/m:num>/g, ")/").replace(/<m:den>/g, "(").replace(/<\/m:den>/g, ")")
    .replace(/<m:d>/g, "(").replace(/<\/m:d>/g, ")");
  return s;
}

/**
 * 한글 수식 편집기 스크립트 → 평문 표기.
 * 사람이 적은 모양("l _{x+t+1} = l _{x+t} TIMES LEFT ( 1 - q _{x+t} RIGHT )")도, 한글이 Word 수식을 받아 만든 모양
 * ("{{l}} _  {{x}{+}{t}{+}{1}} {~=~} {"해약공제"} …" — 글자마다 묶음, 한글은 따옴표)도 읽는다.
 */
const HWP_EQ: [RegExp, string][] = [
  [/"([^"]*)"/g, "$1"],
  [/\{((?:[^{}]|\{[^{}]*\})*)\}\s*over\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g, "($1)/($2)"], [/\b(LEFT|RIGHT|rm|it|bold)\b\s*/g, ""], [/[`~]/g, " "],
  [/\bTIMES\b/gi, "×"], [/\bCDOT\b/gi, "·"], [/\bSUM\b/gi, "Σ"], [/\bprime\b/gi, "′"], [/>=|\bgeq?\b/gi, "≥"], [/<=|\bleq?\b/gi, "≤"],
  [/\balpha\b/g, "α"], [/\bbeta\b/g, "β"], [/\bgamma\b/g, "γ"], [/\bdelta\b/g, "δ"], [/\btheta\b/g, "θ"], [/\bomega\b/g, "ω"],
  [/\s+([_^′])/g, "$1"],
];
export function hwpEquation(script: string): string {
  let s = HWP_EQ.reduce((t, [re, to]) => t.replace(re, to), script);
  // 첨자 자리(_ ^ 바로 뒤)가 아닌 묶음은 벗긴다 — 안쪽부터, 더 벗길 게 없을 때까지
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/(^|[^_^])\{([^{}]*)\}/g, "$1$2"); }
  return s.replace(/\s+/g, " ").trim();
}

/** 수식에서 되돌린 표기의 한 토막 묶음은 중괄호를 뗀다 — α_{S} → α_S, v^{t} → v^t (이 모듈의 평문 표기와 같게) */
export const unbrace = (s: string) => s.replace(/([_^])\{([A-Za-z0-9가-힣α-ωΑ-Ω′'*]+)\}/g, "$1$2");

/** 한글 글자 모양 중 아래·위첨자인 것 (header.xml 의 hh:charPr id) */
function hwpScripts(header: string): { sub: Set<string>; sup: Set<string> } {
  const sub = new Set<string>(), sup = new Set<string>();
  for (const m of header.matchAll(/<hh:charPr\b[^>]*\bid="(\d+)"[^>]*>([\s\S]*?)<\/hh:charPr>/g)) {
    if (/<hh:subscript\b/.test(m[2])) sub.add(m[1]);
    if (/<hh:(supscript|superscript)\b/.test(m[2])) sup.add(m[1]);
  }
  return { sub, sup };
}

/**
 * 한글 문단 하나의 글 — 글자(hp:t)와 수식 편집기 식(hp:script)을 순서대로.
 * 첨자 모양 글자는 평문 표기로(q + 아래첨자 x → q_x). 한 첨자가 여러 런으로 쪼개지면 잇는다.
 */
function hwpText(xml: string, cs: { sub: Set<string>; sup: Set<string> }): string {
  let out = "";
  for (const r of xml.matchAll(/<hp:run\b([^>]*?)(?:\/>|>([\s\S]*?)<\/hp:run>)/g)) {
    const id = /charPrIDRef="(\d+)"/.exec(r[1])?.[1] ?? "";
    const mark = cs.sub.has(id) ? ["_\u0005", "\u0006"] : cs.sup.has(id) ? ["^\u0005", "\u0007"] : ["", ""];
    for (const m of (r[2] ?? "").matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:script(?:\s[^>]*)?>([\s\S]*?)<\/hp:script>/g)) {
      if (m[1] !== undefined) { const t = strip(m[1]); if (t) out += mark[0] + t + mark[1]; }
      else out += ` ${hwpEquation(strip(m[2]))} `;
    }
  }
  out = out.replace(/\u0006_\u0005/g, "").replace(/\u0007\^\u0005/g, "").replace(/\u0005/g, "{").replace(/[\u0006\u0007]/g, "}");
  return unbrace(out.replace(/\s+/g, " ").trim());
}

/** DOCX — 문단(w:p)과 표(w:tbl) */
export async function extractDocx(buf: Uint8Array): Promise<ExtractedDoc> {
  const zip = await unzip(buf);
  const doc = zip.get("word/document.xml");
  if (!doc) throw new ExtractError("word/document.xml 이 없습니다 — DOCX 가 아닙니다", "corrupt");
  const xml = wordMath(dec(doc));
  const body = xml.slice(xml.indexOf("<w:body"));
  const tables: DocTable[] = [];
  for (const tbl of tagsOf(body, "w:tbl")) {
    const rows = tagsOf(tbl, "w:tr").map((tr) => tagsOf(tr, "w:tc").map((tc) => unbrace(tagsOf(tc, "w:p").map(strip).filter(Boolean).join(" "))));
    if (rows.length) tables.push({ head: rows[0], rows: rows.slice(1) });
  }
  // 표 안 문단이 본문에 섞이지 않게 표를 먼저 걷어낸다
  const paragraphs = tagsOf(body.replace(/<w:tbl[\s\S]*?<\/w:tbl>/g, ""), "w:p").map((x) => unbrace(strip(x))).filter(Boolean);
  return { kind: "docx", paragraphs, tables, warnings: [] };
}

/** HWPX — 한글 2014 이후 XML 형식 */
export async function extractHwpx(buf: Uint8Array): Promise<ExtractedDoc> {
  const zip = await unzip(buf);
  const parts = [...zip.keys()].filter((k) => /^Contents\/section\d+\.xml$/i.test(k)).sort();
  if (!parts.length) throw new ExtractError("Contents/section*.xml 이 없습니다 — HWPX 가 아닙니다", "corrupt");
  const paragraphs: string[] = [], tables: DocTable[] = [];
  const cs = hwpScripts(zip.has("Contents/header.xml") ? dec(zip.get("Contents/header.xml")!) : "");
  for (const k of parts) {
    const xml = dec(zip.get(k)!);
    for (const tbl of tagsOf(xml, "hp:tbl")) {
      const rows = tagsOf(tbl, "hp:tr").map((tr) => tagsOf(tr, "hp:tc").map((tc) => tagsOf(tc, "hp:p").map((x) => hwpText(x, cs)).filter(Boolean).join(" ")));
      if (rows.length) tables.push({ head: rows[0], rows: rows.slice(1) });
    }
    for (const p of tagsOf(xml.replace(/<hp:tbl[\s\S]*?<\/hp:tbl>/g, ""), "hp:p")) {
      const t = hwpText(p, cs);
      if (t) paragraphs.push(t);
    }
  }
  return { kind: "hwpx", paragraphs, tables, warnings: [] };
}

// ── HWP 5.x (OLE2) ───────────────────────────────────────────────────────────
interface CfbEntry { name: string; type: number; start: number; size: number; child: number; left: number; right: number }

/** OLE2 복합문서에서 스트림을 꺼낸다(최소 구현) */
function readCfb(buf: Uint8Array): Map<string, Uint8Array> {
  if (u32(buf, 0) !== 0xe011cfd0 || u32(buf, 4) !== 0xe11ab1a1) throw new ExtractError("OLE2 문서가 아닙니다", "corrupt");
  const sectorShift = u16(buf, 30), miniShift = u16(buf, 32);
  const sectorSize = 1 << sectorShift, miniSize = 1 << miniShift;
  const sec = (i: number) => buf.subarray(512 + i * sectorSize, 512 + (i + 1) * sectorSize);

  // FAT
  const difatCount = u32(buf, 72);
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const v = u32(buf, 76 + i * 4); if (v <= 0xfffffffa) fatSectors.push(v); }
  let difat = u32(buf, 68);
  for (let n = 0; n < difatCount && difat <= 0xfffffffa; n++) {
    const s = sec(difat);
    for (let i = 0; i < sectorSize / 4 - 1; i++) { const v = u32(s, i * 4); if (v <= 0xfffffffa) fatSectors.push(v); }
    difat = u32(s, sectorSize - 4);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) { const s = sec(fs); for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(s, i * 4)); }
  const chain = (start: number, limit = fat.length + 8) => {
    const out: number[] = [];
    for (let i = start, n = 0; i <= 0xfffffffa && n < limit; i = fat[i], n++) out.push(i);
    return out;
  };
  const readChain = (start: number, size: number) => {
    const parts = chain(start).map(sec);
    const all = new Uint8Array(parts.length * sectorSize);
    parts.forEach((p, i) => all.set(p, i * sectorSize));
    return all.subarray(0, size || all.length);
  };

  // 디렉터리
  const dirSectors = chain(u32(buf, 48));
  const entries: CfbEntry[] = [];
  for (const ds of dirSectors) {
    const s = sec(ds);
    for (let i = 0; i + 128 <= sectorSize; i += 128) {
      const nameLen = u16(s, i + 64);
      if (nameLen < 2) { entries.push({ name: "", type: 0, start: 0, size: 0, child: -1, left: -1, right: -1 }); continue; }
      const name = dec(s.subarray(i, i + nameLen - 2), "utf-16le");
      entries.push({ name, type: s[i + 66], start: u32(s, i + 116), size: u32(s, i + 120),
        left: u32(s, i + 68), right: u32(s, i + 72), child: u32(s, i + 76) });
    }
  }
  // 미니 스트림
  const root = entries[0];
  const mini = root && root.size ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatSectors = chain(u32(buf, 60));
  const miniFat: number[] = [];
  for (const ms of miniFatSectors) { const s = sec(ms); for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(s, i * 4)); }
  const readMini = (start: number, size: number) => {
    const out = new Uint8Array(size);
    let at = 0;
    for (let i = start, n = 0; i <= 0xfffffffa && at < size && n < miniFat.length + 8; i = miniFat[i], n++) {
      const part = mini.subarray(i * miniSize, (i + 1) * miniSize);
      out.set(part.subarray(0, Math.min(miniSize, size - at)), at);
      at += miniSize;
    }
    return out;
  };

  // 이름 → 데이터 (트리 순회: 경로는 "부모/이름")
  const out = new Map<string, Uint8Array>();
  const walk = (idx: number, prefix: string) => {
    if (idx < 0 || idx >= entries.length) return;
    const e = entries[idx];
    if (!e.name) return;
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.type === 2) out.set(path, e.size < 4096 ? readMini(e.start, e.size) : readChain(e.start, e.size));
    if (e.type === 1 || e.type === 5) walk(e.child, e.type === 5 ? "" : path);
    walk(e.left, prefix); walk(e.right, prefix);
  };
  walk(0, "");
  return out;
}

/** HWP 5.x 본문 — 문단 텍스트 레코드(tag 67)만 뽑는다. 수식·그림은 자리표시자로 남는다 */
export async function extractHwp(buf: Uint8Array): Promise<ExtractedDoc> {
  const streams = readCfb(buf);
  const header = streams.get("FileHeader");
  if (!header) throw new ExtractError("FileHeader 가 없습니다 — HWP 5.x 가 아닙니다", "corrupt");
  const flags = header[36];
  if (flags & 0x2) throw new ExtractError("암호가 걸린 HWP 입니다 — 해제본으로 올려 주세요", "drm");
  const compressed = !!(flags & 0x1);
  const names = [...streams.keys()].filter((k) => /BodyText\/Section\d+/i.test(k))
    .sort((a, b) => Number(a.match(/(\d+)$/)?.[1] ?? 0) - Number(b.match(/(\d+)$/)?.[1] ?? 0));
  if (!names.length) throw new ExtractError("BodyText 가 없습니다", "corrupt");

  const paragraphs: string[] = [];
  let equations = 0;
  for (const n of names) {
    let d = streams.get(n)!;
    if (compressed) d = await inflateRaw(d);
    let i = 0;
    while (i + 4 <= d.length) {
      const h = u32(d, i);
      const tag = h & 0x3ff;
      let size = (h >> 20) & 0xfff;
      i += 4;
      if (size === 0xfff) { size = u32(d, i); i += 4; }
      if (tag === 67) {
        let t = dec(d.subarray(i, i + size), "utf-16le");
        // 제어문자(수식·표·그림 객체)는 자리표시자로 바꾼다
        const before = t.length;
        t = t.replace(/[ -\ud800-\udfff-怀-鿿]/g, (c) => (c.charCodeAt(0) >= 0x6000 ? "[수식]" : " "));
        if (t.includes("[수식]")) equations++;
        void before;
        const line = t.replace(/\s+/g, " ").trim();
        if (line) paragraphs.push(line);
      }
      i += size;
    }
  }
  const warnings = equations ? [`수식 객체 ${equations}곳은 텍스트로 나오지 않아 [수식]으로 표시했습니다. 수식은 자동 인식 대상이 아닙니다.`] : [];
  return { kind: "hwp", paragraphs, tables: [], warnings };
}

/**
 * 텍스트·CSV·Markdown.
 * Markdown 파이프 표(`| a | b |` 다음 줄에 `|---|---|`)는 표로 되살린다 —
 * 이 앱이 낸 산출방법서를 다시 읽어 들이는 왕복이 표까지 이어지도록.
 */
export function extractText(buf: Uint8Array): ExtractedDoc {
  const lines = dec(buf).replace(/\r\n/g, "\n").split("\n").map((x) => x.trim());
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  const isRow = (l: string) => l.startsWith("|") && l.endsWith("|") && l.length > 2;
  const isRule = (l: string) => isRow(l) && cells(l).every((c) => /^:?-{2,}:?$/.test(c));
  const paragraphs: string[] = [];
  const tables: DocTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (isRow(l) && isRule(lines[i + 1] ?? "")) {
      const head = cells(l);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && isRow(lines[j]) && !isRule(lines[j]); j++) rows.push(cells(lines[j]));
      tables.push({ head, rows });
      // 표 안의 글자도 본문 규칙이 볼 수 있게 줄로도 남긴다
      for (const r of [head, ...rows]) paragraphs.push(r.filter(Boolean).join(" "));
      i = j - 1;
      continue;
    }
    paragraphs.push(l.replace(/^(#{1,6}|>)\s+/, ""));   // Markdown 제목·인용 기호는 글이 아니다
  }
  return { kind: "text", paragraphs, tables, warnings: [] };
}

/** XLSX 는 호출부가 시트 읽기 함수를 넘긴다(SheetJS 주입) */
export type SheetReader = (buf: Uint8Array) => { name: string; rows: string[][] }[];

export async function extractDoc(name: string, buf: Uint8Array, sheetReader?: SheetReader): Promise<ExtractedDoc> {
  const drm = drmSignature(buf);
  if (drm) throw new ExtractError(`사내 DRM(${drm})이 걸린 파일입니다. 해제본으로 올려 주세요.`, "drm");
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf") {
    // pdfjs 는 무거워 이 경로에서만 동적 import 한다
    const { extractPdf } = await import("./pdf");
    return extractPdf(buf);
  }
  if (ext === "docx") return extractDocx(buf);
  if (ext === "hwpx") return extractHwpx(buf);
  if (ext === "hwp") {
    if (u32(buf, 0) !== 0xe011cfd0) throw new ExtractError("구형 HWP(3.0 이하)는 지원하지 않습니다. 한글에서 다시 저장해 주세요.", "unsupported");
    return extractHwp(buf);
  }
  if (ext === "xlsx" || ext === "xls") {
    if (!sheetReader) throw new ExtractError("엑셀 읽기 함수가 주입되지 않았습니다", "unsupported");
    const sheets = sheetReader(buf);
    const tables: DocTable[] = sheets.filter((s) => s.rows.length).map((s) => ({ head: s.rows[0], rows: s.rows.slice(1) }));
    return { kind: "xlsx", paragraphs: sheets.map((s) => `[시트] ${s.name}`), tables, warnings: [] };
  }
  return extractText(buf);
}
