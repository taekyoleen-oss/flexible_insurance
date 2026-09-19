import * as XLSX from "xlsx";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import cancerRates from "@/lib/engine/data/rates-cancer.json";
import cancerHosp from "@/lib/engine/data/rates-cancer-hosp.json";
import type { RateTable, Sex } from "@/lib/engine";

/** 위험률 시트: 연령 행 × (급부 발생률, 탈퇴율) 두 열. 담보마다 하나씩 가진다 */
export interface RateGrid { ages: number[]; event: number[]; exit: number[] }

export const MAX_AGE = 120;
const TABLE = kli7 as RateTable;
const CANCER = cancerRates as RateTable;
const HOSP = cancerHosp as { M: number[]; F: number[] };

const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[,\s%]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return v.includes("%") ? n / 100 : n;
};

/**
 * 연령 행 → 연령 인덱스 배열. 표에 없는 나이는 바로 앞 나이 값을 그대로 쓴다(마지막 나이 뒤도 마지막 값).
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

/** 표가 가입나이~만기를 덮는지. 덮지 못하면 화면에 경고를 띄운다 */
export function rateCoverage(g: RateGrid, age: number, endAge: number): { ok: boolean; min: number; max: number } {
  if (g.ages.length === 0) return { ok: false, min: 0, max: 0 };
  const min = Math.min(...g.ages), max = Math.max(...g.ages);
  return { ok: min <= age && max >= endAge, min, max };
}

/** Excel에서 복사한 TSV, CSV 텍스트 → 시트. 열이 2개면 [연령, 발생률], 3개 이상이면 [연령, 발생률, 탈퇴율] */
export function parseRateText(text: string): RateGrid {
  const rows = text.split(/\r?\n/).map((l) => l.split(/\t|,|;/)).filter((r) => r.some((c) => c.trim() !== ""));
  return parseRows(rows);
}

/** CSV·XLSX 파일 → 시트. 첫 시트의 첫 3열만 본다 */
export async function parseRateFile(file: File): Promise<RateGrid> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error("시트를 찾을 수 없습니다");
  return parseRows(XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false }));
}

function parseRows(rows: unknown[][]): RateGrid {
  const ages: number[] = [], event: number[] = [], exit: number[] = [];
  for (const r of rows) {
    const a = num(r[0]), e = num(r[1]);
    if (a === null || e === null) continue;            // 머리글·빈 줄은 건너뛴다
    if (a < 0 || a > MAX_AGE) continue;
    ages.push(Math.round(a)); event.push(e); exit.push(num(r[2]) ?? 0);
  }
  if (ages.length === 0) throw new Error("연령과 위험률 두 열을 읽지 못했습니다. 1열 연령, 2열 급부 발생률, 3열(선택) 탈퇴율 순서로 넣어 주세요.");
  return { ages, event, exit };
}

/** 시트 → CSV(Excel에서 바로 열리도록 BOM) */
export const rateCsv = (g: RateGrid) =>
  "﻿" + ["연령,급부 발생률,탈퇴율", ...g.ages.map((a, i) => `${a},${g.event[i] ?? 0},${g.exit[i] ?? 0}`)].join("\r\n");

export interface RatePreset { id: string; label: string; note: string; build: (sex: Sex, from: number, to: number) => RateGrid }

const at = (arr: number[], i: number) => arr[i] ?? arr[arr.length - 1] ?? 0;
/** 표에 넣는 값은 10자리에서 끊는다 — 0.65를 곱한 뒤 0.0015500999999999999 같은 부동소수 찌꺼기가 칸에 보이지 않게 */
export const roundRate = (x: number) => Math.round(x * 1e10) / 1e10;
const grid = (from: number, to: number, ev: (a: number) => number, ex: (a: number) => number): RateGrid => {
  const ages: number[] = [], event: number[] = [], exit: number[] = [];
  for (let a = from; a <= to; a++) { ages.push(a); event.push(roundRate(ev(a))); exit.push(roundRate(ex(a))); }
  return { ages, event, exit };
};

/** 기존 산출에 쓰는 표를 그대로 불러온다 — 설계형 상품과 같은 위험률로 일반 상품을 만들 수 있다 */
export const RATE_PRESETS: RatePreset[] = [
  { id: "kli7", label: "제7회 경험생명표 사망률", note: "사망형 담보용. 발생률 = 탈퇴율 = q",
    build: (s, f, t) => grid(f, t, (a) => at(TABLE[s].q, a), (a) => at(TABLE[s].q, a)) },
  { id: "kli7Std", label: "제7회 표준사망률", note: "표준책임준비금 기준 사망률 q_std",
    build: (s, f, t) => grid(f, t, (a) => at(TABLE[s].qStd, a), (a) => at(TABLE[s].qStd, a)) },
  { id: "cancer", label: "암발생률 (생명장기제2024-112호)", note: "진단형. 탈퇴율 = 사망률 + 발생률",
    build: (s, f, t) => grid(f, t, (a) => at(CANCER[s].q, a), (a) => at(CANCER[s].q, a) + at(TABLE[s].q, a)) },
  { id: "cancerHosp", label: "암입원 연간 기대일수 (암입원율 × 365)", note: "일당형. 탈퇴율 = 사망률",
    build: (s, f, t) => grid(f, t, (a) => at(HOSP[s], a) * 365, (a) => at(TABLE[s].q, a)) },
  { id: "twoMajor", label: "2대질병 발생률 (사망률 × 0.65, 임시)", note: "뇌출혈 0.35 + 급성심근경색 0.30. 회사 요율로 교체하세요",
    build: (s, f, t) => grid(f, t, (a) => at(TABLE[s].q, a) * 0.65, (a) => at(TABLE[s].q, a) * 1.65) },
  { id: "zero", label: "빈 표 (직접 입력)", note: "연령만 채우고 위험률은 0",
    build: (_s, f, t) => grid(f, t, () => 0, () => 0) },
];

/** 납입면제 발생률(장해 50% 이상). 계약 단위라 담보 시트와 따로 둔다 */
export const waiverRates = (sex: Sex) => TABLE[sex].f;
export const WAIVER_NOTE = "제7회 경험생명표 납입면제(장해 50% 이상) 발생률 f";
