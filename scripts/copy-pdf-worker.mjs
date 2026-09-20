// pdfjs 워커를 public/ 으로 복사한다. 브라우저는 workerSrc 경로가 있어야 PDF 를 연다.
// node_modules 에서 가져오므로 저장소에는 1.3MB 파일을 커밋하지 않는다(public/pdf.worker.min.mjs 는 .gitignore).
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const src = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "legacy/build/pdf.worker.min.mjs");
const dst = "public/pdf.worker.min.mjs";
if (!existsSync(src)) { console.error("pdfjs-dist 워커를 찾지 못했습니다:", src); process.exit(1); }
mkdirSync("public", { recursive: true });
copyFileSync(src, dst);
console.log(`${dst} (${Math.round(statSync(dst).size / 1024)}KB) 복사`);
