import type { EngineResult } from "@/lib/engine";
import { effective, type DesignState } from "./state";

/** 계약 체결 시 쓰는 연도별 표 한 줄. 금액은 원, 비율은 소수 */
export interface ReserveRow {
  t: number;            // 경과년
  age: number;          // 연령(경과년 시점)
  benefit: number;      // 사망보험금(해당 연도)
  celebration: number;  // 축하금(해당 시점)
  paid: number;         // 납입 누계
  reserve: number;      // 적용 준비금(연말)
  reserveStd: number;   // 표준 준비금(연말)
  cash: number;         // 해약환급금(저해지면 인하 반영)
  rate: number;         // 환급률
  expense: number;      // 해당 연도 사업비(원). 0년차에 신계약비 포함
}

export function reserveRows(s: DesignState, r: EngineResult): ReserveRow[] {
  const eff = effective(r, s.payYears);
  const x = s.profile.age;
  return Array.from({ length: r.n + 1 }, (_, t) => ({
    t, age: x + t,
    benefit: (r.S[Math.min(t, r.n - 1)] ?? 0) * s.S0,
    celebration: (r.C[t] ?? 0) * s.S0,
    paid: eff.paid[t],
    reserve: eff.reserve100k[t] * r.units,
    reserveStd: eff.reserveStd100k[t] * r.units,
    cash: eff.cash[t],
    rate: eff.rate[t],
    expense: r.expenseFlow[t] ?? 0,
  }));
}

export const RESERVE_HEADERS = ["경과년", "연령", "사망보험금", "축하금", "납입누계", "적용준비금", "표준준비금", "해약환급금", "환급률(%)", "사업비(연)"] as const;
/** 상품별 보험금 이름을 넣은 머리글(암보험: 암진단보험금) */
export const reserveHeaders = (benefit: string) => RESERVE_HEADERS.map((h) => (h === "사망보험금" ? benefit : h));

/** Excel에서 바로 열리도록 BOM 포함 CSV. 금액은 원 단위 정수, 환급률은 소수 1자리 % */
export function reserveCsv(rows: ReserveRow[]): string {
  const lines = [RESERVE_HEADERS.join(",")];
  for (const r of rows) lines.push([r.t, r.age, Math.round(r.benefit), Math.round(r.celebration), Math.round(r.paid), Math.round(r.reserve), Math.round(r.reserveStd), Math.round(r.cash), (r.rate * 100).toFixed(1), Math.round(r.expense)].join(","));
  return "﻿" + lines.join("\r\n");
}
