"use client";
import { Fragment } from "react";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usePlan } from "./plan-provider";
import { Button, Card } from "@/components/ui";
import { pct, won, wonExact, wonShort } from "@/lib/format";
import { kindMeta } from "@/lib/plan-state";

const SERIES = ["#1b2845", "#4a90c2", "#a34a1e", "#7a9e7e", "#8a6fae", "#c2a24a", "#5b7c99", "#a4708b", "#6b8f71", "#9c6b4a", "#4a6fa5", "#b08968"];

/** 보험료 요약: 담보별 + 합계 */
export function PremiumCard() {
  const { state: s, result: r } = usePlan();
  const eff = r.effective, low = r.low;
  // 만기환급금·축하금은 해약환급금이 아니라 급부로 나가므로 환급률에 안 잡힌다. 납입 완료 시점까지 받은 생존급부를 따로 보여 준다
  const paidOut = r.survival.slice(0, r.payYears + 1).reduce((a, b) => a + b, 0);
  return (
    <Card title="보험료">
      <div className="mb-3">
        <div className="text-xs text-navy/60">{s.freq === 12 ? "월" : s.freq === 1 ? "연" : `${12 / s.freq}개월`} 영업보험료</div>
        <div className="font-mono text-3xl text-navy">{won(eff.monthlyGross)}</div>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-navy/60">
          <tr><th className="pb-1 text-left font-medium">담보</th><th className="pb-1 text-right font-medium">보장금액</th><th className="pb-1 text-right font-medium">순보험료</th><th className="pb-1 text-right font-medium">영업보험료</th></tr>
        </thead>
        <tbody>
          {r.coverages.map((c, i) => (
            <tr key={c.id} className="border-t border-navy/10">
              <td className="py-1"><span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: SERIES[i % SERIES.length] }} /> {c.label}<span className="ml-1 text-xs text-navy/50">{kindMeta(c.kind).label} · {c.n}년</span></td>
              <td className="py-1 text-right font-mono">{won(c.benefit[0] || c.survival.find((x) => x > 0) || 0)}{c.kind === "daily" ? "/일" : ""}</td>
              <td className="py-1 text-right font-mono">{won(low ? c.low!.monthlyNet : c.monthlyNet)}</td>
              <td className="py-1 text-right font-mono">{won(low ? c.low!.monthlyGross : c.monthlyGross)}</td>
            </tr>
          ))}
          <tr className="border-t border-navy/20 font-medium">
            <td className="py-1">합계</td><td />
            <td className="py-1 text-right font-mono">{won(eff.monthlyNet)}</td>
            <td className="py-1 text-right font-mono">{won(eff.monthlyGross)}</td>
          </tr>
        </tbody>
      </table>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t border-navy/10 pt-2 text-sm">
        <dt className="text-navy/60">총 납입보험료 ({r.payYears}년)</dt><dd className="font-mono">{won(eff.totalPaid)}</dd>
        <dt className="text-navy/60">납입 완료 환급률</dt>
        <dd className="font-mono">{pct(eff.rate[r.payYears] ?? 0)}{paidOut > 0 && <span className="text-navy/60"> + 생존급부 {won(paidOut)}</span>}</dd>
        {low && <><dt className="text-navy/60">표준형(완전 환급) 보험료</dt><dd className="font-mono">{won(r.standard.monthlyGross)}</dd></>}
        {low && <><dt className="text-navy/60">{low.ratio === 0 ? "무해지" : `저해지 ${Math.round(low.ratio * 100)}%`} 조건 (해지율 {pct(low.lapseRate)})</dt><dd className="font-mono">−{pct(low.premiumDiscount)}</dd></>}
      </dl>
    </Card>
  );
}

