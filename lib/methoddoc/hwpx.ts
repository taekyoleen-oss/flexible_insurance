import { FORMULA_MARK, NOTE_MARK, isNumericCell, type DocSection } from "./render";
import { formulaLines, richParts, zipStore } from "./docx";
import { HWPX_HEADER, HWPX_NS, HWPX_SECPR, HWPX_STATIC } from "./hwpx-header";

/**
 * 산출방법서 블록 → 한글(.hwpx). Word 쓰기(docx.ts)와 같은 문단 · 표 · 식 줄을 같은 차례로 쓴다 —
 * extractHwpx 로 되읽으면 Word 로 읽은 것과 같은 문단 · 표가 나온다.
 * 앱에 딸리지 않고 새 의존성도 없다(압축하지 않은 ZIP — mimetype 이 첫 항목). 한글 프로그램(COM)을 쓰지 않는다.
 *
 * 식 줄은 한글 수식 개체(hp:equation 의 hp:script — 한글 수식 스크립트)로, 글 속 기호(α_S · l_{x+t})는 아래·위첨자 글자 모양으로 쓴다.
 * 글꼴 · 글자 모양 · 문단 모양 · 테두리(header.xml)는 한글이 만든 파일의 것(hwpx-header.ts)이고 여기서는 그 번호만 가리킨다.
 * 줄 배치 정보(hp:linesegarray)는 싣지 않는다 — 한글이 열 때 다시 계산한다.
 */
export interface HwpxOptions {
  /** 맨 앞 "작성 안내" 표 — parse 는 이 표를 읽지 않는다 */
  guide?: string[];
  /** 문서 정보의 만든 날 — 비우면 지금 */
  now?: Date;
}

export const HWPX_MIME = "application/hwp+zip";

// header.xml 의 번호 — 글자 모양(CH) · 문단 모양과 스타일(PA: [paraPr, style]) · 테두리(BF)
const CH = { body: 0, title: 1, head: 2, ftext: 3, label: 4, note: 5, bold: 6, small: 14, smallBold: 15 };
const SUB: Record<number, number> = { 0: 7, 3: 8, 5: 9 }, SUP: Record<number, number> = { 0: 11, 3: 12, 5: 13 };
const PA = { title: [8, 1], h1: [11, 2], h2: [3, 3], body: [10, 0], formula: [4, 4], ftext: [5, 5], label: [6, 6], note: [7, 7], cell: [9, 0], cellMid: [12, 0] };
const BF = { cell: 4, guide: 5, head: 6 };
const WIDTH = 49000;   // A4 본문 폭(HWPUNIT = 1/7200 인치)

const esc = (s: string | number) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
const P = (runs: string, [pa, st]: number[]) => `<hp:p id="0" paraPrIDRef="${pa}" styleIDRef="${st}" pageBreak="0" columnBreak="0" merged="0">${runs}</hp:p>`;
const T = (text: string, ch: number) => `<hp:run charPrIDRef="${ch}">${text ? `<hp:t>${esc(text)}</hp:t>` : "<hp:t/>"}</hp:run>`;
/** 글 — 글 속 기호의 첨자는 아래·위첨자 글자 모양으로 */
const rich = (text: string, ch: number) =>
  richParts(text).map((p) => T(p.t, p.v === "sub" ? SUB[ch] ?? 7 : p.v === "sup" ? SUP[ch] ?? 11 : ch)).join("") || T("", ch);

/**
 * 평문 수식 → 한글 수식 스크립트. extract.ts hwpEquation 이 되돌린다(쓴 것을 읽으면 원래 평문 식).
 *  · 첨자는 늘 묶는다: α_S → α_{S} · v^t → v^{t}
 *  · 첨자가 붙는 두 글자 이상 이름은 묶는다: l′_{x} → {l′}_{x} (첨자가 마지막 글자에만 붙지 않게)
 *  · 한글과 두 글자 이상 영문 이름은 따옴표(곧은 글자) — 한글 수식 낱말(base · sum · it …)로 읽히지 않게: P_{"base"} · "해약공제"_{t}
 *  · 빈칸은 ~ (한글 수식은 그냥 빈칸을 무시한다). × · − Σ α ′ ≥ 는 글자 그대로 — 한글이 Word 수식을 받을 때 쓰는 모양과 같다
 */
