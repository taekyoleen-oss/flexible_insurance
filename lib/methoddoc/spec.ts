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
  /** "경험생명표(가상) 사망률" 같은 근거 문구 — 저장소가 공개라 견본·샘플에는 실제 출처를 싣지 않는다 */
  source?: string;
  /** 계수·보정 설명 (예: "× 연령전환계수") */
  adjustment?: string;
  /** 연령 → 값. 표가 같이 온 경우만. 남·여 표가 다 있으면 tables 에 두고, 이 칸에는 한 벌(남 → 여)을 둔다(옛 소비자용) */
  table?: { ages: number[]; values: number[]; sex?: Sex };
  /** 남·여 표. 계산하는 앱이 피보험자 성별로 고른다(rateTable) */
  tables?: Partial<Record<Sex, { ages: number[]; values: number[] }>>;
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
  /**
   * 보장금액 = 보험가입금액 × 배수 (사망 1배 · 암 진단 0.5배 …). 실무 산출방법서가 이렇게 적는다 — 보험료는 1원당으로 먼저 내고
   * 맨 뒤에 가입금액 × 배수를 한꺼번에 곱한다. 계산하는 계약의 가입금액(CalcContract.sumAssured)이 곱해진다
   */
  multiple?: number;
  /** 보장금액(원). 배수(multiple)가 없을 때만 — 옛 문서·다른 앱의 절대 금액. 일당형은 1일당 */
  amount?: number;
  /** 보험기간(보장 종료 연령 — 100세 · 종신 110세) */
  endAge?: number;
  /** 면책·삭감 기간(일) — 30 · 90 · 180 · 365 · 730 */
  waitDays?: number;
  /** 면책·삭감 기간 중 지급 비율 — 0 = 면책(지급 없음, 암) · 0.5 = 50% 삭감(특정 사망 등). 없으면 0 */
  waitPayRatio?: number;
  /**
   * 면책과 삭감을 함께 둘 때만 — 삭감 기간(일, 계약일부터)과 그 동안의 지급 비율. 이때 waitDays 는 면책(지급 0) 기간이다.
   * 하나만 있으면 옛 모양(waitDays + waitPayRatio)으로 적는다 — 자유설계보험이 그대로 읽게(coverTerms · withCoverTerms)
   */
  reduceDays?: number;
  reduceRatio?: number;
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
  /** 이 담보가 쓰는 생존자(lx) — survivors[].id. 있으면 탈퇴 위험률(exitRateIds)은 그 생존자의 것으로 맞춘다 */
  survivorId?: string;
}

/** 보장 표의 칸 — 면책(지급 0) 기간 · 삭감 기간(계약일부터) · 삭감 시 지급률. 옛 모양(waitDays + waitPayRatio > 0)은 삭감으로 읽는다 */
export function coverTerms(b: BenefitSpec): { wait?: number; reduce?: number; ratio?: number } {
  if (b.reduceDays) return { wait: b.waitDays, reduce: b.reduceDays, ratio: b.reduceRatio ?? 0.5 };
  if (b.waitDays && b.waitPayRatio) return { reduce: b.waitDays, ratio: b.waitPayRatio };
  return b.waitDays ? { wait: b.waitDays } : {};
}
/** 보장 표의 칸 → 담보 칸. 하나만 있으면 옛 모양, 면책과 삭감이 함께일 때만 reduceDays · reduceRatio */
export function coverFields(c: { wait?: number; reduce?: number; ratio?: number }): Pick<BenefitSpec, "waitDays" | "waitPayRatio" | "reduceDays" | "reduceRatio"> {
  if (c.wait && c.reduce) return { waitDays: c.wait, waitPayRatio: undefined, reduceDays: c.reduce, reduceRatio: c.ratio ?? 0.5 };
  if (c.reduce) return { waitDays: c.reduce, waitPayRatio: c.ratio ?? 0.5, reduceDays: undefined, reduceRatio: undefined };
  return { waitDays: c.wait || undefined, waitPayRatio: undefined, reduceDays: undefined, reduceRatio: undefined };
}

/**
 * 생존자 lx(k) — 탈퇴 위험률로 줄어드는 사람 수(Dx·Nx 까지). 유지자수·납입자수를 나누지 않고 하나로 적는다.
 * 보험금은 이 lx 를 가져다 쓰고, [납입](pay) 생존자는 그 계약 단위의 보험료 납입기수(N*)에 쓴다.
 * 조건에 없으면 담보의 탈퇴 위험률과 납입면제에서 저절로 만든다(deriveSurvivors) — 옛 조건·다른 앱의 JSON 도 그대로 읽힌다.
 */
export interface SurvivorSpec {
  id: string;
  /** 표시 이름(없으면 "생존자(사망X, 암X)") */
  name?: string;
  /** 계약 단위 — 없으면 공통(어느 단위의 담보든 쓸 수 있다) */
  unit?: string;
  /** 줄이는 사유(탈퇴 위험률 id) — 질병끼리 곱, 사망과는 겹치는 부분 절반으로 결합 */
  exitRateIds: string[];
  /** [납입] — 이 생존자로 보험료 납입기수(N*)를 내는 계약 단위(주계약 · 특약 이름). 단위마다 하나 */
  payFor?: string[];
}