/** 연도별 보장금액 — 담보별로 쌓아 보여 준다(증액·감액이 바로 보이도록) */
export function BenefitChart() {
  const { state: s, result: r } = usePlan();
  const data = Array.from({ length: r.n }, (_, t) => {
    const row: Record<string, number> = { t, age: s.age + t };
    for (const c of r.coverages) row[c.id] = c.benefit[t] ?? 0;
    return row;
  });
  return (
    <Card title="연도별 보장금액">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="#1b284518" />
            <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} unit="세" fontSize={11} tickCount={8} />
            <YAxis width={64} fontSize={11} tickFormatter={(v: unknown) => wonShort(Number(v))} />
            <Tooltip labelFormatter={(a) => `${a}세`} formatter={(v: unknown) => won(Number(v))} />
            <Legend />
            {r.coverages.map((c, i) => (
              <Area key={c.id} dataKey={c.id} name={c.label} stackId="1" type="stepAfter"
                stroke={SERIES[i % SERIES.length]} fill={SERIES[i % SERIES.length]} fillOpacity={0.25} isAnimationActive={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {r.survival.some((x) => x > 0) && (
        <p className="mt-2 text-xs text-navy/60">
          생존급부: {r.survival.map((v, t) => (v > 0 ? `${s.age + t}세 ${won(v)}` : null)).filter(Boolean).join(" · ")} (그래프에는 넣지 않습니다)
        </p>
      )}
    </Card>
  );
}

/** 책임준비금·보험료 누계·해약환급금 */
export function ReserveChart() {
  const { result: r } = usePlan();
  const eff = r.effective;
  const data = eff.reserve.map((v, t) => ({ t, reserve: v, paid: eff.paid[t], cash: eff.cash[t] }));
  return (
    <Card title="책임준비금 · 보험료 누계 · 해약환급금">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke="#1b284518" />
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} unit="년" fontSize={11} tickCount={8} />
            <YAxis width={64} fontSize={11} tickFormatter={(v: unknown) => wonShort(Number(v))} />
            <Tooltip labelFormatter={(t) => `${t}년 경과`} formatter={(v: unknown) => won(Number(v))} />
            <Legend />
            <Line dataKey="paid" name="보험료 누계" stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="reserve" name="책임준비금" stroke="#1b2845" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line dataKey="cash" name="해약환급금" stroke="#4a90c2" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

const HEADERS = ["경과년", "연령", "보장금액", "생존급부", "납입누계", "책임준비금", "표준준비금", "해약공제", "해약환급금", "환급률(%)"] as const;

/** 연도별 표 + CSV */
export function PlanReserveTable() {
  const { state: s, result: r } = usePlan();
  const eff = r.effective;
  const rows = Array.from({ length: r.n + 1 }, (_, t) => [
    t, s.age + t, r.benefit[t] ?? 0, r.survival[t] ?? 0, eff.paid[t], eff.reserve[t], eff.reserveStd[t], eff.deduction[t], eff.cash[t], eff.rate[t] * 100,
  ]);
  const csv = () => {
    const text = "﻿" + [HEADERS.join(","), ...rows.map((r0) => r0.map((v, i) => (i === 9 ? v.toFixed(1) : Math.round(v))).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = "일반상품_준비금표.csv"; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <details className="rounded-lg border border-navy/10 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer font-display text-lg text-navy">준비금·해약환급금 표</summary>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-navy/60">
        <span>담보를 모두 합친 값입니다. 표준준비금은 표준이율로 계산한 금액이고, 표준위험률이 따로 없으면 적용위험률을 씁니다.</span>
        <Button onClick={csv}>CSV 내려받기</Button>
      </div>
      <div className="mt-2 max-h-96 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white text-navy/60"><tr>{HEADERS.map((h) => <th key={h} className={`py-1 ${h === "경과년" || h === "연령" ? "text-left" : "text-right"}`}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row[0]} className="border-t border-navy/5 font-mono">
                {row.map((v, i) => <td key={i} className={i < 2 ? "py-0.5" : "py-0.5 text-right"}>{i < 2 ? v : i === 9 ? v.toFixed(1) : wonExact(v)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** 산출 근거: 담보별 계산기수 중간값 */
export function PlanEvidence() {
  const { state: s, result: r } = usePlan();
  return (
    <details className="rounded-lg border border-navy/10 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer font-display text-lg text-navy">산출 근거</summary>
      <p className="mt-2 text-xs text-navy/60">
        담보마다 계산기수를 따로 만들어 산출방법서 순서대로 계산합니다: 급부 현가 PVB → 납입기수 N* → 순보험료 P = PVB/N* → 영업보험료 G → 책임준비금 V → 해약환급금 W.
        예정이율 {pct(s.interest, 2)} · 표준이율 {pct(s.standardInterest, 2)} · 납입면제 {s.waiver ? "적용" : "미적용"}.
      </p>
      <div className="mt-3 overflow-auto">
        <table className="w-full text-xs">
          <thead className="text-navy/60">
            <tr>
              {["담보", "보장기간", "급부현가 PVB", "납입기수 N*", "순 P(10만원당)", "영업 G(10만원당)", "신계약비 α", "해약공제 기준", r.low ? "해지급부현가 CSV₀" : ""].filter(Boolean).map((h) => <th key={h} className="py-1 text-right font-medium first:text-left">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {r.coverages.map((c) => (
              <Fragment key={c.id}>
                <tr className="border-t border-navy/10 font-mono">
                  <td className="py-1 font-sans">{c.label}</td>
                  <td className="py-1 text-right">{c.n}년 / 납입 {c.payYears}년</td>
                  <td className="py-1 text-right">{c.perUnit.pvb.toFixed(4)}</td>
                  <td className="py-1 text-right">{c.perUnit.nStar.toFixed(2)}</td>
                  <td className="py-1 text-right">{(r.low ? c.low!.net100k : c.per100k.net).toLocaleString()}원</td>
                  <td className="py-1 text-right">{(r.low ? c.low!.gross100k : c.per100k.gross).toLocaleString()}원</td>
                  <td className="py-1 text-right">{c.per100k.alpha.toLocaleString()}원</td>
                  <td className="py-1 text-right">{c.per100k.newBiz.toLocaleString()}원</td>
                  {r.low && <td className="py-1 text-right">{c.low!.pvCsv.toFixed(4)}</td>}
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-navy/50">
        PVB·N*는 radix 100,000 기준 1단위(보장금액 배수 1.0)당 값입니다. 10만원당 보험료 × (보장금액 ÷ 100,000)이 담보 보험료입니다.
      </p>
    </details>
  );
}
