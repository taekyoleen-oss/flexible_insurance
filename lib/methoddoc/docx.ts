import { FORMULA_MARK, NOTE_MARK, isNumericCell, type DocSection } from "./render";

/**
 * 산출방법서 블록 → Word(.docx). 앱에 딸리지 않고 새 의존성도 없다(압축하지 않은 ZIP 을 직접 쓴다).
 * 한글에서 그대로 열리고 [다른 이름으로 저장 → HWPX] 하면 한글 문서가 된다(Word 수식은 한글 수식이 된다).
 *
 * 식 줄은 Word 수식(OMML, 왼쪽 정렬 독립 수식 m:oMathPara)으로 쓴다 — 평문 표기의 아래·위첨자(l_{x+t+1}, v^{t+½})가
 * 진짜 첨자가 되고, 한글도 이 모양만 한글 수식으로 받아들인다(글 속의 줄 안 수식 m:oMath 는 한글이 버린다).
 * 본문·표 칸·"기호 : 뜻" 줄의 기호(α_S, l_{x+t}, W^표준)는 글자 서식 아래·위첨자로 쓴다 — Word·한글 모두 첨자로 보인다.
 * 식은 한 줄에 하나, 설명 줄은 글로 둔다.
 * 수식 제목 앞에 "[식]", 주석 앞에 "※" 를 붙인다 — extractDocx 는 문단 순서를 지키고 Word 수식을 평문 표기로 되돌리므로
 * parse 가 이 표시로 식을 가른다.
 * 글자 크기: 본문·표·식 12pt, 절 제목·소제목 14pt, 문서 제목 18pt. 식 줄 간격 1.5.
 */

export interface DocxOptions {
  /** 맨 앞 "작성 안내" 표 — parse 는 이 표를 읽지 않는다 */
  guide?: string[];
}

