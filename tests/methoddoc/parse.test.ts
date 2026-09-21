import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extractDoc, extractDocx, extractHwp, extractText, drmSignature } from "@/lib/methoddoc/extract";
import { parseMethodDoc, parseRate, parseTimes } from "@/lib/methoddoc/parse";
import { renderMethodDoc, docToMarkdown, docToHtml } from "@/lib/methoddoc/render";
import { emptySpec, validateSpec } from "@/lib/methoddoc/spec";

const DOCS = "C:/Users/tklee/OneDrive - 코리안리재보험/0. 보험료 산출 방법서";
const REAL_DOCX = `${DOCS}/04_산출방법서(무배당간병비주는치매보험(무해지환급형))_20180101.docx`;
const REAL_HWP = `${DOCS}/003_무배당 알파Plus보장보험1907_산출방법서.hwp`;
// OneDrive 는 한글 파일명을 NFD 로 저장해 문자열 비교가 어긋난다 — 디렉터리를 훑어 정규화해 찾는다
function find(dir: string, re: RegExp): string | null {
  try {
    for (const f of readdirSync(dir)) if (re.test(f.normalize("NFC"))) return `${dir}/${f}`;
  } catch { /* 폴더가 없으면 건너뛴다 */ }
  return null;
}
const LOW_DIR = find(DOCS, /^저해지상품$/);
const DRM_DIR = LOW_DIR ? find(LOW_DIR, /^무배당 신협종신공제$/) : null;
const DRM_HWP = (DRM_DIR && find(DRM_DIR, /저해지환급금형.*산출방법서\.hwp$/)) ?? "";
const read = (p: string) => new Uint8Array(readFileSync(p));
const has = (p: string) => !!p && existsSync(p);

describe("단위 정규화", () => {
  it("%·/1000·‰·맨 숫자", () => {
    expect(parseRate("2.5%")).toBeCloseTo(0.025, 12);
    expect(parseRate("80/1000")).toBeCloseTo(0.08, 12);
    expect(parseRate("6.8/1,000")).toBeCloseTo(0.0068, 12);
    expect(parseRate("1‰")).toBeCloseTo(0.001, 12);
    expect(parseRate("0.15")).toBeCloseTo(0.15, 12);
    expect(parseRate("15")).toBe(null);        // 1 초과 맨 숫자는 비율로 보지 않는다
    expect(parseRate("가")).toBe(null);
  });
  it("배수", () => { expect(parseTimes("1.3배")).toBe(1.3); expect(parseTimes("15%")).toBe(null); });
});

