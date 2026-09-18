"use client";
import { assumptionOf, BENEFIT_LABEL, lowKind } from "@/lib/state";
import { FormulaHelp } from "@/components/formula-help";
import { useDesign } from "@/components/design-provider";
import { Button } from "@/components/ui";
import { pct, won } from "@/lib/format";
import { autoName, downloadJson } from "@/lib/library";
import { reserveCsv, reserveRows, reserveHeaders } from "@/lib/reserve-table";

/** 준비금·해약환급금 연도별 표. 계약 체결 시 첨부용으로 CSV 다운로드 */
export function ReserveTable() {
  const { state, result: r } = useDesign();
  const rows = reserveRows(state, r);
  const ls = assumptionOf(state).lowSurrender;
  const eff = state.lowSurrender ? ` (${lowKind(ls.ratio)} · 적용해지율 ${pct(ls.lapseRate)})` : "";
  const download = () => downloadJson(`준비금표_${autoName(state).replace(/[^\w가-힣]+/g, "_")}.csv`, reserveCsv(rows), "text/csv");
  return (
    <details className="rounded-lg border border-navy/10 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer font-display text-lg text-navy">준비금·해약환급금 표{eff} <FormulaHelp id="reserve" /> <FormulaHelp id="surrender" /> <FormulaHelp id="rate" /></summary>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-navy/60">
        <span>경과년별 연말 준비금(적용·표준), 납입 누계, 해약환급금·환급률, 연도별 사업비(0년차는 신계약비 포함). 가정 {r.meta.assumptionId} · 기준보험금 {won(state.S0)}</span>
        <Button onClick={download}>CSV 다운로드</Button>
      </div>
      <div className="mt-2 max-h-96 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white text-navy/60"><tr>{reserveHeaders(BENEFIT_LABEL[state.profile.product]).map((h) => <th key={h} className={`py-1 ${h === "경과년" || h === "연령" ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.t} className={`border-t border-navy/10 font-mono ${row.t === state.payYears ? "bg-sky/10" : ""}`}>
                <td className="py-0.5">{row.t}</td><td>{row.age}</td>
                <td className="text-right">{won(row.benefit)}</td><td className="text-right">{row.celebration ? won(row.celebration) : "-"}</td>
                <td className="text-right">{won(row.paid)}</td><td className="text-right">{won(row.reserve)}</td><td className="text-right">{won(row.reserveStd)}</td>
                <td className="text-right">{won(row.cash)}</td><td className="text-right">{pct(row.rate)}</td><td className="text-right">{row.expense ? won(row.expense) : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