export const hwpScript = (src: string) => src
  .replace(/([_^])(?!\{)([가-힣]+|[A-Za-z0-9]+|.)/g, "$1{$2}")
  .replace(/([가-힣]+|[A-Za-z0-9α-ωΑ-ΩĀ]+[′'*]*)(?=[_^])/g, (b) => (b.length > 1 ? `{${b}}` : b))
  .replace(/[가-힣]+|[A-Za-z]{2,}/g, '"$&"')
  .replace(/ /g, "~");

function documentXml(sections: DocSection[], title: string, opt: HwpxOptions): string {
  let seq = 0;
  const id = () => 1206357500 + ++seq;
  const POS = (inline: number) => `<hp:pos treatAsChar="${inline}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`;

  /** 한 줄 전체가 식인 문단 — 글자처럼 놓인 수식 개체 하나. 크기는 어림값(한글이 수식을 고치면 다시 잰다) */
  const equation = (eq: string) => {
    const main = eq.replace(/[_^]\{[^{}]*\}|[_^]\S/g, "").replace(/\s/g, "").length, all = eq.replace(/[_^{}\s]/g, "").length;
    const width = Math.min(WIDTH - 3000, 600 * main + 400 * (all - main) + 300 * (eq.split(" ").length - 1));
    return P(`<hp:run charPrIDRef="0"><hp:equation id="${id()}" zOrder="${seq}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${eq.includes("^") ? 75 : 71}" textColor="#000000" baseUnit="1200" lineMode="CHAR" font="HancomEQN">` +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${eq.includes("^") ? 1675 : 1450}" heightRelTo="ABSOLUTE" protect="0"/>${POS(1)}<hp:outMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:shapeComment>수식입니다.</hp:shapeComment><hp:script xml:space="preserve">${esc(hwpScript(eq))}</hp:script></hp:equation><hp:t/></hp:run>`, PA.formula);
  };

  const table = (head: string[], rows: (string | number)[][], headFill = BF.head) => {
    const small = head.length >= 8;
    // 칸 폭은 Word 와 같은 비율 — 2칸 표(항목 | 내용)는 첫 칸을 좁게, 위험률 합성 표(기호 | 이름 | 식)는 식 칸을 넓게
    const share = head.length === 2 ? [0.3, 0.7] : head.join("|") === "기호|이름|식" ? [0.12, 0.3, 0.58] : head.map(() => 1 / head.length);
    const cols = share.map((x) => Math.floor(WIDTH * x));
    const cell = (c: string | number, r: number, i: number) => {
      const h = r === 0, mid = h || (head.length >= 3 && i > 0 && isNumericCell(c));
      return `<hp:tc name="" header="${h ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${h ? headFill : BF.cell}">` +
        `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
        `${P(rich(String(c), h ? (small ? CH.smallBold : CH.bold) : small ? CH.small : CH.body), mid ? PA.cellMid : PA.cell)}</hp:subList>` +
        `<hp:cellAddr colAddr="${i}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cols[i] ?? cols[cols.length - 1]}" height="282"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
    };
    const all = [head, ...rows];
    return P(`<hp:run charPrIDRef="0"><hp:tbl id="${id()}" zOrder="${seq}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${all.length}" colCnt="${head.length}" cellSpacing="0" borderFillIDRef="${BF.cell}" noAdjust="0">` +
      `<hp:sz width="${cols.reduce((a, b) => a + b, 0)}" widthRelTo="ABSOLUTE" height="${all.length * 2400}" heightRelTo="ABSOLUTE" protect="0"/>${POS(0)}` +
      `<hp:outMargin left="141" right="141" top="141" bottom="141"/><hp:inMargin left="700" right="900" top="141" bottom="141"/>` +
      all.map((row, r) => `<hp:tr>${row.map((c, i) => cell(c, r, i)).join("")}</hp:tr>`).join("") +
      `</hp:tbl><hp:t/></hp:run>`, PA.body);
  };

  // 첫 문단(문서 제목)의 첫 런이 쪽 모양을 싣는다
  const body: string[] = [P(`${HWPX_SECPR}<hp:run charPrIDRef="0"/>${T(title, CH.title)}`, PA.title)];
  if (opt.guide?.length) body.push(table(["작성 안내"], opt.guide.map((g) => [g]), BF.guide));
  for (const sec of sections) {
    body.push(P(T(sec.title, CH.head), PA.h1));
    for (const b of sec.blocks) {
      if (b.t === "p") body.push(b.kind === "label" ? P(rich(`${FORMULA_MARK} ${b.text}`, CH.label), PA.label)
        : b.kind === "sub" || /^\d+\.\d+\.\s/.test(b.text) ? P(rich(b.text, CH.head), PA.h2) : P(rich(b.text, CH.body), PA.body));
      else if (b.t === "note") body.push(P(rich(`${NOTE_MARK} ${b.text}`, CH.note), PA.note));
      else if (b.t === "formula") {
        for (const line of b.text.split("\n")) if (line.trim()) for (const l of formulaLines(line)) body.push(l.math ? equation(l.text) : P(rich(l.text, CH.ftext), PA.ftext));
      } else body.push(table(b.head, b.rows));
    }
  }
  return `${XML}<hs:sec${HWPX_NS}>${body.join("")}</hs:sec>`;
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';

/** 묶음 정보 — 제목 · 만든 날 · 든 파일 */
const contentHpf = (title: string, now: Date) => {
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  return `${XML}<opf:package${HWPX_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language>` +
    `<opf:meta name="creator" content="text"/><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text"/>` +
    `<opf:meta name="CreatedDate" content="text">${at}</opf:meta><opf:meta name="ModifiedDate" content="text">${at}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata>` +
    `<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>` +
    `<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;
};

export function docToHwpx(sections: DocSection[], title: string, opt: HwpxOptions = {}): Uint8Array {
  const fixed = new Map(HWPX_STATIC);
  const files: [string, string][] = [
    ["mimetype", HWPX_MIME],                                   // 반드시 첫 항목 · 무압축
    ["version.xml", fixed.get("version.xml")!],
    ["Contents/header.xml", HWPX_HEADER],
    ["Contents/section0.xml", documentXml(sections, title, opt)],
    ["Preview/PrvText.txt", [title, ...sections.map((s) => s.title)].join("\r\n")],
    ["settings.xml", fixed.get("settings.xml")!.replace(/pos="\d+"/, 'pos="0"')],
    ["META-INF/container.rdf", fixed.get("META-INF/container.rdf")!],
    ["Contents/content.hpf", contentHpf(title, opt.now ?? new Date())],
    ["META-INF/container.xml", fixed.get("META-INF/container.xml")!],
    ["META-INF/manifest.xml", fixed.get("META-INF/manifest.xml")!],
  ];
  return zipStore(files.map(([name, text]) => [name, new TextEncoder().encode(text)]), false);
}