describe("텍스트 추출", () => {
  it("텍스트 파일", () => {
    const d = extractText(new TextEncoder().encode("첫 줄\n\n둘째 줄  \n"));
    expect(d.paragraphs).toEqual(["첫 줄", "둘째 줄"]);
  });
  it("DRM 서명을 알아본다", () => {
    expect(drmSignature(new TextEncoder().encode("<DOCUMENT SAFER V2010 R2>abc"))).toBe("<DOCUMENT SAFER V2010 R2>");
    expect(drmSignature(new TextEncoder().encode("PK\u0003\u0004"))).toBe(null);
  });
  it("깨진 PDF 는 이유를 알려주고 멈춘다", async () => {
    await expect(extractDoc("a.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46]))).rejects.toMatchObject({ why: "corrupt" });
  }, 30000);
  it("구형 HWP 는 지원하지 않는다고 알려준다", async () => {
    await expect(extractDoc("a.hwp", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toMatchObject({ why: "unsupported" });
  });
  it.runIf(has(DRM_HWP))("DRM 파일은 why=drm 으로 막는다", async () => {
    await expect(extractDoc("x.hwp", read(DRM_HWP))).rejects.toMatchObject({ why: "drm" });
  });
});

describe.runIf(has(REAL_DOCX))("실제 산출방법서 (DOCX · 무배당 간병비 주는 치매보험 무해지환급형)", () => {
  it("문단과 표를 읽는다", async () => {
    const d = await extractDocx(read(REAL_DOCX));
    expect(d.paragraphs.length).toBeGreaterThan(50);
    expect(d.tables.length).toBeGreaterThanOrEqual(5);
    expect(d.paragraphs[0]).toContain("치매보험");
  });
  it("사업비 표를 항목으로 뽑는다 (80/1000 · 15% · 6.8/1,000 · 9.0% · 2.5%)", async () => {
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    const e = r.spec.expenses;
    expect(e.length).toBeGreaterThanOrEqual(5);
    const byRaw = (raw: string) => e.find((x) => x.raw === raw);
    expect(byRaw("80/1000")?.rate).toBeCloseTo(0.08, 12);
    expect(byRaw("80/1000")?.group).toContain("계약체결");
    expect(byRaw("6.8/1,000")?.rate).toBeCloseTo(0.0068, 12);
    expect(byRaw("9.0%")?.rate).toBeCloseTo(0.09, 12);
    expect(byRaw("2.5%")?.rate).toBeCloseTo(0.025, 12);
    // "기준연납순보험료 X MIN(보험기간,20) | 15%" 는 비율이 아니라 20년치 배수 3배로 본다
    expect(byRaw("15%")?.times).toBeCloseTo(3, 12);
    expect(byRaw("15%")?.basis).toContain("기준연납순보험료");
  });
  it("이율 2.5% 와 무해지 해지율 4.0%(납입기간 중)를 뽑는다", async () => {
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    expect(r.spec.basis.interest).toBeCloseTo(0.025, 12);
    expect(r.spec.basis.lapse?.some((l) => Math.abs(l.rate - 0.04) < 1e-12 && l.duringPayOnly)).toBe(true);
    expect(r.spec.basis.lowRatio).toBe(0);                       // 무해지 → 환급률 0
    const ev = r.evidence.find((e) => e.path === "basis.interest")!;
    expect(ev.confidence).toBe("high");
    expect(ev.source).toMatch(/^표/);
  });
  it("위험률 근거 문구를 계열별로 줍는다", async () => {
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    const names = r.spec.rates.map((x) => x.name);
    expect(names.some((x) => /중증치매발생률/.test(x))).toBe(true);
    expect(names.some((x) => /중증치매\s*사망률/.test(x))).toBe(true);
    expect(r.spec.rates.find((x) => /사망률/.test(x.name))?.role).toBe("death");
    expect(r.spec.rates.some((x) => /보험개발원/.test(x.source ?? ""))).toBe(true);
  });
  it("원문 절을 보존하고, 못 찾은 항목을 알려준다", async () => {
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    expect(r.spec.sections.map((s) => s.title).some((t) => /책임준비금/.test(t))).toBe(true);
    expect(Array.isArray(r.missing)).toBe(true);
  });
});

describe.runIf(has(REAL_HWP))("실제 산출방법서 (HWP 5.x · 무배당 알파Plus보장보험)", () => {
  it("OLE2 를 직접 읽어 문단을 뽑고 수식 객체는 표시만 남긴다", async () => {
    const d = await extractHwp(read(REAL_HWP));
    expect(d.paragraphs.length).toBeGreaterThan(500);
    expect(d.paragraphs.join("\n")).toContain("산출방법서");
    expect(d.warnings.join(" ")).toMatch(/수식/);
  });
  it("적용이율 2.5% · 최저보증이율 0.3% · 위험률 목록을 뽑는다", async () => {
    const r = parseMethodDoc(await extractHwp(read(REAL_HWP)));
    expect(r.spec.basis.interest).toBeCloseTo(0.025, 12);
    expect(r.spec.basis.minGuaranteed).toBeCloseTo(0.003, 12);
    const names = r.spec.rates.map((x) => x.name);
    expect(names.some((x) => /일반상해사망률/.test(x))).toBe(true);
    expect(names.some((x) => /후유장해/.test(x))).toBe(true);
    expect(r.spec.rates.find((x) => /일반상해사망률/.test(x.name))?.role).toBe("death");
  });
});

describe("검증", () => {
  it("범위를 벗어나면 잡아낸다", () => {
    const s = emptySpec("x");
    s.basis.interest = 0.9;
    s.contract.termYears = 20; s.contract.payYears = 30;
    const w = validateSpec(s);
    expect(w.some((x) => x.includes("basis.interest"))).toBe(true);
    expect(w.some((x) => x.includes("납입기간"))).toBe(true);
  });
  it("담보가 없는 위험률을 가리키면 잡아낸다", () => {
    const s = emptySpec("x");
    s.benefits = [{ id: "b1", name: "사망", role: "death", rateId: "없음" }];
    expect(validateSpec(s).some((x) => x.includes("급부 위험률"))).toBe(true);
  });
});

describe("되돌리기 (MethodSpec → 산출방법서)", () => {
  it("빈 스펙도 목차가 나온다", () => {
    const sections = renderMethodDoc(emptySpec("테스트 상품"));
    expect(sections.map((s) => s.title)).toContain("1. 기초율에 관한 사항");
    expect(docToMarkdown(sections, "제목")).toContain("# 제목");
  });
  it("읽은 문서를 그대로 다시 산출방법서로 낸다 (왕복)", async () => {
    if (!has(REAL_DOCX)) return;
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    const md = docToMarkdown(renderMethodDoc(r.spec), "왕복");
    expect(md).toContain("2.500%");                 // 이율
    expect(md).toContain("80/1000");                // 사업비 원문 표기 보존
    expect(md).toMatch(/무해지|4\.0%/);             // 해지율
    expect(md).toContain("중증치매");               // 위험률
    const html = docToHtml(renderMethodDoc(r.spec), "왕복");
    expect(html).toContain("<table>");
    expect(html).toContain("<sub>");                // 수식 첨자
  });
});

describe("위험률 이름 걸러내기", () => {
  it("수익성 분석의 '최적OO율'·할인율 같은 잡음은 위험률로 보지 않는다", async () => {
    const { looksLikeRateName } = await import("@/lib/methoddoc/parse");
    for (const bad of ["최적위험률", "최적해지율", "최적사업비율", "투자수익률", "할인율", "(1) 최적 기초율", "기초율", "(2) 목표수익률", "법인세율"]) {
      expect(looksLikeRateName(bad), bad).toBe(false);
    }
    for (const ok of ["일반상해사망률", "무배당 예정 경험중증치매발생률", "암발생률", "일반상해입원율", "후유장해지급률", "교통상해사망률"]) {
      expect(looksLikeRateName(ok), ok).toBe(true);
    }
  });
  it.runIf(has(REAL_DOCX))("실제 문서에서도 잡음이 빠진다", async () => {
    const r = parseMethodDoc(await extractDocx(read(REAL_DOCX)));
    const names = r.spec.rates.map((x) => x.name);
    expect(names.some((x) => /최적|할인율|목표수익/.test(x))).toBe(false);
    expect(names.some((x) => /치매/.test(x))).toBe(true);
  });
  it.runIf(has(REAL_HWP))("HWP 에서도 상해·질병 위험률만 남는다", async () => {
    const r = parseMethodDoc(await extractHwp(read(REAL_HWP)));
    const names = r.spec.rates.map((x) => x.name);
    expect(names.length).toBeGreaterThan(3);
    expect(names.some((x) => /최적|할인율|투자수익/.test(x))).toBe(false);
    expect(names.some((x) => /상해/.test(x))).toBe(true);
  });
});
