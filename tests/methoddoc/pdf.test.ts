import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extractDoc } from "@/lib/methoddoc/extract";
import { parseMethodDoc } from "@/lib/methoddoc/parse";

const OWN_PDF = "docs/산출방법서_설계형보험.pdf";
const DOCS = "C:/Users/tklee/OneDrive - 코리안리재보험/0. 보험료 산출 방법서";
function find(dir: string, re: RegExp): string | null {
  try { for (const f of readdirSync(dir)) if (re.test(f.normalize("NFC"))) return `${dir}/${f}`; } catch { /* 없으면 건너뛴다 */ }
  return null;
}
const SCANNED = find(DOCS, /용감한 종신 산방서\.pdf$/) ?? "";
const read = (p: string) => new Uint8Array(readFileSync(p));
const has = (p: string) => !!p && existsSync(p);

describe("PDF 추출", () => {
  it.runIf(has(OWN_PDF))("텍스트 PDF 에서 문단과 표를 읽는다", async () => {
    const d = await extractDoc("a.pdf", read(OWN_PDF));
    expect(d.kind).toBe("pdf");
    expect(d.paragraphs.length).toBeGreaterThan(80);
    expect(d.paragraphs.join("\n")).toContain("산출방법서");
    expect(d.tables.length).toBeGreaterThan(3);              // 좌표로 되살린 표
    expect(d.warnings.join(" ")).toMatch(/표 구조/);
  }, 60000);
  it.runIf(has(OWN_PDF))("제목과 값이 다른 줄에 있어도 뽑는다 (나. 표준이율 → 연복리 3.25%)", async () => {
    const r = parseMethodDoc(await extractDoc("a.pdf", read(OWN_PDF)));
    expect(r.spec.basis.standardInterest).toBeCloseTo(0.0325, 12);
    const ev = r.evidence.find((e) => e.path === "basis.standardInterest")!;
    expect(ev.raw).toContain("표준이율");          // 제목을 함께 원문으로 남긴다
    expect(r.evidence.length).toBeGreaterThan(3);
  }, 60000);
  it.runIf(has(SCANNED))("스캔 PDF 는 why=scanned 로 막고 대안을 알려준다", async () => {
    await expect(extractDoc("s.pdf", read(SCANNED))).rejects.toMatchObject({ why: "scanned" });
  }, 60000);
});
