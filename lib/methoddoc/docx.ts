import { FORMULA_MARK, NOTE_MARK, isNumericCell, type DocSection } from "./render";

/**
 * 산출방법서 블록 → Word(.docx). 앱에 딸리지 않고 새 의존성도 없다(압축하지 않은 ZIP 을 직접 쓴다).
 * 한글에서 그대로 열리고 [다른 이름으로 저장 → HWPX] 하면 한글 문서가 된다.
 *
 * 편집해서 되읽는 문서라 수식은 평문 표기(l_{x+t+1} = l_{x+t} × ( 1 − q_{x+t} ))로 한 줄씩 쓰고,
 * 수식 제목 앞에 "[식]", 주석 앞에 "※" 를 붙인다 — extractDocx 는 문단 순서를 지키므로 parse 가 이 표시로 식을 가른다.
 */

export interface DocxOptions {
  /** 맨 앞 "작성 안내" 표 — parse 는 이 표를 읽지 않는다 */
  guide?: string[];
}

const esc = (s: string | number) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const run = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
const para = (text: string, style?: string, rPr = "") =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${text ? run(text, rPr) : ""}</w:p>`;

const BORDER = ["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="A0A0A0"/>`).join("");
const WIDTH = 9600;   // A4 본문 폭(twip)

function table(head: string[], rows: (string | number)[][], shade = "EEF1F5"): string {
  const small = head.length >= 8 ? '<w:sz w:val="14"/><w:szCs w:val="14"/>' : "";
  const cell = (c: string | number, h: boolean, right: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${h ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ""}</w:tcPr>` +
    `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/>${right ? '<w:jc w:val="right"/>' : ""}</w:pPr>${run(String(c), (h ? "<w:b/>" : "") + small)}</w:p></w:tc>`;
  const col = Math.floor(WIDTH / head.length);
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${BORDER}</w:tblBorders>` +
    `<w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>` +
    `<w:tblGrid>${head.map(() => `<w:gridCol w:w="${col}"/>`).join("")}</w:tblGrid>` +
    `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h) => cell(h, true, false)).join("")}</w:tr>` +
    rows.map((r) => `<w:tr>${r.map((c, i) => cell(c, false, i > 0 && isNumericCell(c))).join("")}</w:tr>`).join("") +
    `</w:tbl>${para("")}`;
}

/**
 * 한 줄에 식이 둘("P = PVB / N*        P_base = …")이면 Word 에서는 두 줄로 쓴다 —
 * Word·한글에서 되읽으면 빈칸이 하나로 줄어 "N* P_base" 가 곱처럼 보이기 때문이다. 제목 낱말("유지자수  l = …")은 그대로 둔다.
 */
export function splitEquations(line: string): string[] {
  const out: string[] = [];
  for (const part of line.split(/ {2,}/)) {
    if (out.length && part.includes("=") && out[out.length - 1].includes("=")) out.push(part);
    else out[out.length ? out.length - 1 : 0] = out.length ? `${out[out.length - 1]}  ${part}` : part;
  }
  return out;
}

function documentXml(sections: DocSection[], title: string, opt: DocxOptions): string {
  const body: string[] = [para(title, "Title")];
  if (opt.guide?.length) body.push(table(["작성 안내"], opt.guide.map((g) => [g]), "FFF4D6"));
  for (const sec of sections) {
    body.push(para(sec.title, "Heading1"));
    for (const b of sec.blocks) {
      if (b.t === "p") body.push(b.kind === "label" ? para(`${FORMULA_MARK} ${b.text}`, "FormulaLabel")
        : para(b.text, /^\d+\.\d+\.\s/.test(b.text) ? "Heading2" : undefined));
      else if (b.t === "note") body.push(para(`${NOTE_MARK} ${b.text}`, "Note"));
      else if (b.t === "formula") for (const line of b.text.split("\n").flatMap(splitEquations)) { if (line.trim()) body.push(para(line, "Formula")); }
      else body.push(table(b.head, b.rows));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1020" w:right="1020" w:bottom="1020" w:left="1020" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`;
}

const style = (id: string, name: string, pPr: string, rPr: string, extra = "") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>${extra}<w:qFormat/><w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
  style("Title", "Title", '<w:spacing w:after="240"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="1B2845"/></w:pBdr>', '<w:b/><w:sz w:val="34"/><w:szCs w:val="34"/>') +
  style("Heading1", "heading 1", '<w:keepNext/><w:spacing w:before="320" w:after="120"/><w:outlineLvl w:val="0"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="BBBBBB"/></w:pBdr>', '<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>') +
  style("Heading2", "heading 2", '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="22"/><w:szCs w:val="22"/>') +
  style("FormulaLabel", "수식 제목", '<w:keepNext/><w:spacing w:before="160" w:after="40"/>', '<w:b/><w:color w:val="1B2845"/>') +
  style("Formula", "수식", '<w:spacing w:after="0"/><w:ind w:left="284"/><w:shd w:val="clear" w:color="auto" w:fill="F4F6F8"/>', '<w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/><w:sz w:val="20"/>') +
  style("Note", "주석", '<w:spacing w:before="60" w:after="120"/><w:ind w:left="284"/>', '<w:color w:val="444444"/><w:sz w:val="18"/><w:szCs w:val="18"/>') +
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
