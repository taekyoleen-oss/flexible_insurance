import * as XLSX from "xlsx";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import cancerHosp from "@/lib/engine/data/rates-cancer-hosp.json";
import ciRates from "@/lib/engine/data/rates-ci.json";
import dis80Rates from "@/lib/engine/data/rates-dis80.json";
import type { RateTable, Sex } from "@/lib/engine";
import { colLetter, evaluateSheet, type CellError, type SheetValues } from "./sheet-formula";

export const MAX_AGE = 120;
const TABLE = kli7 as RateTable;
const CANCER = cancerRates as RateTable;
const HOSP = cancerHosp as { M: number[]; F: number[] };
const CI = ciRates as { stroke: { M: number[]; F: number[] }; ami: { M: number[]; F: number[] } };
const DIS80 = dis80Rates as { M: number[]; F: number[] };

/**
 * 위험률 유형. 담보·납입면제와 어떻게 이어지는지를 이 값이 정한다.
 * - death     사망: 모든 담보의 탈퇴에 들어가고, 사망형 담보의 급부가 된다
 * - incidence 최초발생: 1회 지급 후 그 담보가 소멸 → 그 담보의 탈퇴에 들어간다
 * - recurring 반복지급: 여러 번 지급(입원일당 등) → 담보를 소멸시키지 않는다
 * - other     기타: 상수·계수·파생값. 납입면제율을 직접 만들 때 쓴다
 */
export type RateKind = "death" | "incidence" | "recurring" | "other";

export const RATE_KINDS: { kind: RateKind; label: string; hint: string }[] = [
  { kind: "death", label: "사망", hint: "모든 담보의 탈퇴에 들어가고, 사망형 담보의 급부가 됩니다" },
  { kind: "incidence", label: "최초발생", hint: "1회 지급 후 그 담보가 소멸합니다 — 그 담보의 탈퇴에 들어갑니다" },
  { kind: "recurring", label: "반복지급", hint: "여러 번 지급합니다(입원 1일당 등). 담보를 소멸시키지 않습니다" },
  { kind: "other", label: "기타", hint: "상수·계수·파생값. 납입면제율을 다른 열에서 계산할 때 씁니다" },
];
export const kindLabel = (k: RateKind) => RATE_KINDS.find((x) => x.kind === k)?.label ?? k;

/** 시트의 열 하나. cells[r]는 원본 입력(숫자 또는 `=수식`) */
export interface RateColumn { id: string; name: string; kind: RateKind; waiver: boolean; cells: string[]; /** 불러온 표의 근거(산출방법서에 싣는다) */ source?: string }
/** A열 = 연령(읽기 전용), B열부터 columns */
export interface RateSheet { ages: number[]; columns: RateColumn[] }

