"use client";
import { FormulaHelp } from "@/components/formula-help";
import type { FormulaId } from "@/lib/formulas";
import { useDesign } from "@/components/design-provider";
import { pct, won } from "@/lib/format";
import { effective, lowKind } from "@/lib/state";

const YEARS = [1, 2, 3, 5, 10, 15, 20, 30];

const HELP: Partial<Record<string, FormulaId>> = { "순보험료": "net", "기준연납순보험료": "base", "영업보험료": "gross", "급부 현가 PVB (radix 10만)": "pvb", "월납 보정 납입기수 N*": "nstar", "β′ 포함 연납순보험료 (1단위당)": "reserve" };
const Table = ({ rows }: { rows: [string, string][] }) => (
  <table className="w-full text-xs"><tbody>{rows.map(([a, b]) => <tr key={a} className="border-t border-navy/10"><td className="py-1 text-navy/70">{a}{HELP[a] && <FormulaHelp id={HELP[a]} className="ml-1" />}</td><td className="py-1 text-right font-mono">{b}</td></tr>)}</tbody></table>
);

export function Evidence() {
  const { state, result: r } = useDesign();
  const eff = effective(r, state.payYears);
  const u = r.perUnit, k = r.per100k;
  const low = r.lowSurrender;
  const grossLabel = low
    ? `${k.gross.toLocaleString()}원 (${lowKind(low.ratio)} → ${low.gross100k.toLocaleString()}원, 인하 ${low.deltaP100k}원 = ${pct(low.premiumDiscount)})`
    : `${k.gross.toLocaleString()}원`;
  const netLabel = low ? `${k.net.toLocaleString()}원 (${lowKind(low.ratio)} → ${low.net100k.toLocaleString()}원)` : `${k.net.toLocaleString()}원`;
  const per100k: [string, string][] = [
    ["순보험료", netLabel],
    ["기준연납순보험료", `${k.base.toLocaleString()}원`],
    ["영업보험료", grossLabel],
    ["신계약비 (산출 / 표준 / 해약공제 기준)", `${k.alpha.toLocaleString()} / ${k.alphaStd.toLocaleString()} / ${k.newBiz.toLocaleString()}원`],
  ];
  const mid: [string, string][] = [
    ["급부 현가 PVB (radix 10만)", u.pvb.toFixed(6)],
    ["월납 보정 납입기수 N*", u.nStar.toFixed(6)],
    ["β′ 포함 연납순보험료 (1단위당)", u.pBeta.toFixed(8)],
    ["보장기간 n / 최종연령 ω", `${r.n}년 / ${r.omega}세`],
  ];
  if (low) mid.push(
    ["적용해지율 w (납입기간 중)", pct(low.lapseRate)],
    ["해지급부 현가 CSV₀ (radix 10만)", low.pvCsv.toFixed(6)],
  );
  const L = r.loading;
  const loading: [string, string][] = [
    ["신계약비 α", won(L.alpha)], ["유지비 정액 β_S", won(L.betaS)], ["납입 후 유지비 β′", won(L.betaPrime)], ["유지비율 β_G", won(L.betaG)], ["수금비 γ", won(L.gamma)],
  ];
  return (
    <details className="rounded-lg border border-navy/10 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer font-display text-lg text-navy">산출 근거</summary>
      <h3 className="mt-3 text-sm font-medium">10만원당 (월납 1회)</h3><Table rows={per100k} />
      <h3 className="mt-3 text-sm font-medium">중간값</h3><Table rows={mid} />
      <h3 className="mt-3 text-sm font-medium">부가보험료 분해 (가입금액 {won(state.S0)} 기준, 1회 납입) <FormulaHelp id="loading" /></h3><Table rows={loading} />
      <h3 className="mt-3 text-sm font-medium">해약환급금{eff.isLow ? ` (${lowKind(eff.ratio)}: 납입기간 중 표준형의 ${Math.round(eff.ratio * 100)}%)` : ""}</h3>
      <table className="w-full text-xs">
        <thead><tr className="text-navy/60"><th className="py-1 text-left">경과</th><th className="text-right">납입 누계</th><th className="text-right">환급금</th><th className="text-right">환급률</th></tr></thead>
        <tbody>{YEARS.filter((t) => t <= r.n).map((t) => <tr key={t} className="border-t border-navy/10 font-mono"><td className="py-1">{t}년</td><td className="text-right">{won(eff.paid[t])}</td><td className="text-right">{won(eff.cash[t])}</td><td className="text-right">{pct(eff.rate[t])}</td></tr>)}</tbody>
      </table>
    </details>
  );
}
