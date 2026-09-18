"use client";
import { FormulaHelp } from "@/components/formula-help";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDesign } from "@/components/design-provider";
import { compareAtBudget, type CompareRow } from "@/lib/engine";
import { pct, won, wonShort } from "@/lib/format";
import { assumptionOf, tableOf } from "@/lib/state";

const COLORS: Record<CompareRow["id"], string> = { level: "#94a3b8", combo: "#4a90c2", designed: "#1b2845" };

/** 현재 설계의 표준형 월 보험료를 예산으로 세 안을 역산한다(비교는 저해지 미적용 기준) */
export function useCompareRows(): { budget: number; rows: CompareRow[] } {
  const { state, result } = useDesign();
  const budget = result.monthly.gross;
  const rows = compareAtBudget(budget, { sex: state.profile.sex, age: state.profile.age, payYears: state.payYears, blocks: state.blocks, waiver: state.waiver, lowSurrender: false }, assumptionOf(state), tableOf(state.profile), state.profile.product);
  return { budget, rows };
}

export function CompareTable({ chartWidth }: { chartWidth?: number }) {
  const { state } = useDesign();
  const { budget, rows } = useCompareRows();
  const age = state.profile.age;
  const n = Math.max(...rows.map((r) => r.S.length));
  // 암보험은 '정기 + 종신 조합' 행이 없으므로 순번이 아니라 id로 찾는다
  const byId = (id: CompareRow["id"]) => rows.find((x) => x.id === id);
  const data = Array.from({ length: n }, (_, t) => ({ age: age + t, level: byId("level")?.S[t] ?? null, combo: byId("combo")?.S[t] ?? null, designed: byId("designed")?.S[t] ?? null }));
  const cols: [string, (r: CompareRow) => string][] = [
    ["초기 보험금", (r) => won(r.S[0])], ["월 보험료", (r) => won(r.monthly)], ["총 납입", (r) => won(r.totalPaid)],
    [`납입 완료(${state.payYears}년) 환급률`, (r) => pct(r.cashRateAtPayEnd)], ["보험금 현가", (r) => won(r.pvBenefit)],
  ];
  const chart = (
    <LineChart data={data} width={chartWidth} height={260} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
      <CartesianGrid stroke="#1b284518" />
      <XAxis dataKey="age" type="number" domain={["dataMin", "dataMax"]} unit="세" fontSize={11} tickCount={8} />
      <YAxis width={64} fontSize={11} tickFormatter={(v: unknown) => wonShort(Number(v))} />
      <Tooltip labelFormatter={(a) => `${a}세`} formatter={(v) => (v == null ? null : won(Number(v)))} />
      <Legend />
      {rows.map((r) => <Line key={r.id} type="stepAfter" dataKey={r.id} name={r.label} stroke={COLORS[r.id]} strokeWidth={r.id === "designed" ? 2.5 : 1.5} dot={false} isAnimationActive={false} />)}
    </LineChart>
  );
  return (
    <div className="space-y-4">
      <p className="text-sm text-navy/70">같은 월 예산 <span className="font-mono">{won(budget)}</span>(표준형 기준)으로 세 안의 초기 보험금을 역산했습니다. 조합안의 정기보험 사업비는 종신과 같은 가정 세트를 씁니다. <FormulaHelp id="compare" /></p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-navy/60"><th className="py-1">안</th>{cols.map(([h]) => <th key={h} className="py-1 text-right">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="border-t border-navy/10">
              <td className="py-1.5"><span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: COLORS[r.id] }} />{r.label}</td>
              {cols.map(([h, f]) => <td key={h} className="py-1.5 text-right font-mono">{f(r)}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
      {chartWidth ? chart : <div className="h-64"><ResponsiveContainer width="100%" height="100%">{chart}</ResponsiveContainer></div>}
    </div>
  );
}
