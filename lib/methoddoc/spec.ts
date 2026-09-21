/**
 * 산출방법서 중립 모델 (MethodSpec).
 *
 * 이 파일은 어떤 앱에도 딸리지 않는다 — import 가 하나도 없다.
 * 양방향의 가운데 형식이다:
 *   (1) 산출방법서 문서 → parse → MethodSpec → adapter → 앱 입력
 *   (2) 앱 조건/산출 결과 → adapter → MethodSpec → render → 산출방법서
 * 다른 앱에 옮길 때는 이 폴더(lib/methoddoc)만 복사하고 adapter만 새로 쓰면 된다.
 *
 * 설계 원칙
 * - 모든 항목은 선택(optional). 문서에서 못 뽑은 것은 비워 두고 missing 으로 알린다.
 * - 숫자는 정규화한 SI 값(비율은 소수, 금액은 원, 기간은 년)만 담는다. 원문 표기는 Evidence.raw 에.
 * - 문서에만 있고 모델에 자리가 없는 내용은 sections 으로 그대로 보존한다(원본 재현용).
 */

export const METHOD_SPEC_VERSION = "1.0";

export type Sex = "M" | "F";
export type Confidence = "high" | "medium" | "low";

/** 위험률 유형 — 급부·탈퇴·납입면제 연결을 정한다 */
export type RateRole = "death" | "incidence" | "recurring" | "waiver" | "lapse" | "other";
export const RATE_ROLE_LABEL: Record<RateRole, string> = {
  death: "사망", incidence: "최초발생", recurring: "반복지급", waiver: "납입면제", lapse: "해지", other: "기타",
};

/** 위험률 한 계열. values 가 있으면 표까지 실린 것이고, 없으면 출처 문구만 있는 것이다 */
export interface RateRef {
  id: string;
  name: string;
  role: RateRole;
  /** "보험개발원 보험요율1 제2015-1151호(2015.03.20)" 같은 근거 문구 */
  source?: string;
  /** 계수·보정 설명 (예: "× 연령전환계수") */
  adjustment?: string;
  /** 연령 → 값. 표가 같이 온 경우만 */
  table?: { ages: number[]; values: number[]; sex?: Sex };
}

/** 사업비 한 줄 — 산출방법서의 사업비 표를 그대로 담는다 */
export interface ExpenseItem {
  /** 계약체결비용 · 계약관리비용(유지) · 계약관리비용(기타) · 수금비 … */
  group: string;
  /** α_S · α_P · β_S · β_G · β′ · γ 등. 문서에 기호가 없으면 빈 문자열 */
  symbol: string;
  /** "초년도 보험가입금액", "영업보험료", "매년 보험가입금액" … */
  basis: string;
  /** 소수(0.08 = 8% = 80/1000). rate 와 times 중 하나만 채운다 */
  rate?: number;
  /** "기준연납순보험료 × MIN(보험기간,20)" 처럼 배수인 경우 */
  times?: number;
  /** 납입중 / 납입후 / (빈 값) */
  phase?: string;
  /** 원문 표기 그대로 ("80/1000", "9.0%") */
  raw?: string;
}

export interface BenefitSpec {
  id: string;
  name: string;
  /** 급부 유형 — RateRole 과 같은 축 */
  role: Exclude<RateRole, "waiver" | "lapse">;
  /** 지급 사유 문구 ("암으로 진단확정 시", "사망 시") */
  trigger?: string;
  /** 보장금액(원). 일당형은 1일당 */
  amount?: number;
  /** 보장 종료 연령 */
  endAge?: number;
  /** 면책기간(일) */
  waitDays?: number;
  /** 급부 위험률 id */
  rateId?: string;
  /** 탈퇴 위험률 id 목록 */
  exitRateIds?: string[];
  /** 연령 구간별 보장금액 배수 */
  steps?: { fromAge: number; toAge: number; multiple: number }[];
  /** 생존형 지급 시점 */
  points?: { age: number; multiple: number }[];
  /** 어느 계약 단위인지 — 주계약/특약1 … (탭·모듈 구분) */
  unit?: string;
}

