import { zipStore } from "./docx";

/**
 * 엑셀 파일(.xlsx) 을 직접 쓴다 — 의존성 없이. docx.ts 와 같은 ZIP 쓰개를 쓴다.
 *
 * 값 칸은 수로, 식 칸은 `<f>` 로 넣는다(계산 값을 같이 넣지 않으므로 엑셀이 열 때 다시 계산한다).
 * 글자는 sharedStrings 없이 칸 안에 그대로 둔다(inlineStr) — 파일이 조금 커지지만 만들기가 단순하다.
 */

export type XCell = number | string | { f: string; fmt?: number } | { v: number; fmt?: number } | null;
export interface XSheet {
  name: string;
  /** 줄 → 칸. 빈 칸은 null */
  rows: XCell[][];
  /** 열 너비 (엑셀 글자 수) */
  widths?: number[];
  /** 얼려 둘 줄·열 수 */
  freeze?: { rows: number; cols: number };
}
/**
 * 통합 문서에 두는 이름 — 수식에서 x_age · v_disc 처럼 쓴다.
 * local 에 장 번호(0부터)를 주면 그 장에서만 쓰는 이름이다 — 장마다 n·m·보장금액이 다르므로 대부분 이쪽이다.
 */
export interface XName { name: string; sheet: string; ref: string; local?: number }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const enc = (s: string) => new TextEncoder().encode(s);

/** 0 → A, 25 → Z, 26 → AA */
export function colLetter(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
export const cellRef = (col: number, row: number) => `${colLetter(col)}${row}`;

/** 숫자 서식 — 0 일반 · 1 정수 · 2 소수 둘 · 3 소수 여섯 · 4 천단위 정수 · 5 백분율 */
const FORMATS = ["General", "0", "#,##0.00", "0.00000000", "#,##0", "0.000%"];

function sheetXml(s: XSheet): string {
  const rows = s.rows.map((cells, r) => {
    const row = r + 1;
    const out = cells.map((c, i) => {
      if (c === null || c === undefined || c === "") return "";
      const ref = cellRef(i, row);
      if (typeof c === "number") return Number.isFinite(c) ? `<c r="${ref}"><v>${c}</v></c>` : "";
      if (typeof c === "string") return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(c)}</t></is></c>`;
      const style = c.fmt ? ` s="${c.fmt}"` : "";
      if ("f" in c) return `<c r="${ref}"${style}><f>${esc(c.f)}</f></c>`;
      return Number.isFinite(c.v) ? `<c r="${ref}"${style}><v>${c.v}</v></c>` : "";
    }).join("");
    return out ? `<row r="${row}">${out}</row>` : "";
  }).join("");
  const cols = s.widths?.length
    ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = s.freeze
    ? `<sheetViews><sheetView workbookViewId="0"><pane xSplit="${s.freeze.cols}" ySplit="${s.freeze.rows}" topLeftCell="${cellRef(s.freeze.cols, s.freeze.rows + 1)}" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

export function writeXlsx(sheets: XSheet[], names: XName[] = []): Uint8Array {
  const rels = sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
    + `<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  const defined = names.length
    ? `<definedNames>${names.map((n) => `<definedName name="${esc(n.name)}"${n.local === undefined ? "" : ` localSheetId="${n.local}"`}>'${esc(n.sheet)}'!${n.ref}</definedName>`).join("")}</definedNames>` : "";
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${defined}`
    + `<calcPr fullCalcOnLoad="1"/></workbook>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<numFmts count="0"/><fonts count="1"><font><sz val="11"/><name val="맑은 고딕"/></font></fonts>`
    + `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>`
    + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
    + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
    + `<cellXfs count="${FORMATS.length}">${FORMATS.map((f, i) => `<xf numFmtId="${i === 0 ? 0 : 163 + i}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`).join("")}</cellXfs>`
    + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  // 쓰는 서식은 numFmts 로 따로 정의한다(163 부터)
  const withFmts = styles.replace('<numFmts count="0"/>',
    `<numFmts count="${FORMATS.length - 1}">${FORMATS.slice(1).map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${esc(f)}"/>`).join("")}</numFmts>`);
  const files: [string, Uint8Array][] = [
    ["[Content_Types].xml", enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
      + `<Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
      + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")
      + `</Types>`)],
    ["_rels/.rels", enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)],
    ["xl/workbook.xml", enc(workbook)],
    ["xl/_rels/workbook.xml.rels", enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`)],
    ["xl/styles.xml", enc(withFmts)],
    ...sheets.map((s, i): [string, Uint8Array] => [`xl/worksheets/sheet${i + 1}.xml`, enc(sheetXml(s))]),
  ];
  return zipStore(files);
}

/** 엑셀 시트 이름에 못 쓰는 글자를 빼고 31자로 자른다 */
export const sheetName = (s: string, fallback = "시트") =>
  (s.replace(/[[\]:*?/\\]/g, " ").trim() || fallback).slice(0, 31);
