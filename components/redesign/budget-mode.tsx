"use client";
import { Card, Field, ThousandInput } from "@/components/ui";
import { won } from "@/lib/format";
import { budgetFor, type BudgetMode, type OldContract } from "@/lib/redesign";

const LABEL: Record<BudgetMode, string> = { continue: "납입 지속", reduce: "감액", stop: "납입 중단(감액완납형)" };
const DESC: Record<BudgetMode, string> = { continue: "준비금을 이월하고 지금 보험료를 그대로 냅니다", reduce: "준비금을 이월하고 보험료를 낮춰 냅니다", stop: "해약환급금만 이월하고 더 내지 않습니다" };

export function BudgetModePanel({ old, mode, reduced, onChange }: { old: OldContract; mode: BudgetMode; reduced: number; onChange: (mode: BudgetMode, reduced: number) => void }) {
  const b = budgetFor(old, mode, reduced);
  return (
    <Card title="2. 예산">
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(LABEL) as BudgetMode[]).map((m) => {
          const bb = budgetFor(old, m, reduced);
          return (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => onChange(m, reduced)}
              className={`rounded border p-3 text-left ${mode === m ? "border-sky bg-sky/10" : "border-navy/15 hover:bg-navy/5"}`}>
              <div className="text-sm font-medium text-navy">{LABEL[m]}</div>
              <div className="text-xs text-navy/60">{DESC[m]}</div>
              <div className="mt-1 font-mono text-xs text-navy">이월 {won(bb.carry)} · 월 {won(bb.monthlyGross)} · {bb.payYears}년</div>
            </button>
          );
        })}
      </div>
      {mode === "reduce" && (
        <div className="mt-3 max-w-xs"><Field label="낮춘 월 보험료" hint={`원계약 월 ${won(old.monthlyGross)} 이하`}><ThousandInput value={reduced} onChange={(v) => onChange("reduce", v)} min={0} max={Math.floor(old.monthlyGross / 1e3)} /></Field></div>
      )}
      <p className="mt-2 text-xs text-navy/60">이월 {won(b.carry)} + 월 {won(b.monthlyGross)} × {b.payYears}년 → 새 기준보험금은 3단계 그래프에서 스케줄에 맞춰 자동 역산됩니다. 신계약비는 붙지 않습니다.</p>
    </Card>
  );
}
