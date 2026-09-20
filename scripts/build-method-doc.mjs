// 산출방법서 Markdown → .docx / .pdf
// pandoc으로 docx와 HTML을 만들고, HTML은 headless chromium으로 인쇄해 PDF로 굳힌다(한글 폰트 때문).
// 실행: node --no-warnings scripts/build-method-doc.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// 인자로 Markdown 경로를 넘기면 그 문서를 만든다. 없으면 산출방법서를 기본으로 한다.
const SRC = process.argv[2] ?? "docs/산출방법서_설계형보험.md";
const BASE = SRC.replace(/\.md$/, "");
const OUT_DOCX = `${BASE}.docx`;
const OUT_PDF = `${BASE}.pdf`;
const TITLE = process.argv[3] ?? "보험료 및 책임준비금 산출방법서";
const TMP = process.env.TEMP ?? ".";
const TMP_MD = join(TMP, "method-doc.md");
const TMP_HTML = join(TMP, "method-doc.html");
const TMP_CSS = join(TMP, "method-doc.css");

// pandoc의 아래·위첨자 문법으로 바꾼다(raw HTML <sub>/<sup>는 docx로 넘어가지 않는다). 첨자 안 공백은 이스케이프해야 한다.
const BS = String.fromCharCode(92);
const esc = (s) => s.split(" ").join(BS + " ");
const md = readFileSync(SRC, "utf8")
  .replace(/<sub>(.*?)<\/sub>/g, (_, x) => `~${esc(x)}~`)
  .replace(/<sup>(.*?)<\/sup>/g, (_, x) => `^${esc(x)}^`);
writeFileSync(TMP_MD, md, "utf8");

const FROM = "markdown+subscript+superscript+pipe_tables";
execFileSync("pandoc", [TMP_MD, "-f", FROM, "-t", "docx", "-o", OUT_DOCX, "--toc", "--toc-depth=2"], { stdio: "inherit" });

writeFileSync(TMP_CSS, `
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Malgun Gothic", "맑은 고딕", sans-serif; font-size: 10.5pt; line-height: 1.55; color: #111; max-width: none; }
h1 { font-size: 18pt; border-bottom: 2px solid #1b2845; padding-bottom: 6px; }
h2 { font-size: 13pt; margin-top: 22px; border-bottom: 1px solid #ccc; padding-bottom: 3px; break-after: avoid; }
h3 { font-size: 11.5pt; margin-top: 16px; break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.5pt; break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4px 7px; text-align: left; vertical-align: top; }
th { background: #f0f2f5; font-weight: 600; }
blockquote { border-left: 3px solid #4a90c2; margin: 8px 0; padding: 2px 12px; color: #444; background: #f7f9fb; }
code { background: #f2f2f2; padding: 0 3px; border-radius: 2px; font-size: 9pt; }
hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
#TOC { break-after: page; }
#TOC ul { list-style: none; padding-left: 14px; }
`, "utf8");

execFileSync("pandoc", [TMP_MD, "-f", FROM, "-t", "html5", "-o", TMP_HTML, "--standalone", "--toc", "--toc-depth=2",
  "--metadata", `title=${TITLE}`, "-c", TMP_CSS, "--embed-resources"], { stdio: "inherit" });

const PW = join(process.env.LOCALAPPDATA ?? "", "npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js");
const CHROME = join(process.env.LOCALAPPDATA ?? "", "ms-playwright/chromium-1234/chrome-win64/chrome.exe");
if (existsSync(CHROME) && existsSync(PW)) {
  const { chromium } = createRequire(import.meta.url)(PW);   // playwright-core는 CJS
  const b = await chromium.launch({ args: ["--headless=new"], executablePath: CHROME });
  const p = await b.newPage();
  await p.goto(pathToFileURL(TMP_HTML).href, { waitUntil: "networkidle" });
  await p.pdf({ path: OUT_PDF, format: "A4", printBackground: true, margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" } });
  await b.close();
  console.log(`${OUT_DOCX}, ${OUT_PDF} 생성`);
} else {
  console.log(`${OUT_DOCX} 생성 (chromium이 없어 PDF는 건너뜀)`);
}
for (const f of [TMP_MD, TMP_HTML, TMP_CSS]) rmSync(f, { force: true });