const esc = (s: string | number) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const pPr = (style?: string, extra = "") => (style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>` : "");
const para = (inner: string, style?: string, extra = "") => `<w:p>${pPr(style, extra)}${inner}</w:p>`;

// ── 평문 수식 → Word 수식(OMML) ──────────────────────────────────────────────
/** 수식 글꼴·크기(12pt) — 한글은 이 크기로 한글 수식을 만든다(없으면 10pt 로 작게 들어온다) */
const MATH_FONT = '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>';
const mr = (t: string, sty?: "p" | "nor") =>
  `<m:r>${sty === "nor" ? "<m:rPr><m:nor/></m:rPr>" : sty === "p" ? '<m:rPr><m:sty m:val="p"/></m:rPr>' : ""}${MATH_FONT}<m:t xml:space="preserve">${esc(t)}</m:t></m:r>`;
/**
 * 이름 한 덩어리 — 한글과 두 글자 이상 영문(PVB·min·base)은 일반 글자, 한 글자는 수식 기울임.
 * 여러 글자 이름을 일반 글자로 두는 것은 한글 때문이다: 수식 낱말(base 등)과 겹치면 네모로 그린다.
 */
const nameRun = (t: string) => (/^(min|max|round|exp|log|ln)$/.test(t) ? mr(t, "p")      // 함수 이름은 곧은 수식 글꼴
  : /[가-힣]/.test(t) || (t.match(/[A-Za-z]/g)?.length ?? 0) >= 2 ? mr(t, "nor") : mr(t));
const NAME = /^([가-힣]+|[A-Za-z0-9α-ωΑ-ΩĀ]+[′'*]*)/;

/** 평문 수식 한 토막 → OMML 요소들. _ ^ 는 바로 앞 이름에 붙고, {…} 는 묶음 */
export function mathXml(src: string): string {
  const atoms: { base: string; sub?: string; sup?: string; plain?: string }[] = [];
  let i = 0;
  const group = (): string => {
    if (src[i] === "{") {
      let depth = 1, j = i + 1;
      while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const inner = src.slice(i + 1, j - 1);
      i = j;
      return mathXml(inner);
    }
    const m = /^([가-힣]+|[A-Za-z0-9]+|.)/.exec(src.slice(i))!;
    i += m[0].length;
    return nameRun(m[0]);
  };
  while (i < src.length) {
    const c = src[i];
    const last = atoms[atoms.length - 1];
    if ((c === "_" || c === "^") && last && last.plain === undefined) {
      i++;
      const g = group();
      if (c === "_") last.sub = (last.sub ?? "") + g; else last.sup = (last.sup ?? "") + g;
      continue;
    }
    const m = NAME.exec(src.slice(i));
    if (m) { atoms.push({ base: nameRun(m[0]) }); i += m[0].length; continue; }
    // 연산자·괄호·빈칸은 이웃끼리 한 덩어리
    if (last?.plain !== undefined) last.plain += c; else atoms.push({ base: "", plain: c });
    i++;
  }
  return atoms.map((a) => {
    if (a.plain !== undefined) return mr(a.plain);
    const e = `<m:e>${a.base}</m:e>`;
    if (a.sub !== undefined && a.sup !== undefined) return `<m:sSubSup>${e}<m:sub>${a.sub}</m:sub><m:sup>${a.sup}</m:sup></m:sSubSup>`;
    if (a.sub !== undefined) return `<m:sSub>${e}<m:sub>${a.sub}</m:sub></m:sSub>`;
    if (a.sup !== undefined) return `<m:sSup>${e}<m:sup>${a.sup}</m:sup></m:sSup>`;
    return a.base;
  }).join("");
}
/** 한 줄 전체가 식인 문단 — 왼쪽 정렬 독립 수식 */
const displayMath = (s: string) => `<m:oMathPara><m:oMathParaPr><m:jc m:val="left"/></m:oMathParaPr><m:oMath>${mathXml(s)}</m:oMath></m:oMathPara>`;

/**
 * 글 속의 기호 — α_S · l′_{x+t} · W^{표준} · q^{(1)}_x.
 * 글 속에서는 한글 첨자를 {…} 로 묶을 때만 첨자로 본다 — "α_P는" 의 "는" 이 첨자로 딸려 가지 않게.
 */
const TOKEN = /[A-Za-zα-ωΑ-ΩĀ][′']?(?:[_^](?:\{[^{}]*\}|[A-Za-z0-9]+|[α-ω]))+/g;
const SCRIPT = /([_^])(\{[^{}]*\}|[A-Za-z0-9]+|[α-ω])/g;
/** 기호 하나 → 글자 서식 첨자 런들 (본체 · 아래첨자 · 위첨자) */
function tokenRuns(tok: string, rPr: string): string {
  const base = /^[A-Za-zα-ωΑ-ΩĀ][′']?/.exec(tok)![0];
  let out = run(base, rPr);
  for (const m of tok.slice(base.length).matchAll(SCRIPT)) {
    const t = m[2].startsWith("{") ? m[2].slice(1, -1) : m[2];
    out += run(t, `${rPr}<w:vertAlign w:val="${m[1] === "_" ? "subscript" : "superscript"}"/>`);
  }
  return out;
}
/** 글 속의 기호만 첨자 서식으로, 나머지는 글 */
export function richRuns(text: string, rPr = ""): string {
  let out = "", at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > at) out += run(text.slice(at, m.index), rPr);
    out += tokenRuns(m[0], rPr);
    at = m.index! + m[0].length;
  }
  return out + (at < text.length ? run(text.slice(at), rPr) : "");
}

/**
 * 식 블록의 한 줄 → 문단. "기호 : 뜻" 은 기호만 수식, 한글 설명 줄(= 이 없는 줄)은 글, 나머지는 한 줄 전체가 수식.
 * 한 줄에 식이 둘("A = …        B = …")이면 두 문단으로 — 되읽을 때 빈칸이 하나로 줄어 곱처럼 보이지 않게.
 */
function formulaParas(line: string): string[] {
  if (/^[^가-힣\s][^가-힣]*?\s+:\s+/.test(line)) return [para(richRuns(line), "FormulaText")];     // 기호 : 뜻
  if (/[가-힣]/.test(line) && !/=/.test(line)) return [para(richRuns(line), "FormulaText")];      // 설명 줄
  return splitEquations(line).flatMap((eq) => wrapEquation(eq)).map((eq) => para(displayMath(eq), "Formula"));
}

/** 식에서 보이는 글자 수 — 첨자 표시(_ ^ { })는 빼고 센다 */
const visible = (s: string) => s.replace(/[_^{}]/g, "").length;
/**
 * 긴 식은 가운데쯤의 + · − 앞에서 다음 줄로 넘긴다 — Word 는 긴 독립 수식을 스스로 나누지만 한글은 쪽 밖으로 넘친다.
 * 첨자 묶음 {…} 과 두 겹 이상 괄호 안에서는 나누지 않는다. 되읽으면 줄이 이어 붙어 같은 식이 된다(빈칸은 비교에서 빠진다).
 */
export function wrapEquation(eq: string, max = 58): string[] {
  if (visible(eq) <= max) return [eq];
  const cut: number[] = [];
  let brace = 0, paren = 0;
  for (let i = 0; i < eq.length; i++) {
    const c = eq[i];
    if (c === "{") brace++; else if (c === "}") brace--;
    else if (c === "(" || c === "[") paren++; else if (c === ")" || c === "]") paren--;
    else if ((c === "+" || c === "−") && eq[i - 1] === " " && eq[i + 1] === " " && brace === 0 && paren <= 1 && i > 0) cut.push(i);
  }
  const mid = visible(eq) / 2;
  const at = cut.sort((a, b) => Math.abs(visible(eq.slice(0, a)) - mid) - Math.abs(visible(eq.slice(0, b)) - mid))[0];
  if (at === undefined) return [eq];
  return [...wrapEquation(eq.slice(0, at).trimEnd(), max), ...wrapEquation(eq.slice(at), max)];
}

/**
 * 한 줄에 식이 둘("P = PVB / N*        P_base = …")이면 두 줄로 나눈다. 제목 낱말("유지자수  l = …")은 그대로 둔다.
 */
export function splitEquations(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/ {2,}/)) {
    if (out.length && part.includes("=") && out[out.length - 1].includes("=")) out.push(part);
    else out[out.length ? out.length - 1 : 0] = out.length ? `${out[out.length - 1]}  ${part}` : part;
  }
  return out;
}

// ── 표 ─────────────────────────────────────────────────────────────────────
const BORDER = ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="A0A0A0"/>`).join("");
const WIDTH = 9800;   // A4 본문 폭(twip)

