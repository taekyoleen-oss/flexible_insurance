"use client";
import { FormulaHelp } from "@/components/formula-help";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDesign } from "@/components/design-provider";
import { Card } from "@/components/ui";
import { won, wonShort } from "@/lib/format";
import { effective, lowKind } from "@/lib/state";

/** 책임준비금·보험료 누계 곡선(해약환급금은 표에서 본다). width를 주면 카드 없이 고정 폭으로 그린다(인쇄용) */
export function ResultChart({ width }: { width?: number }) {
  const { state, result: r } = useDesign();
  const eff = effective(r, state.payYears);
  const data = eff.reserve100k.map((v, t) => ({ t, paid: eff.paid[t], reserve: v * r.units }));
  const chart = (
    <LineChart data={data} width={width} height={width ? 240 : undefined} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
      <CartesianGrid stroke="#1b284518" />
      <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} unit="년" fontSize={11} tickCount={8} />
      <YAxis width={64} fontSize={11} tickFormatter={(v: unknown) => wonShort(Number(v))} />
      <Tooltip labelFormatter={(t) => `${t}년 경과`} formatter={(v: unknown) => won(Number(v))} />
      <Legend />
      <Line dataKey="paid" name={`보험료 누계${eff.isLow ? ` (${lowKind(eff.ratio)} 보험료)` : ""}`} stroke="#94a3b8" strokeDasharray="4 3" strokeWidth={2} dot={false} isAnimationActive={false} />
      <Line dataKey="reserve" name="책임준비금" stroke="#1b2845" strokeWidth={2} dot={false} isAnimationActive={false} />
    </LineChart>
  );
  if (width) return chart;
  return (
    <Card title={<>책임준비금 <FormulaHelp id="reserve" /> · 보험료 누계</>}>
      <div className="h-64"><ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer></div>
    </Card>
  );
}