/** 계약 단위(주계약·특약) 하나. 조건이 주계약과 같으면 비워 두고 상속한다 */
export interface UnitSpec {
  id: string;
  name: string;
  main: boolean;
  /** 주계약과 다르게 둔 조건만 */
  overrides?: Partial<ContractSpec & BasisSpec>;
  benefitIds: string[];
  rateIds: string[];
}

export interface ContractSpec {
  age?: number; sex?: Sex;
  termYears?: number; termAge?: number;
  payYears?: number; payAge?: number;
  /** 연 납입 횟수 */
  freq?: number;
  sumAssured?: number;
}

export interface BasisSpec {
  /** 적용이율(소수) */
  interest?: number;
  standardInterest?: number;
  /** 최저보증이율 */
  minGuaranteed?: number;
  /** 평균공시이율 */
  averagePublished?: number;
  waiver?: boolean;
  /** 적용해지율 — 종류별로 다를 수 있다 */
  lapse?: { label?: string; rate: number; duringPayOnly?: boolean }[];
  /** 저해지·무해지 환급률(소수). 0 = 무해지 */
  lowRatio?: number;
}

export interface FormulaSpec {
  /** 어느 절에 속하는지 */
  section: string;
  label: string;
  /** 평문 수식. `_{}` `^{}` 아래·위첨자 표기 */
  text: string;
  note?: string;
  /** 이 식이 어느 조건에서 나왔는지 — "benefits[0]", "basis.lapse" (화면에서 조건과 짝지을 때 쓴다) */
  path?: string;
}

/** 가입 조건 한 줄 — 사업방법서·산출방법서의 "보험기간 | 보험료 납입기간 | 가입나이" 표 */
export interface EntryRow {
  /** 담보·종목 구분. 비우면 상품 전체 */
  label?: string;
  /** "80세만기", "20년만기", "종신" */
  term: string;
  /** "10·15·20년납", "전기납", "일시납" */
  pay: string;
  /** "만15세 ~ 65세", "만15세 ~ (80-납입기간)세". 남녀가 다르면 남자 */
  age: string;
  /** 여자 가입나이 — 남자와 다를 때만 */
  ageF?: string;
}

/**
 * 가입 조건 — 산출방법서에 싣는 정보성 자료(판매 범위). 원문 표기 그대로의 글자로 둔다.
 * 보험료 산출에는 쓰지 않는다 — 산출은 contract 의 한 점(시산 기준: 가입나이·보험기간·납입기간 하나씩)으로 한다.
 */
export interface ProductInfo {
  /** 보험의 종류 — "생명보험 / 종신", "장기손해보험 / 장기질병" */
  category?: string;
  /** 보험종목 — "1종(무해지환급형)", "2종(표준형)" */
  types?: string[];
  /** 보험기간·납입기간·가입나이 */
  terms?: EntryRow[];
  /** 보험료 납입주기 — "월납", "연납" … */
  payFreqs?: string[];
  /** 보험가입금액 한도 — "1천만원 ~ 10억원" */
  sumLimit?: string;
  /** 갱신 — "비갱신형", "10년 갱신 (최대 100세)" */
  renewal?: string;
}

/** 가입 조건에 적힌 것이 있는지 */
export const hasProduct = (p?: ProductInfo): p is ProductInfo =>
  !!p && !!(p.category || p.types?.length || p.terms?.length || p.payFreqs?.length || p.sumLimit || p.renewal);

export interface ExtraSection {
  /** "1. 보험료의 계산에 관한 사항" 같은 원문 제목 */
  title: string;
  /** 문단들 */
  paragraphs: string[];
  tables?: { head: string[]; rows: string[][] }[];
}

export interface MethodSpec {
  specVersion: string;
  meta: { productName: string; insurer?: string; version?: string; date?: string; note?: string; kind?: string };
  /** 가입 조건(정보) — 없어도 된다. 예전 JSON 과 다른 앱은 이 칸을 모른다 */
  product?: ProductInfo;
  /** 시산 기준 — 보험료·책임준비금을 실제로 계산하는 계약 한 점 */
  contract: ContractSpec;
  basis: BasisSpec;
  rates: RateRef[];
  expenses: ExpenseItem[];
  benefits: BenefitSpec[];
  units: UnitSpec[];
  reserve: { notes: string[] };
  surrender: { deductionYears?: number; notes: string[] };
  formulas: FormulaSpec[];
  sections: ExtraSection[];
}

