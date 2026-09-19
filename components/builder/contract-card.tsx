"use client";
import { usePlan } from "./plan-provider";
import { Card, Field, NumInput, Select } from "@/components/ui";
import { pct } from "@/lib/format";
import { FREQS, PAY_YEARS, type ContractPatch } from "@/lib/plan-state";
import { WAIVER_NOTE } from "@/lib/plan-rates";

const Pct = ({ label, value, onCommit, hint }: { label: string; value: number; onCommit: (v: number) => void; hint?: string }) => (
  <Field label={label} hint={hint}>
    <div className="flex items-center gap-1">
      <NumInput value={Math.round(value * 1e4) / 100} step={0.05} min={0} onCommit={(v) => onCommit(v / 100)} className="text-right" />
      <span className="shrink-0 text-sm text-navy/60">%</span>
    </div>
  </Field>
);

/** 계약 조건: 피보험자·기간·이율·납입면제·저해지 */
export function ContractCard() {
  const { state: s, dispatch, result } = usePlan();
  const set = (patch: ContractPatch) => dispatch({ type: "contract", patch });
  return (
    <Card title="계약 조건">
      <div className="grid grid-cols-2 gap-3">
        <Field label="성별">
          <Select value={s.sex} onChange={(e) => set({ sex: e.target.value as "M" | "F" })}>
            <option value="M">남</option><option value="F">여</option>
          </Select>
        </Field>
        <Field label="가입나이"><NumInput value={s.age} min={0} max={90} onCommit={(v) => set({ age: Math.round(v) })} /></Field>
        <Field label="보험기간" hint={s.termYears === 0 ? `자동 ${result.n}년 (담보 중 최장)` : undefined}>
          <NumInput value={s.termYears} min={0} max={110} onCommit={(v) => set({ termYears: Math.round(v) })} />
        </Field>
        <Field label="납입기간">
          <Select value={s.payYears} onChange={(e) => set({ payYears: Number(e.target.value) })}>
            {PAY_YEARS.map((y) => <option key={y} value={y}>{y}년납</option>)}
            {!PAY_YEARS.includes(s.payYears as (typeof PAY_YEARS)[number]) && <option value={s.payYears}>{s.payYears}년납</option>}
          </Select>
        </Field>
        <Field label="납입주기">
          <Select value={s.freq} onChange={(e) => set({ freq: Number(e.target.value) })}>
            {FREQS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
          </Select>
        </Field>
        <div />
        <Pct label="예정이율 i" value={s.interest} onCommit={(v) => set({ interest: v })} />
        <Pct label="표준이율" value={s.standardInterest} onCommit={(v) => set({ standardInterest: v })} hint="표준책임준비금" />
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-sky" checked={s.waiver} onChange={(e) => set({ waiver: e.target.checked })} />
        납입면제 (장해 50% 이상)
      </label>
      {s.waiver && <p className="mt-1 text-xs text-navy/50">{WAIVER_NOTE}를 계산기수의 f 열에 넣습니다.</p>}
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-sky" checked={s.low.on} onChange={(e) => dispatch({ type: "low", patch: { on: e.target.checked } })} />
        저해지·무해지환급형
      </label>
      {s.low.on && (
        <div className="mt-2 grid grid-cols-2 gap-3">
          <Pct label="환급률 w^r (0 = 무해지)" value={s.low.ratio} onCommit={(v) => dispatch({ type: "low", patch: { ratio: v } })} />
          <Pct label="적용해지율 w" value={s.low.lapseRate} onCommit={(v) => dispatch({ type: "low", patch: { lapseRate: v } })} hint="납입기간 중에만" />
          <p className="col-span-2 text-xs text-navy/50">
            납입기간 중 해약환급금 = 표준형 × {Math.round(s.low.ratio * 100)}%, 해지율 {pct(s.low.lapseRate)}.
            해지급부 현가 CSV를 급부 현가에 더해 다시 산출합니다.
          </p>
        </div>
      )}
    </Card>
  );
}

/** 사업비: 산출방법서형 α_S·α_P·β_S·β_G·β′·γ 또는 3이원 단순형 */
export function ExpenseCard() {
  const { state: s, dispatch } = usePlan();
  const e = s.expenses;
  const set = (patch: Record<string, number>) => dispatch({ type: "expenses", patch });
  return (
    <Card title="사업비">
      <Field label="모형">
        <Select value={e.model} onChange={(ev) => dispatch({ type: "expenseModel", model: ev.target.value as typeof e.model })}>
          <option value="method">산출방법서형 (α_S·α_P·β_S·β_G·β′·γ)</option>
          <option value="simple">3이원 단순형 (α·β·γ)</option>
        </Select>
      </Field>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {e.model === "method" ? (
          <>
            <Pct label="신계약비 정액 α_S" value={e.alphaS} onCommit={(v) => set({ alphaS: v })} hint="보장금액 대비" />
            <Field label="신계약비율 α_P" hint="기준연납순보험료 배수">
              <NumInput value={e.alphaP} step={0.05} min={0} max={5} onCommit={(v) => set({ alphaP: v })} className="text-right" />
            </Field>
            <Pct label="유지비 정액 β_S" value={e.betaS} onCommit={(v) => set({ betaS: v })} />
            <Pct label="유지비율 β_G" value={e.betaG} onCommit={(v) => set({ betaG: v })} hint="영업보험료 대비" />
            <Pct label="납입 후 유지비 β′" value={e.betaPrime} onCommit={(v) => set({ betaPrime: v })} />
            <Pct label="수금비 γ" value={e.gamma} onCommit={(v) => set({ gamma: v })} />
          </>
        ) : (
          <>
            <Pct label="신계약비 α" value={e.alpha} onCommit={(v) => set({ alpha: v })} />
            <Pct label="유지비 β" value={e.beta} onCommit={(v) => set({ beta: v })} />
            <Pct label="수금비 γ" value={e.gamma} onCommit={(v) => set({ gamma: v })} />
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-navy/50">보장기간이 20년보다 짧으면 α_P는 n/20배로 줄입니다(설계형과 같은 규칙).</p>
    </Card>
  );
}
