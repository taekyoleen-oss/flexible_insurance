import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { extractDoc } from "@/lib/methoddoc/extract";
import { parseMethodDoc } from "@/lib/methoddoc/parse";
import type { ParseResult } from "@/lib/methoddoc/spec";

/**
 * 실제 산출방법서 PDF 7건 회귀 테스트.
 * 회사마다 표기가 달라 사전을 넓힐 때마다 여기 값이 지켜지는지로 확인한다.
 * 문서는 OneDrive 에 있어 없는 환경에서는 통째로 건너뛴다.
 */
const ROOT = "C:/Users/tklee/OneDrive - 코리안리재보험/0. 보험료 산출 방법서";

/** OneDrive 는 한글 파일명을 NFD 로 저장해 문자열 비교가 어긋난다 — 훑어서 정규화해 찾는다 */
function find(dirFrag: string, fileFrag: string): string | null {
  try {
    const dir = readdirSync(ROOT).find((d) => d.normalize("NFC").includes(dirFrag));
    if (!dir) return null;
    const f = readdirSync(`${ROOT}/${dir}`).find((x) => /\.pdf$/i.test(x) && x.normalize("NFC").includes(fileFrag));
    return f ? `${ROOT}/${dir}/${f}` : null;
  } catch { return null; }
}

interface Case {
  key: string; dir: string; file: string;
  productName: string;
  interest: number;
  /** 사업비 최소 건수 (0 이면 이 문서에서는 못 뽑는 게 정상) */
  expenses: number;
  /** 위험률 목록에 반드시 있어야 하는 이름 조각 */
  rates: string[];
  extra?: (r: ParseResult) => void;
}

const CASES: Case[] = [
  { key: "여성건강", dir: "여성건강보험", file: "무배당e여성건강보험", productName: "무배당 e여성건강보험",
    interest: 0.025, expenses: 6, rates: ["3대암발생률", "뇌출혈 발생률", "급성심근경색증 발생률"],
    extra: (r) => {
      // α1·α2·β1 기호가 그대로 남아야 한다 (표에 기호로만 적힌 문서)
      expect(r.spec.expenses.map((e) => e.symbol)).toEqual(expect.arrayContaining(["α1", "α2", "β1"]));
      // 기준연납순보험료 기준은 비율이 아니라 배수로 담는다
      expect(r.spec.expenses.find((e) => /기준연납순보험료/.test(e.basis))?.times).toBeCloseTo(0.035, 12);
    } },
  { key: "교보CI종신", dir: "교보 CI종신", file: "무배당교보CI종신보험 산출방법서", productName: "07.무배당교보CI종신보험 산출방법서",
    interest: 0.04, expenses: 1, rates: ["무배당 예정 사망률"],
    // 두 단 편집이라 규칙이 제목과 값을 못 이어 붙인다 — 추정이므로 확신도는 low
    extra: (r) => expect(r.evidence.find((e) => e.path === "basis.interest")!.confidence).toBe("low") },
  { key: "교직원공제", dir: "교직원 공제", file: "실속건강공제", productName: "교육가족 실속건강공제",
    interest: 0.0425, expenses: 4, rates: ["교직원사망률"],
    extra: (r) => expect(r.spec.expenses.map((e) => e.symbol)).toEqual(expect.arrayContaining(["α_S", "γ"])) },
  { key: "레이디플러스", dir: "더케이 건강보험", file: "레이디플러스", productName: "무배당 레이디플러스 건강보험",
    interest: 0.025, expenses: 0, rates: ["일반상해사망률"],
    extra: (r) => {
      expect(r.spec.basis.averagePublished).toBeCloseTo(0.03, 12);   // "평균공시이율 + 1%" 를 1% 로 읽지 않는다
      // 이 문서는 적용해지율 5%/3%/1% 를 표로 싣는다. "3.00%" 안의 "0%" 를 0 으로 줍지는 않는다
      expect(r.spec.basis.lapse?.map((x) => x.rate)).toEqual([0.05, 0.03, 0.01]);
      expect(r.spec.rates.every((x) => x.role !== "lapse")).toBe(true);
    } },
  { key: "흥국메디컬", dir: "메디컬종신", file: "흥국메디컬종신", productName: "무배당 메디컬(Medical)종신의료보험",
    interest: 0.045, expenses: 0, rates: ["입원율"] },          // 전각 ％ ("연 4.5％ 복리")
  { key: "MG더블종신", dir: "새마을", file: "MG 더블종신공제", productName: "무배당 MG 더블종신공제",
    interest: 0.035, expenses: 3, rates: ["뇌출혈 발생률", "급성심근경색증 발생률"],
    // 제목 행("2. 예정이율에 관한 사항")과 값 행("연복리 3.5%")이 갈린 표
    extra: (r) => expect(r.evidence.find((e) => e.path === "basis.interest")!.source).toMatch(/^표/) },
  { key: "납입지원특약", dir: "보험료납입지원", file: "보험료납입지원 특별약관", productName: "003_보험료납입지원 특별약관_산출방법서",
    interest: 0.0325, expenses: 0, rates: ["뇌졸중발생률", "급성심근경색증발생률"],
    extra: (r) => {
      expect(r.spec.basis.minGuaranteed).toBeCloseTo(0.01, 12);
      expect(r.spec.basis.standardInterest).toBeUndefined();          // "표준이율의 125%" 를 표준이율 125 로 읽지 않는다
    } },
];

const paths = new Map(CASES.map((c) => [c.key, find(c.dir, c.file) ?? ""]));
const ALL = CASES.every((c) => existsSync(paths.get(c.key)!));

describe.runIf(ALL)("실제 산출방법서 PDF 7건", () => {
  const parsed = new Map<string, ParseResult>();
  beforeAll(async () => {
    for (const c of CASES) {
      const p = paths.get(c.key)!;
      const doc = await extractDoc(p.split("/").pop()!.normalize("NFC"), new Uint8Array(readFileSync(p)));
      parsed.set(c.key, parseMethodDoc(doc, { fallbackName: p.split("/").pop()!.normalize("NFC").replace(/\.[^.]+$/, "") }));
    }
  }, 600000);

  for (const c of CASES) {
    it(`${c.key}: 상품명·이율·사업비·위험률`, () => {
      const r = parsed.get(c.key)!;
      expect(r.spec.meta.productName).toBe(c.productName);
      expect(r.spec.basis.interest).toBeCloseTo(c.interest, 12);
      expect(r.spec.expenses.length).toBeGreaterThanOrEqual(c.expenses);
      const names = r.spec.rates.map((x) => x.name).join(" | ");
      for (const want of c.rates) expect(names).toContain(want);
      // 범위를 벗어난 값이 남아 있으면 안 된다
      expect(r.warnings.filter((w) => /범위/.test(w))).toEqual([]);
      c.extra?.(r);
    });
  }

  it("사업비 비율은 모두 0~100% 안이고, 이율은 0~20% 안이다", () => {
    for (const c of CASES) {
      const s = parsed.get(c.key)!.spec;
      for (const e of s.expenses) {
        if (e.rate === undefined) continue;
        expect(e.rate).toBeGreaterThan(0);
        expect(e.rate).toBeLessThanOrEqual(1);
      }
      for (const v of [s.basis.interest, s.basis.standardInterest, s.basis.minGuaranteed, s.basis.averagePublished]) {
        if (v === undefined) continue;
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(0.2);
      }
    }
  });
});