export const newColId = () => `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// ── 평가 ────────────────────────────────────────────────────────────────────
export interface ResolvedSheet extends SheetValues { byId: Record<string, number[]>; errorCount: number }

/** 시트를 계산해 열별 행 값을 돌려준다. A열(연령)은 values[r][0] */
export function resolveSheet(s: RateSheet): ResolvedSheet {
  const rows = s.ages.length, cols = s.columns.length + 1;
  const res = evaluateSheet({
    rows, cols,
    raw: (r, c) => (c === 0 ? String(s.ages[r] ?? "") : s.columns[c - 1]?.cells[r] ?? ""),
  });
  const byId: Record<string, number[]> = {};
  s.columns.forEach((col, i) => { byId[col.id] = res.values.map((row) => row[i + 1]); });
  let errorCount = 0;
  for (const row of res.errors) for (const e of row) if (e) errorCount++;
  return { ...res, byId, errorCount };
}

/** 첫 오류 칸의 위치와 코드 (상태 배지·메시지용) */
export function firstError(s: RateSheet, r: ResolvedSheet): { cell: string; code: CellError } | null {
  for (let row = 0; row < r.errors.length; row++) {
    for (let c = 0; c < r.errors[row].length; c++) {
      const e = r.errors[row][c];
      if (e) return { cell: `${colLetter(c)}${row + 1}`, code: e };
    }
  }
  return null;
}

/**
 * 행 값 → 연령 인덱스 배열. 표에 없는 나이는 바로 앞 나이 값을 그대로 쓴다(첫 나이 앞은 첫 값, 마지막 뒤는 마지막 값).
 * 표가 보험기간을 못 덮을 때 보험료가 조용히 0이 되는 것을 막는다 — 화면에는 rateCoverage()로 경고를 띄운다.
 */
export function toAgeArray(ages: number[], values: number[]): number[] {
  const out = new Array<number>(MAX_AGE + 1).fill(0);
  const pairs = ages.map((a, i) => [Math.round(a), values[i] ?? 0] as const).filter(([a]) => a >= 0 && a <= MAX_AGE).sort((x, y) => x[0] - y[0]);
  if (pairs.length === 0) return out;
  let j = 0, cur = pairs[0][1];
  for (let a = 0; a <= MAX_AGE; a++) {
    while (j < pairs.length && pairs[j][0] <= a) { cur = pairs[j][1]; j++; }
    out[a] = a < pairs[0][0] ? pairs[0][1] : cur;
  }
  return out;
}

/**
 * 여러 탈퇴 사유를 하나의 탈퇴율로 묶는다. 산출방법서의 잔존 식을 그대로 따른다:
 *   사유 하나      1 − q
 *   사유 둘        1 − q − k + q·k/2
 *   사유 셋 이상   1 − Σd + Σ_{i<j} dᵢ·dⱼ / 2
 * 돌려주는 값은 탈퇴율(= 1 − 잔존율)이며 1 을 넘지 않는다(사망률이 1 인 나이).
 */
export function combineDecrements(arrs: number[][]): number[] {
  const len = Math.max(0, ...arrs.map((a) => a.length));
  return Array.from({ length: len }, (_, i) => {
    let sum = 0, sq = 0;
    for (const a of arrs) { const d = a[i] ?? 0; sum += d; sq += d * d; }
    return Math.min(1, sum - (sum * sum - sq) / 4);      // Σ_{i<j} dᵢdⱼ = (Σ² − Σd²)/2
  });
}

/** 여러 열을 탈퇴율로 묶은 연령 인덱스 배열 */
export const combineColumns = (s: RateSheet, r: ResolvedSheet, ids: string[]) =>
  combineDecrements(ids.filter((id) => r.byId[id]).map((id) => toAgeArray(s.ages, r.byId[id])));

/** 한 열의 연령 인덱스 배열 */
export const columnArray = (s: RateSheet, r: ResolvedSheet, id: string) =>
  r.byId[id] ? toAgeArray(s.ages, r.byId[id]) : new Array<number>(MAX_AGE + 1).fill(0);

/** 표가 가입나이~만기를 덮는지 */
export function rateCoverage(s: RateSheet, age: number, endAge: number): { ok: boolean; min: number; max: number } {
  if (s.ages.length === 0) return { ok: false, min: 0, max: 0 };
  const min = Math.min(...s.ages), max = Math.max(...s.ages);
  return { ok: min <= age && max >= endAge, min, max };
}

/** 사망 열 id 목록 — 담보 탈퇴의 기본값 */
export const deathCols = (s: RateSheet) => s.columns.filter((c) => c.kind === "death").map((c) => c.id);
/** 납입면제 열 id 목록 */
export const waiverCols = (s: RateSheet) => s.columns.filter((c) => c.waiver).map((c) => c.id);

// ── 붙여넣기·파일 ────────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s%]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return v.includes("%") ? n / 100 : n;
};

export interface ParsedTable { ages: number[]; columns: { name: string; cells: string[] }[] }

/** Excel에서 복사한 TSV·CSV 텍스트 → 표. 1열 연령, 2열부터 위험률(열 개수 제한 없음) */
export function parseRateText(text: string): ParsedTable {
  const rows = text.split(/\r?\n/).map((l) => l.split(/\t|,|;/)).filter((r) => r.some((c) => c.trim() !== ""));
  return parseRows(rows);
}

/** CSV·XLSX 파일 → 표. 첫 시트를 읽는다 */
export async function parseRateFile(file: File): Promise<ParsedTable> {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("시트를 찾을 수 없습니다");
  return parseRows(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false }));
}

function parseRows(rows: unknown[][]): ParsedTable {
  const header = rows.find((r) => num(r[0]) === null && r.some((c) => String(c ?? "").trim() !== ""));
  const width = Math.max(1, ...rows.map((r) => r.length));
  const ages: number[] = [], cols: string[][] = Array.from({ length: width - 1 }, () => []);
  for (const r of rows) {
    const a = num(r[0]);
    if (a === null || a < 0 || a > MAX_AGE) continue;       // 머리글·빈 줄은 건너뛴다
    ages.push(Math.round(a));
    for (let c = 1; c < width; c++) cols[c - 1].push(String(num(r[c]) ?? 0));
  }
  if (ages.length === 0) throw new Error("연령 열을 읽지 못했습니다. 1열에 연령, 2열부터 위험률을 넣어 주세요.");
  const named = cols.map((cells, i) => ({ name: String(header?.[i + 1] ?? "").trim() || `위험률 ${i + 1}`, cells }));
  return { ages, columns: named.length ? named : [{ name: "위험률 1", cells: ages.map(() => "0") }] };
}

/** 시트 → CSV(Excel에서 바로 열리도록 BOM). 수식이 아니라 계산된 값을 내보낸다 */
export function rateCsv(s: RateSheet, r: ResolvedSheet): string {
  const head = ["연령", ...s.columns.map((c) => `${c.name} (${kindLabel(c.kind)}${c.waiver ? "·납입면제" : ""})`)];
  const lines = s.ages.map((a, i) => [a, ...s.columns.map((c) => r.byId[c.id]?.[i] ?? 0)].join(","));
  return "﻿" + [head.join(","), ...lines].join("\r\n");
}

// ── 기존 표 불러오기 ─────────────────────────────────────────────────────────
const at = (arr: number[], i: number) => arr[i] ?? arr[arr.length - 1] ?? 0;
/** 표에 넣는 값은 10자리에서 끊는다 — 0.65를 곱한 뒤 0.0015500999999999999 같은 찌꺼기가 칸에 보이지 않게 */
export const roundRate = (x: number) => Math.round(x * 1e10) / 1e10;

export interface RatePreset { id: string; label: string; kind: RateKind; waiver: boolean; note: string; /** 산출방법서에 싣는 근거. 없으면 note */ source?: string; values: (sex: Sex, ages: number[]) => number[] }

/** 기존 산출에 쓰는 표를 열로 불러온다 — 설계형 상품과 같은 위험률로 일반 상품을 만들 수 있다 */
export const RATE_PRESETS: RatePreset[] = [
  { id: "kli7", label: "제7회 경험생명표 사망률 q", kind: "death", waiver: false, note: "설계형 종신보험과 같은 표", source: "보험개발원 제7회 경험생명표 사망률",
    values: (s, ages) => ages.map((a) => roundRate(at(TABLE[s].q, a))) },
  { id: "kli7Std", label: "제7회 표준사망률 q_std", kind: "death", waiver: false, note: "표준책임준비금 기준", source: "제7회 경험생명표 기준 표준사망률",
    values: (s, ages) => ages.map((a) => roundRate(at(TABLE[s].qStd, a))) },
  { id: "waiver", label: "납입면제 발생률 f (장해 50% 이상)", kind: "other", waiver: true, note: "제7회 경험생명표. 납입면제 열로 들어갑니다", source: "제7회 경험생명표 50% 이상 장해 발생률",
    values: (s, ages) => ages.map((a) => roundRate(at(TABLE[s].f, a))) },
  { id: "cancer", label: "암발생률 (생명장기제2024-112호)", kind: "incidence", waiver: false, note: "제공받은 실제 값", source: "보험개발원 생명장기제2024-112호 무배당 예정 경험 암발생률",
    values: (s, ages) => ages.map((a) => roundRate(at(CANCER[s].q, a))) },
  { id: "cancerHosp", label: "암입원 연간 기대일수 (암입원율 × 365)", kind: "recurring", waiver: false, note: "제공받은 실제 값. 일당형 담보용",
    values: (s, ages) => ages.map((a) => roundRate(at(HOSP[s], a) * 365)) },
  { id: "stroke", label: "뇌출혈 발생률", kind: "incidence", waiver: false, note: "제공받은 실제 값 (0~84세, 그 뒤는 84세 값 유지)", source: "무배당 예정 뇌출혈 발생률 (제공 자료, 0~84세)",
    values: (s, ages) => ages.map((a) => roundRate(at(CI.stroke[s], a))) },
  { id: "ami", label: "급성심근경색증 발생률", kind: "incidence", waiver: false, note: "제공받은 실제 값 (0~79세, 그 뒤는 79세 값 유지)", source: "무배당 예정 급성심근경색증 발생률 (제공 자료, 0~79세)",
    values: (s, ages) => ages.map((a) => roundRate(at(CI.ami[s], a))) },
  { id: "twoMajor", label: "2대질병 발생률 (뇌출혈 + 급성심근경색증)", kind: "incidence", waiver: false, note: "제공받은 두 발생률의 합",
    values: (s, ages) => ages.map((a) => roundRate(at(CI.stroke[s], a) + at(CI.ami[s], a))) },
  { id: "threeMajor", label: "3대질병 발생률 (암 + 뇌출혈 + 급성심근경색증)", kind: "incidence", waiver: false, note: "제공받은 세 발생률의 합",
    values: (s, ages) => ages.map((a) => roundRate(at(CANCER[s].q, a) + at(CI.stroke[s], a) + at(CI.ami[s], a))) },
  // 종신보험은 "사망 또는 80% 이상 장해" 에 같은 보험금을 준다 — 사망률과 함께 탈퇴·급부 열로 쓴다
  { id: "dis80", label: "80% 이상 장해율 (재해 + 질병)", kind: "incidence", waiver: false,
    note: "써미트 2014-59호 80%이상 재해장해 + 질병장해발생율 (MG 더블종신공제Ⅱ)",
    values: (s, ages) => ages.map((a) => roundRate(at(DIS80[s], a))) },
  // 메리츠 「보험료납입지원 특별약관」 산출방법서의 지급사유 구성(고도후유장해 + 3대질병 진단)을 본떴다.
  // 그 방법서의 탈퇴율은 후유장해발생률(80%이상)·암·뇌졸중·급성심근경색증발생률의 합이다.
  { id: "waiverSupport", label: "납입면제 사유 (고도후유장해 + 3대질병)", kind: "other", waiver: true,
    note: "메리츠 보험료납입지원 특약 구성. 80% 이상 장해 + 암 + 뇌출혈 + 급성심근경색증",
    values: (s, ages) => ages.map((a) => roundRate(at(DIS80[s], a) + at(CANCER[s].q, a) + at(CI.stroke[s], a) + at(CI.ami[s], a))) },
  { id: "blank", label: "빈 열 (직접 입력·수식)", kind: "other", waiver: false, note: "0으로 채우고 셀에 값이나 수식을 넣습니다",
    values: (_s, ages) => ages.map(() => 0) },
];

export function presetColumn(p: RatePreset, sex: Sex, ages: number[]): RateColumn {
  return { id: newColId(), name: p.label.replace(/\s*\(.*\)$/, ""), kind: p.kind, waiver: p.waiver, cells: p.values(sex, ages).map(String),
    source: p.id === "blank" ? undefined : p.source ?? p.note };
}

/** 첫 화면 기본 시트: 사망률 + 2대질병 발생률 (납입자수는 두 사유로 줄어든다) */
export function defaultSheet(sex: Sex, from: number, to: number): RateSheet {
  const ages = Array.from({ length: Math.max(1, to - from + 1) }, (_, i) => from + i);
  const pick = (id: string) => presetColumn(RATE_PRESETS.find((p) => p.id === id)!, sex, ages);
  return { ages, columns: [pick("kli7"), pick("twoMajor")] };
}

/** 연령 범위를 바꾼다. 이미 있는 나이의 입력(수식 포함)은 그대로 옮긴다 */
export function setAgeRange(s: RateSheet, from: number, to: number): RateSheet {
  const lo = Math.max(0, Math.min(from, to)), hi = Math.min(MAX_AGE, Math.max(from, to));
  const ages = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const index = new Map(s.ages.map((a, i) => [a, i]));
  return {
    ages,
    columns: s.columns.map((c) => ({ ...c, cells: ages.map((a) => { const i = index.get(a); return i === undefined ? "0" : c.cells[i] ?? "0"; }) })),
  };
}
