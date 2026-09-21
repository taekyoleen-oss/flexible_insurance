import type { DocTable, ExtractedDoc } from "./extract";
import type { DocSection } from "./render";

/**
 * 산출방법서 ↔ LaTeX.
 *  - toTex        평문 수식 한 줄("l_{x+t+1} = l_{x+t} × ( 1 − q_{x+t} )") → LaTeX. 화면(KaTeX)과 .tex 가 같은 함수를 쓴다
 *  - docToLatex   산출방법서 블록 → .tex 문서 (XeLaTeX/kotex 로 바로 조판)
 *  - latexToDoc   .tex → 문단·표. parseMethodDoc 에 넘기면 조건으로 되돌아간다
 * 앱에 딸리지 않는다(import 는 이 폴더 안뿐).
 */

// ── 평문 수식 → LaTeX ──────────────────────────────────────────────────────
const HANGUL = /[가-힣]/;
const SYMBOL: [RegExp, string][] = [
  [/−/g, "-"], [/·/g, "\\cdot "], [/×/g, "\\times "], [/÷/g, "\\div "], [/≥/g, "\\ge "], [/≤/g, "\\le "], [/≦/g, "\\leqq "],
  [/Σ/g, "\\sum"], [/½/g, "\\tfrac{1}{2}"], [/′/g, "'"], [/⊕/g, "\\oplus "], [/→/g, "\\to "], [/…/g, "\\ldots "],
  [/α/g, "\\alpha "], [/β/g, "\\beta "], [/γ/g, "\\gamma "], [/δ/g, "\\delta "], [/θ/g, "\\theta "], [/π/g, "\\pi "],
  [/ω/g, "\\omega "], [/Ā/g, "\\bar{A}"], [/∗/g, "*"],
  [/[₀₁₂₃₄₅₆₇₈₉]/g, "_{$&}"],
];
const SUBDIGIT: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
const escMath = (s: string) => s.replace(/([%&#$])/g, "\\$1");

function mathPart(s: string): string {
  // 원문의 두 칸 이상 공백(라벨과 식 사이)만 \quad 로 — 기호를 바꾸며 생긴 공백과 섞이지 않게 먼저 표시해 둔다
  let t = escMath(s).replace(/ {2,}/g, "\u0001");
  // 여러 글자 첨자는 중괄호로 — P_base → P_{base}, α^std → α^{std}
  t = t.replace(/([_^])([A-Za-z0-9]{2,})/g, "$1{$2}");
  for (const [re, to] of SYMBOL) t = t.replace(re, (m) => (to.includes("$&") ? to.replace("$&", SUBDIGIT[m] ?? m) : to));
  t = t.replace(/\bmin\(/g, "\\min(").replace(/\bmax\(/g, "\\max(").replace(/\bround\b/g, "\\operatorname{round}")
    .replace(/\b(PVB|CSV)\b/g, "\\mathrm{$1}");
  // 명령 뒤 공백이 첨자를 끊지 않게: "\alpha _S" → "\alpha_S"
  t = t.replace(/(\\[a-zA-Z]+) ([_^'])/g, "$1$2");
  return t.replace(/ {2,}/g, " ").replace(/ ?\u0001 ?/g, " \\quad ");
}

/** 평문 수식 한 줄 → LaTeX. 한글은 \text{}, 첨자 뒤 한글은 ^{\text{…}} */
export function toTex(line: string): string {
  let out = "", i = 0;
  while (i < line.length) {
    if (HANGUL.test(line[i])) {
      // 한글 낱말들(사이 공백 포함)을 한 덩어리로
      let j = i;
      while (j < line.length && (HANGUL.test(line[j]) || (line[j] === " " && HANGUL.test(line.slice(j).trimStart()[0] ?? "")))) j++;
      const run = line.slice(i, j);
      const prev = line[i - 1];
      const lead = prev === " " ? " " : "", tail = line[j] === " " ? " " : "";
      out += prev === "^" || prev === "_" ? `{\\text{${escMath(run)}}}` : `\\text{${lead}${escMath(run)}${tail}}`;
      i = j;
    } else {
      let j = i;
      while (j < line.length && !HANGUL.test(line[j])) j++;
      out += mathPart(line.slice(i, j));
      i = j;
    }
  }
  return out.trim();
}

/** 여러 줄 수식 → 왼쪽 정렬 aligned (KaTeX·LaTeX 공통). 빈 줄은 간격으로 */
export function formulaToTex(text: string, env: "aligned" | "align*" = "aligned"): string {
  const out: string[] = [];
  let gap = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) { gap = true; continue; }
    if (out.length) out.push(gap ? " \\\\[4pt]\n" : " \\\\\n");
    out.push(`& ${toTex(raw)}`);
    gap = false;
  }
  return `\\begin{${env}}\n${out.join("")}\n\\end{${env}}`;
}

// ── 문서 → .tex ────────────────────────────────────────────────────────────
const escText = (s: string) => s
  .replace(/\\/g, "\\textbackslash{}")
  .replace(/([&%$#_{}])/g, "\\$1")
  .replace(/~/g, "\\textasciitilde{}")
  .replace(/\^/g, "\\textasciicircum{}");

/** 표 칸: 기호(α_S, β′, γ)는 수식으로, 나머지는 글자 */
function cellTex(c: string | number): string {
  const s = String(c).trim();
  if (/^[αβγ](_[A-Za-z0-9가-힣]+|[′']|[12])?$/.test(s)) return `$${toTex(s)}$`;
  return escText(s);
}

export function docToLatex(sections: DocSection[], title: string, today = new Date()): string {
  const L: string[] = [
    "% 산출방법서 — Life_ins_Doc_Convert_Studio 에서 생성. XeLaTeX(kotex)로 조판한다: xelatex 파일.tex",
    "\\documentclass[10pt,a4paper]{article}",
    "\\usepackage{kotex}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{graphicx}",
    "\\usepackage[margin=18mm]{geometry}",
    "\\setlength{\\parindent}{0pt}",
    "\\setlength{\\parskip}{4pt}",
    `\\title{${escText(title)}}`,
    `\\date{${today.getFullYear()}. ${today.getMonth() + 1}. ${today.getDate()}.}`,
    "\\begin{document}",
    "\\maketitle",
    "",
  ];
  for (const sec of sections) {
    L.push(`\\section*{${escText(sec.title)}}`, "");
    for (const b of sec.blocks) {
      if (b.t === "p") {
        L.push(/^\d+\.\d+\.\s/.test(b.text) ? `\\subsection*{${escText(b.text)}}` : escText(b.text), "");
      } else if (b.t === "note") {
        L.push("\\begin{quote}\\small", escText(b.text), "\\end{quote}", "");
      } else if (b.t === "formula") {
        L.push(formulaToTex(b.text, "align*"), "");
      } else {
        const cols = b.head.map(() => "l").join("|");
        const tab = [
          `\\begin{tabular}{|${cols}|}`, "\\hline",
          `${b.head.map((h) => `\\textbf{${escText(h)}}`).join(" & ")} \\\\`, "\\hline",
          ...b.rows.map((r) => `${r.map(cellTex).join(" & ")} \\\\`), "\\hline", "\\end{tabular}",
        ];
        L.push("\\begin{center}\\small", ...(b.head.length >= 6 ? ["\\resizebox{\\textwidth}{!}{%", ...tab, "}"] : tab), "\\end{center}", "");
      }
    }
  }
  L.push("\\end{document}", "");
  return L.join("\n");
}

// ── .tex → 문단·표 ─────────────────────────────────────────────────────────
const MATH_BACK: [RegExp, string][] = [
  [/\\cdot\s?/g, "·"], [/\\times\s?/g, "×"], [/\\div\s?/g, "÷"], [/\\geq?\b\s?/g, "≥"], [/\\leq?q?\b\s?/g, "≤"], [/\\sum/g, "Σ"],
  [/\\tfrac\{1\}\{2\}/g, "½"], [/\\oplus\s?/g, "⊕"], [/\\to\b\s?/g, "→"], [/\\ldots\s?/g, "…"],
  [/\\alpha\s?/g, "α"], [/\\beta\s?/g, "β"], [/\\gamma\s?/g, "γ"], [/\\delta\s?/g, "δ"], [/\\theta\s?/g, "θ"], [/\\pi\s?/g, "π"], [/\\omega\s?/g, "ω"],
  [/\\bar\{A\}/g, "Ā"], [/\\min/g, "min"], [/\\max/g, "max"], [/\\operatorname\{([^}]*)\}/g, "$1"], [/\\mathrm\{([^}]*)\}/g, "$1"],
  [/\\quad\s?/g, "  "], [/\\,|\\;|\\!/g, " "],
];

/** LaTeX 수식 → 평문 표기 (조건 파서가 읽을 수 있게) */
export function unTexMath(s: string): string {
  let t = s;
  for (let k = 0; k < 3; k++) t = t.replace(/\{\\text\{([^{}]*)\}\}/g, "$1").replace(/\\text\{([^{}]*)\}/g, "$1");
  for (const [re, to] of MATH_BACK) t = t.replace(re, to);
  return t.replace(/'/g, "′").replace(/(?<![A-Za-z])-(?!-)/g, "−").replace(/&/g, "").replace(/\\([%#$&_{}])/g, "$1").replace(/\s+/g, " ").trim();
}

/** LaTeX 본문 글 → 평문 */
export function unTex(s: string): string {
  return s
    .replace(/\$([^$]*)\$/g, (_, m: string) => unTexMath(m))
    // 글자 "~"(\textasciitilde{})는 LaTeX 의 붙임 빈칸 "~" 을 빈칸으로 바꾼 뒤에 되돌린다 — "만15세 ~ 65세" 가 살아남게
    .replace(/\\textbackslash\{\}/g, "\\").replace(/\\textasciitilde\{\}/g, "\u0002").replace(/\\textasciicircum\{\}/g, "^")
    .replace(/\\(textbf|emph|textit|underline|small|large|footnotesize)\{([^{}]*)\}/g, "$2")
    .replace(/\\(small|large|footnotesize|centering|noindent)\b/g, "")
    .replace(/\\([&%$#_{}])/g, "$1").replace(/~/g, " ").replace(/\u0002/g, "~")
    .replace(/\s+/g, " ").trim();
}

/** 주석(%)을 지운다 — \% 는 남긴다 */
const stripComments = (s: string) => s.split("\n").map((l) => l.replace(/(^|[^\\])%.*$/, "$1")).join("\n");

export function latexToDoc(tex: string): ExtractedDoc {
  let src = stripComments(tex.replace(/\r\n/g, "\n"));
  const title = /\\title\{([^}]*)\}/.exec(src)?.[1];
  const begin = src.indexOf("\\begin{document}");
  if (begin >= 0) src = src.slice(begin + "\\begin{document}".length);
  src = src.replace(/\\end\{document\}[\s\S]*$/, "").replace(/\\maketitle/g, "");

  const paragraphs: string[] = [];
  const tables: DocTable[] = [];
  if (title) paragraphs.push(unTex(title));
  const ENV = /\\begin\{(tabular|align\*?|aligned|equation\*?|gather\*?|quote|center)\}(\{[^}]*\})?([\s\S]*?)\\end\{\1\}/;
  const MATH_INLINE_BLOCK = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/;

  const pushText = (chunk: string) => {
    const lines = chunk
      .replace(/\\(sub)*section\*?\{([^}]*)\}/g, "\n$2\n")
      .replace(/\\paragraph\*?\{([^}]*)\}/g, "\n$1\n")
      .replace(/\\resizebox\{[^}]*\}\{[^}]*\}\{%?/g, "")
      .split(/\n\s*\n|\n(?=\S)/);
    for (const l of lines) { const t = unTex(l.replace(/\n/g, " ")); if (t && t !== "}") paragraphs.push(t); }
  };
  const pushMath = (body: string) => {
    for (const row of body.split(/\\\\(?:\[[^\]]*\])?/)) { const t = unTexMath(row); if (t) paragraphs.push(t); }
  };

  let rest = src;
  while (rest.trim()) {
    const e = ENV.exec(rest), m = MATH_INLINE_BLOCK.exec(rest);
    const next = [e, m].filter((x): x is RegExpExecArray => !!x).sort((x, y) => x.index - y.index)[0];
    if (!next) { pushText(rest); break; }
    pushText(rest.slice(0, next.index));
    const after = rest.slice(next.index + next[0].length);
    if (next === m) { pushMath(m[1] ?? m[2] ?? ""); rest = after; continue; }
    const [, name, , body] = next;
    if (name === "center") { rest = `${body}\n\n${after}`; continue; }   // 안쪽(tabular)을 다시 훑는다
    if (name === "quote") pushText(body);
    else if (name === "tabular") {
      const rows = body.split(/\\\\/).map((r) => r.replace(/\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, "").trim()).filter(Boolean)
        .map((r) => r.split(/(?<!\\)&/).map((c) => unTex(c)));
      if (rows.length) {
        tables.push({ head: rows[0], rows: rows.slice(1) });
        for (const r of rows) paragraphs.push(r.filter(Boolean).join(" "));   // 표 글자도 본문 규칙이 보게
      }
    } else pushMath(body);
    rest = after;
  }
  return { kind: "text", paragraphs, tables, warnings: [] };
}
