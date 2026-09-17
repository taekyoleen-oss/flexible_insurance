"use client";
import { FormulaHelp } from "@/components/formula-help";
import { useDesign } from "@/components/design-provider";
import { Card, Field, MillionInput, Select, ThousandInput } from "@/components/ui";
import { clamp, won } from "@/lib/format";
import { effective, s0FromMonthly } from "@/lib/state";

const PAY_YEARS = [5, 10, 15, 20, 30];
const MONTHLY_MIN = 10, MONTHLY_MAX = 10000; // 천원 (1만원 ~ 1천만원)

export function BudgetFields() {
  const { state, dispatch, result } = useDesign();
  // 저해지 시 실제 납입액은 할인된 보험료다. 표시·역산 모두 이 값 기준으로 맞춘다.
  const eff = effective(result, state.payYears);
  const setMonthly = (m: number) => dispatch({ type: "S0", S0: s0FromMonthly(m, eff.gross100k) });
  return (
    <div className="space-y-3">
      <Field label={<>월 보험료 <FormulaHelp id="s0FromMonthly" /></>} hint={<>초기 보험금 {won(result.S[0] * state.S0)} · 총 납입 {won(eff.totalPaid)}{eff.isLow && " (저해지)"} · 기준보험금이 10백만원 단위라 월 보험료가 그에 맞춰 조정됩니다</>}>
        <ThousandInput value={eff.monthly} onChange={setMonthly} min={MONTHLY_MIN} max={MONTHLY_MAX} ariaLabel="월 보험료" />
      </Field>
      <input type="range" className="w-full accent-sky" min={MONTHLY_MIN} max={MONTHLY_MAX} step={10} aria-label="월 보험료 슬라이더"
        value={clamp(Math.round(eff.monthly / 1e3), MONTHLY_MIN, MONTHLY_MAX)} onChange={(e) => setMonthly(Number(e.target.value) * 1e3)} />
      <Field label={<>기준보험금 <FormulaHelp id="step" /></>} hint={<>배수 1.0의 보험금. 10백만원 단위 · 그래프 1칸(10%) = {won(state.S0 / 10)}</>}>
        <MillionInput value={state.S0} onChange={(v) => dispatch({ type: "S0", S0: v })} min={10} max={1e4} ariaLabel="기준보험금" />
      </Field>
    </div>
  );
}

export function ContractFields() {
  const { state, dispatch } = useDesign();
  return (
    <div className="space-y-3">
      <Field label="납입기간">
        <Select value={state.payYears} onChange={(e) => dispatch({ type: "payYears", payYears: Number(e.target.value) })}>
          {PAY_YEARS.map((y) => <option key={y} value={y}>{y}년납</option>)}
        </Select>
      </Field>
      {state.profile.product === "cancer"
        ? <p className="text-xs text-navy/60">암보험: 100세 만기 · 암진단 시 보험금 지급, 사망 시 책임준비금 지급 · 90일 면책(첫해 급부 3/4)</p>
        : <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-sky" checked={state.waiver} onChange={(e) => dispatch({ type: "waiver", on: e.target.checked })} />납입면제 (사망·장해 50% 이중탈퇴)</label>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-sky" checked={state.lowSurrender} onChange={(e) => dispatch({ type: "lowSurrender", on: e.target.checked })} />저해지 (납입기간 중 해약환급금 30% · 보험료 20% 인하)</label>
    </div>
  );
}

export function BudgetPanel() {
  return (
    <Card title="예산·계약">
      <BudgetFields />
      <div className="my-4 border-t border-navy/10" />
      <ContractFields />
    </Card>
  );
}