export const emptySpec = (productName = ""): MethodSpec => ({
  specVersion: METHOD_SPEC_VERSION,
  meta: { productName },
  contract: {}, basis: {}, rates: [], expenses: [], benefits: [], units: [],
  reserve: { notes: [] }, surrender: { notes: [] }, formulas: [], sections: [],
});

// ── 출처·확신도 ──────────────────────────────────────────────────────────────
/** 뽑아낸 값 하나의 출처. 검수 화면이 이걸로 "어디서 왔는지"를 보여 준다 */
export interface Evidence {
  /** spec 안 경로 — "basis.interest", "expenses[0].rate" */
  path: string;
  label: string;
  /** 정규화된 값 */
  value: string | number | boolean;
  /** 원문 그대로 */
  raw: string;
  /** "표 4 행 2" · "본문 p.3" · "AI 추정" */
  source: string;
  confidence: Confidence;
}

export interface ParseResult {
  spec: MethodSpec;
  evidence: Evidence[];
  /** 못 찾은 필수 항목 */
  missing: string[];
  warnings: string[];
  /** 표준 산출방법서로 읽었으면 그 판 ("표준 산출방법서 v1") — 수식·주석·절까지 읽었다는 뜻 */
  format?: string;
}

/** 검수에서 고른 것만 반영할 수 있게, 경로별로 적용 여부를 받는다 */
export const pickEvidence = (r: ParseResult, accept: (e: Evidence) => boolean): Evidence[] => r.evidence.filter(accept);

// ── 검증 ────────────────────────────────────────────────────────────────────
const RANGE: Record<string, [number, number]> = {
  "basis.interest": [0, 0.2], "basis.standardInterest": [0, 0.2], "basis.minGuaranteed": [0, 0.2],
  "basis.averagePublished": [0, 0.2], "basis.lowRatio": [0, 1],
  "contract.age": [0, 110], "contract.termYears": [1, 110], "contract.payYears": [1, 80], "contract.freq": [1, 12],
};

/** 범위를 벗어나거나 서로 모순인 값을 찾는다. 파싱 결과를 사람이 믿기 전에 거치는 문 */
export function validateSpec(spec: MethodSpec): string[] {
  const out: string[] = [];
  const num = (path: string, v?: number) => {
    if (v === undefined) return;
    const r = RANGE[path];
    if (r && (v < r[0] || v > r[1])) out.push(`${path} = ${v} 는 범위(${r[0]}~${r[1]}) 밖입니다`);
  };
  num("basis.interest", spec.basis.interest);
  num("basis.standardInterest", spec.basis.standardInterest);
  num("basis.minGuaranteed", spec.basis.minGuaranteed);
  num("basis.lowRatio", spec.basis.lowRatio);
  num("contract.age", spec.contract.age);
  num("contract.termYears", spec.contract.termYears);
  num("contract.payYears", spec.contract.payYears);
  num("contract.freq", spec.contract.freq);
  const { termYears, payYears } = spec.contract;
  if (termYears && payYears && payYears > termYears) out.push(`납입기간(${payYears}년)이 보험기간(${termYears}년)보다 깁니다`);
  for (const l of spec.basis.lapse ?? []) if (l.rate < 0 || l.rate > 0.5) out.push(`적용해지율 ${l.rate} 는 범위(0~50%) 밖입니다`);
  for (const e of spec.expenses) {
    if (e.rate !== undefined && (e.rate < 0 || e.rate > 1)) out.push(`사업비 ${e.group}/${e.basis} = ${e.rate} 는 범위(0~100%) 밖입니다`);
  }
  for (const b of spec.benefits) {
    if (b.rateId && !spec.rates.some((r) => r.id === b.rateId)) out.push(`담보 "${b.name}"의 급부 위험률(${b.rateId})이 목록에 없습니다`);
    for (const id of b.exitRateIds ?? []) if (!spec.rates.some((r) => r.id === id)) out.push(`담보 "${b.name}"의 탈퇴 위험률(${id})이 목록에 없습니다`);
  }
  return out;
}