function table(head: string[], rows: (string | number)[][], shade = "EEF1F5"): string {
  const small = head.length >= 8 ? '<w:sz w:val="16"/><w:szCs w:val="16"/>' : "";
  const cell = (c: string | number, h: boolean, mid: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${h ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>` +
    `<w:p><w:pPr><w:spacing w:before="30" w:after="30"/>${mid ? '<w:jc w:val="center"/>' : ""}</w:pPr>${richRuns(String(c), (h ? "<w:b/>" : "") + small)}</w:p></w:tc>`;
  // 2칸 표(항목 | 내용 · 담보 세로 표 · 기호의 정의)는 첫 칸을 좁게
  const cols = head.length === 2 ? [Math.round(WIDTH * 0.3), WIDTH - Math.round(WIDTH * 0.3)] : head.map(() => Math.floor(WIDTH / head.length));
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${BORDER}</w:tblBorders>` +
    `<w:tblCellMar><w:left w:w="140" w:type="dxa"/><w:right w:w="180" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h) => cell(h, true, false)).join("")}</w:tr>` +
    // 숫자 칸은 가운데(3칸 이상 표) — 한글은 오른쪽 여백을 무시해 오른쪽 정렬 값이 테두리에 붙는다. 2칸 표(항목 | 내용)는 모두 왼쪽
    rows.map((r) => `<w:tr>${r.map((c, i) => cell(c, false, head.length >= 3 && i > 0 && isNumericCell(c))).join("")}</w:tr>`).join("") +
    `</w:tbl>${para("")}`;
}

function documentXml(sections: DocSection[], title: string, opt: DocxOptions): string {
  const body: string[] = [para(run(title), "Title")];
  if (opt.guide?.length) body.push(table(["작성 안내"], opt.guide.map((g) => [g]), "FFF4D6"));
  for (const sec of sections) {
    body.push(para(run(sec.title), "Heading1"));
    for (const b of sec.blocks) {
      if (b.t === "p") body.push(b.kind === "label" ? para(richRuns(`${FORMULA_MARK} ${b.text}`), "FormulaLabel")
        : para(richRuns(b.text), /^\d+\.\d+\.\s/.test(b.text) ? "Heading2" : undefined));
      else if (b.t === "note") body.push(para(richRuns(`${NOTE_MARK} ${b.text}`), "Note"));
      else if (b.t === "formula") for (const line of b.text.split("\n")) { if (line.trim()) body.push(...formulaParas(line)); }
      else body.push(table(b.head, b.rows));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1020" w:left="1020" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const style = (id: string, name: string, p: string, r: string) =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${p}</w:pPr><w:rPr>${r}</w:rPr></w:style>`;
const pt = (n: number) => `<w:sz w:val="${n * 2}"/><w:szCs w:val="${n * 2}"/>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/>${pt(12)}<w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  style("Title", "Title", '<w:spacing w:after="280"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="1B2845"/></w:pBdr>', `<w:b/>${pt(18)}`) +
  style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="360" w:after="140"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BBBBBB"/></w:pBdr>', `<w:b/>${pt(14)}`) +
  style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/>', `<w:b/>${pt(14)}`) +
  style("FormulaLabel", "수식 제목", '<w:keepNext/><w:spacing w:before="200" w:after="60"/>', `<w:b/><w:color w:val="1B2845"/>${pt(12)}`) +
  // 식 줄 — 줄 간격 1.5 (w:line 360 = 240 × 1.5)
  style("Formula", "수식", '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:left="567"/>', pt(12)) +
  style("FormulaText", "수식 설명", '<w:keepNext/><w:spacing w:before="80" w:after="0" w:line="360" w:lineRule="auto"/><w:ind w:left="567"/>', `<w:color w:val="333333"/>${pt(12)}`) +
  style("Note", "주석", '<w:spacing w:before="80" w:after="140"/><w:ind w:left="567"/>', `<w:color w:val="444444"/>${pt(12)}`) +
  `</w:styles>`;

const FILES = (doc: string): [string, string][] => [
  ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`],
  ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
  ["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
  ["word/document.xml", doc],
  ["word/styles.xml", STYLES],
];

export function docToDocx(sections: DocSection[], title: string, opt: DocxOptions = {}): Uint8Array {
  return zipStore(FILES(documentXml(sections, title, opt)).map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

// ── 압축하지 않은(stored) ZIP ────────────────────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const header = (size: number, fill: (v: DataView) => void) => { const b = new Uint8Array(size); fill(new DataView(b.buffer)); return b; };
  for (const [name, data] of files) {
    const nm = new TextEncoder().encode(name), crc = crc32(data);
    const common = (v: DataView, o: number) => {
      v.setUint16(o, 20, true); v.setUint16(o + 2, 0x0800, true); v.setUint16(o + 4, 0, true);   // 버전 · UTF-8 이름 · stored
      v.setUint16(o + 6, 0, true); v.setUint16(o + 8, 0x21, true);                               // 시각 00:00 · 날짜 1980-01-01
      v.setUint32(o + 10, crc, true); v.setUint32(o + 14, data.length, true); v.setUint32(o + 18, data.length, true);
      v.setUint16(o + 22, nm.length, true); v.setUint16(o + 24, 0, true);
    };
    parts.push(header(30, (v) => { v.setUint32(0, 0x04034b50, true); common(v, 4); }), nm, data);
    central.push(header(46, (v) => { v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); common(v, 6); v.setUint32(42, offset, true); }), nm);
    offset += 30 + nm.length + data.length;
  }
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const end = header(22, (v) => {
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
    v.setUint32(12, cdSize, true); v.setUint32(16, offset, true);
  });
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}
