"use client";
import { FormulaHelp } from "@/components/formula-help";
import type { FormulaId } from "@/lib/formulas";
import { Fragment } from "react";
import { useDesign } from "@/components/design-provider";
import { Card } from "@/components/ui";
import { pct, won } from "@/lib/format";
import { effective, lowKind } from "@/lib/state";
import { riderPremiums, riderTotal } from "@/lib/riders";

export function PremiumSummary() {
  const { state, result: r } = useDesign();
  const m = state.payYears;
  const eff = effective(r, m);
  const riders = riderPremiums(state).filter((x) => x.on);
  const extra = riderTotal(riders);
  const HELP: Partial<Record<string, FormulaId>> = { "월 순보험료": "net", [`납입 완료(${m}년) 환급률`]: "rate", [`${lowKind(eff.ratio)} 조건`]: "lowSurrender" };
  const rows: [string, string][] = [
    ["월 순보험료", won(eff.net)],   // HELP 맵으로 "?" 연결
    ["총 납입보험료", won(eff.totalPaid)],
    [`납입 완료(${m}년) 환급률`, pct(eff.rate[m])],
    ["초기 보험금", won(r.S[0] * state.S0)],
    ["최대 보험금", won(Math.max(...r.S) * state.S0)],
  ];
  if (eff.isLow) {
    rows.push(["표준형 월 영업보험료 (환급형)", won(eff.standardMonthly)]);
    rows.push([`${lowKind(eff.ratio)} 조건`, `납입기간(${m}년) 중 해약환급금 ${Math.round(eff.ratio * 100)}% · 적용해지율 ${pct(eff.lapseRate)} → 보험료 −${pct(eff.premiumDiscount)}, 납입 후 표준과 동일`]);
  }
  return (
    <Card title="보험료">
      <div className="mb-3">
        <div className="text-xs text-navy/60">월 영업보험료 <FormulaHelp id="gross" /></div>
        <div className="font-mono text-3xl text-navy">{won(eff.monthly)}</div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-sm">
        {rows.map(([k, v]) => <Fragment key={k}><dt className="text-navy/60">{k}{HELP[k] && <FormulaHelp id={HELP[k]} className="ml-1" />}</dt><dd className="font-mono">{v}</dd></Fragment>)}
      </dl>
      {riders.length > 0 && (
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t border-navy/10 pt-2 text-sm">
          <dt className="text-navy/60">주계약 월 보험료</dt><dd className="font-mono">{won(eff.monthly)}</dd>
          {riders.map((x) => <Fragment key={x.id}><dt className="text-navy/60">{x.label} · {won(x.amount)}{x.kind === "daily" ? "/일" : ""}</dt><dd className="font-mono">{won(x.monthly)}</dd></Fragment>)}
          <dt className="font-medium text-navy">최종 합계 (주계약 + 특약 {riders.length}건)</dt><dd className="font-mono font-medium text-navy">{won(eff.monthly + extra)}</dd>
        </dl>
      )}
      <p className="mt-3 text-xs text-navy/50">가정 {r.meta.assumptionId} ({r.meta.assumptionVersion}) · 납입면제 {r.meta.waiver ? "ON" : "OFF"} · {eff.isLow ? `${lowKind(eff.ratio)} (적용해지율 ${pct(eff.lapseRate)})` : "표준형(완전 환급)"}</p>
    </Card>
  );
}