/**
 * 위험률 합성 — 여러 위험률을 한 기호(Q^{(j)} · R^{(j)})로 묶은 것. 유지자의 대상 위험률·보험금의 급부 위험률이 가져다 쓴다.
 * 질병(사망 아닌 사유)끼리는 곱, 사망과는 겹치는 부분 절반(탈퇴율 결합 규칙). 산출방법서 "나. 기호의 정의" 아래 표에 싣는다.
 * 조건에 없으면 유지자·보험금이 쓰는 위험률 묶음에서 만든다(combosOf).
 */
export interface ComboSpec {
  id: string;
  /** 표시 이름(없으면 "사망·80% 이상 장해 결합") */
  name?: string;
  rateIds: string[];
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

/**
 * 시산 기준 — 보험료를 실제로 계산하는 계약 한 점(피보험자·기간·주기·가입금액).
 * 산출방법서의 정보가 아니라 계산하는 앱의 입력이다: 산출방법서를 읽을 때는 채우지 않고(parse),
 * 계산하는 앱(자유설계보험 상품 만들기의 "계약정보")이 채운다. 채워져 있을 때만 산출방법서에 싣는다(render).
 */
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
  /**
   * 납입만 면제되는 사유(보장은 이어짐)의 위험률 id — 유형과 상관없이. 유형이 waiver 인 위험률은 적지 않아도 사유다.
   * 예: 종신보험(암진단 포함) — 암 발생률은 암진단 담보의 급부이자 사망 담보의 납입면제 사유.
   * 그 담보의 탈퇴 사유이기도 한 것은 탈퇴로 이미 줄었으므로 그 담보의 납입자수에서 다시 빼지 않는다.
   */
  waiverRateIds?: string[];
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
  /**
   * 자동으로 만든 식의 짝 — "group:g1" · "benefit:b1" · "pv:N" · "premium:G" (formulas.ts 가 붙인다).
   * 계산(calc.ts)과 조건 카드가 이 짝으로 식을 찾는다. 조건 파일(YAML)·JSON 에는 싣지 않는다 — 늘 다시 만든다.
   */
  key?: string;
  /** 사용자가 고친 식인지 (withFormulas 가 표시한다) */
  edited?: boolean;
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
 * 보험료 산출에는 쓰지 않는다 — 산출은 계산하는 앱이 정한 계약 한 점(contract: 가입나이·보험기간·납입기간 하나씩)으로 한다.
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

/** 담보의 보장금액(원) — 배수가 있으면 가입금액 × 배수, 없으면 적힌 금액 */
export const benefitAmount = (b: BenefitSpec, sumAssured: number) => (b.multiple !== undefined ? b.multiple * sumAssured : b.amount ?? 0);

/** 이 나이 이상의 보험기간은 종신 — 사망률 표의 마지막 나이(그 해 사망률 1)까지 보장한다 */
export const WHOLE_LIFE_AGE = 110;
/**
 * 보장기간 n(년). "보험기간 N세" 는 N세 만기 — 가입나이 x 부터 N−1세까지 보장한다(기존 산출방법서와 같다: 40세 · 100세 만기 → 60년,
 * 20세 가입 20년 보장 → 39세까지). 종신(110세 이상)은 그 나이의 해까지(40세 → 71년).
 */
export const coverYears = (endAge: number | undefined, age: number) => {
  const end = endAge ?? WHOLE_LIFE_AGE;
  return Math.max(1, end >= WHOLE_LIFE_AGE ? end + 1 - age : end - age);
};
export const endAgeLabel = (endAge?: number) => (endAge === undefined ? "—" : endAge >= WHOLE_LIFE_AGE ? `종신 (${endAge}세)` : `${endAge}세 만기`);
/**
 * 계산하는 앱(자유설계보험)의 "보장 종료 연령"(그 나이까지 포함) ↔ 이 모듈의 만기 나이. 종신은 같은 수다.
 * ponytail: 보장 종료 109세는 만기 110세 = 종신으로 바뀐다(한 해 더) — 110세 정기 만기가 필요하면 종신 표시를 따로 둔다
 */
export const lastCoveredAge = (endAge: number) => (endAge >= WHOLE_LIFE_AGE ? endAge : endAge - 1);
export const maturityAge = (lastAge: number) => (lastAge >= WHOLE_LIFE_AGE ? lastAge : lastAge + 1);

/** 계약 단위 이름 — 비어 있으면 주계약 */
export const MAIN_UNIT = "주계약";
export const unitOf = (b: BenefitSpec) => b.unit?.trim() || MAIN_UNIT;
/** 조건에 나오는 계약 단위(주계약 먼저) — 담보의 unit 이름에서 만든다(따로 적는 항목이 아니다). units 가 적혀 있으면 그 이름도 */
export function unitNames(spec: MethodSpec): string[] {
  const names = [...spec.units.map((u) => u.name), ...spec.benefits.map(unitOf)];
  return [MAIN_UNIT, ...new Set(names.filter((n) => n !== MAIN_UNIT))];
}

/** 시산 기준이 적혀 있는지 */
export const hasContract = (c?: ContractSpec): c is ContractSpec => !!c && Object.values(c).some((v) => v !== undefined);

/** 그 성별의 위험률 표 — tables 에 있으면 그것, 없으면 table(한 벌) */
export function rateTable(r: RateRef, sex?: Sex): { ages: number[]; values: number[]; sex?: Sex } | undefined {
  const t = sex ? r.tables?.[sex] : undefined;
  return t ? { ...t, sex } : r.table;
}

/** 납입면제 사유 위험률 — 유형이 waiver 인 것 + basis.waiverRateIds. 납입면제를 켜지 않았으면 없다 */
export const waiverRates = (spec: MethodSpec): RateRef[] =>
  spec.basis.waiver ? spec.rates.filter((r) => r.role === "waiver" || spec.basis.waiverRateIds?.includes(r.id)) : [];

/** 가입 조건에 적힌 것이 있는지 */
export const hasProduct = (p?: ProductInfo): p is ProductInfo =>
  !!p && !!(p.category || p.types?.length || p.terms?.length || p.payFreqs?.length || p.sumLimit || p.renewal);

/**
 * 공시이율형 적립 저축보험(적립형) — 있으면 보장성 식(유지자·보험금·보험료) 대신 적립형 식을 쓴다(savings.ts).
 * 보험료는 계약자가 정한 **월 기본보험료**이고, 식과 값은 모두 기본보험료 1원당이다(맨 뒤에 기본보험료를 곱한다).
 * 보장부분 확정이율은 basis.interest, 평균공시이율은 basis.averagePublished 에 둔다. 사업비는 expenses 의 α · α′ · β(기본보험료 대비).
 */
export interface SavingsSpec {
  /** 공시이율(예시) — 매월 회사가 정한다 */
  credited: number;
  /** 최저보증이율 — 경과 from 년부터 rate (from 오름차순, 첫 줄 from 0) */
  guarantee: { from: number; rate: number }[];
  /** 사망보험금 = 기본보험료 × deathMultiple + 계약자적립액 (500% → 5) */
  deathMultiple: number;
  /** 만기환급금 최저보증 — 납입보험료 × maturityFloor (100.1% → 1.001) */
  maturityFloor: number;
  /** 계약체결비용 α 를 쓰는 기간(년). 그 뒤는 α′ */
  alphaYears: number;
  /** 해약공제 = 기본보험료 × deductRatio × max(0, deductYears − t)/deductYears */
  deductRatio: number;
  deductYears: number;
}

/** 적립형인지 */
export const isSavings = (spec: MethodSpec): spec is MethodSpec & { savings: SavingsSpec } => !!spec.savings;

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
  /** 시산 기준 — 계산하는 앱이 채운다. 산출방법서를 읽은 조건에는 비어 있다 */
  contract: ContractSpec;
  basis: BasisSpec;
  rates: RateRef[];
  expenses: ExpenseItem[];
  benefits: BenefitSpec[];
  /** 생존자 lx(k) — 없으면 담보의 탈퇴 위험률·납입면제에서 만든다 */
  survivors?: SurvivorSpec[];
  /** 위험률 합성 — 없으면 유지자·보험금이 쓰는 위험률 묶음에서 만든다 */
  combos?: ComboSpec[];
  units: UnitSpec[];
  /** 적립형(공시이율형 저축보험) — 있으면 보장성 식 대신 적립형 식 */
  savings?: SavingsSpec;
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
  for (const id of spec.basis.waiverRateIds ?? []) if (!spec.rates.some((r) => r.id === id)) out.push(`납입면제 사유 위험률(${id})이 목록에 없습니다`);
  for (const c of spec.combos ?? []) for (const id of c.rateIds) if (!spec.rates.some((r) => r.id === id)) out.push(`위험률 합성 "${c.name ?? c.id}"의 위험률(${id})이 목록에 없습니다`);
  for (const b of spec.benefits) {
    if (b.multiple !== undefined && (b.multiple <= 0 || b.multiple > 100)) out.push(`담보 "${b.name}"의 보장금액 배수 ${b.multiple} 는 범위(0~100배) 밖입니다`);
    if (b.waitPayRatio !== undefined && (b.waitPayRatio < 0 || b.waitPayRatio > 1)) out.push(`담보 "${b.name}"의 면책·삭감 지급 비율 ${b.waitPayRatio} 는 범위(0~100%) 밖입니다`);
    if (b.rateId && !spec.rates.some((r) => r.id === b.rateId) && !spec.combos?.some((c) => c.id === b.rateId)) out.push(`담보 "${b.name}"의 급부 위험률(${b.rateId})이 목록에 없습니다`);
    for (const id of b.exitRateIds ?? []) if (!spec.rates.some((r) => r.id === id)) out.push(`담보 "${b.name}"의 탈퇴 위험률(${id})이 목록에 없습니다`);
  }
  return out;
}
