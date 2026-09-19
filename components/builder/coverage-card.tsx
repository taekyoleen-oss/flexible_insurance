"use client";
import { BENEFIT_KINDS, type BenefitKind, type PlanStep } from "@/lib/engine";
import { usePlan } from "./plan-provider";
import { Button, Card, Field, Input, NumInput, Select } from "@/components/ui";
import { won } from "@/lib/format";
import { kindMeta, type CoveragePatch } from "@/lib/plan-state";
import { RATE_PRESETS } from "@/lib/plan-rates";

/** 담보 목록: 고르고, 더하고, 지운다 */
export function CoverageList() {
  const { state: s, dispatch, result } = usePlan();
  return (
    <Card title="담보">
      <ul className="space-y-1">
        {s.coverages.map((c, i) => {
          const row = result.coverages[i];
          const on = c.id === (s.selected || s.coverages[0].id);
          return (
            <li key={c.id}>
              <button type="button" onClick={() => dispatch({ type: "selectCoverage", id: c.id })}
                className={`flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${on ? "bg-sky/10 text-navy" : "text-navy/70 hover:bg-navy/5"}`}>
                <span className="truncate">{c.label}<span className="ml-1 text-xs text-navy/50">{kindMeta(c.kind).label}</span></span>
                <span className="shrink-0 font-mono text-xs">{won(row?.monthlyGross ?? 0)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button onClick={() => dispatch({ type: "addCoverage" })} disabled={s.coverages.length >= 12}>담보 추가</Button>
        <Button onClick={() => dispatch({ type: "removeCoverage", id: s.selected })} disabled={s.coverages.length <= 1}>선택 담보 삭제</Button>
      </div>
      <p className="mt-2 text-xs text-navy/50">담보마다 따로 산출해 합칩니다. 담보별 보험료는 오른쪽 금액입니다.</p>
    </Card>
  );
}

/** 선택한 담보의 조건 + 보험금 증액·감액 구간 */
export function CoverageEditor() {
  const { state: s, dispatch, current: c, result } = usePlan();
  const meta = kindMeta(c.kind);
  const row = result.coverages.find((r) => r.id === c.id);
  const set = (patch: CoveragePatch) => dispatch({ type: "coverage", id: c.id, patch });
  const setSteps = (steps: PlanStep[]) => set({ steps });
  const lastAge = Math.min(c.endAge, s.age + result.n - 1);

  const addStep = () => {
    const from = c.steps.length ? Math.min(c.steps[c.steps.length - 1].toAge + 1, lastAge) : s.age;
    setSteps([...c.steps, { fromAge: from, toAge: lastAge, multiple: c.steps.length ? 0.5 : 1 }]);
  };

  return (
    <Card title={<span>담보 조건 <span className="text-sm font-normal text-navy/50">{c.label}</span></span>}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="담보 이름"><Input value={c.label} onChange={(e) => set({ label: e.target.value })} className="font-sans" /></Field>
        <Field label="급부 유형" hint={meta.hint}>
          <Select value={c.kind} onChange={(e) => set({ kind: e.target.value as BenefitKind })}>
            {BENEFIT_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label={`보장금액 (${meta.unit})`} hint={c.kind === "daily" ? "1일당 금액" : undefined}>
          <div className="flex items-center gap-1">
            <NumInput value={Math.round(c.amount / 1e4)} min={0} step={100} onCommit={(v) => set({ amount: Math.max(0, Math.round(v) * 1e4) })} className="text-right" />
            <span className="shrink-0 text-sm text-navy/60">만원</span>
          </div>
        </Field>
        <Field label="보장 종료 연령" hint={`${c.endAge}세까지 보장 (${row?.n ?? 0}년)`}>
          <NumInput value={c.endAge} min={s.age} max={120} onCommit={(v) => set({ endAge: Math.max(s.age, Math.round(v)) })} />
        </Field>
        <Field label="면책기간 (개월)" hint={c.waitMonths > 0 ? `첫해 급부 ${Math.round((1 - c.waitMonths / 12) * 100)}%` : "없음"}>
          <NumInput value={c.waitMonths} min={0} max={24} onCommit={(v) => set({ waitMonths: Math.max(0, Math.round(v)) })} />
        </Field>
        <Field label="위험률 출처">
          <Select value={c.presetId} onChange={(e) => {
            const p = RATE_PRESETS.find((x) => x.id === e.target.value);
            if (p) set({ presetId: p.id, grid: p.build(s.sex, s.age, c.endAge) });
          }}>
            {c.presetId === "custom" && <option value="custom">직접 입력 (붙여넣기·업로드·셀 편집)</option>}
            {RATE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        <div className="sm:col-span-2 lg:col-span-2 self-end text-xs text-navy/50">
          {c.presetId === "custom" ? "표를 직접 고쳤습니다. 목록에서 다른 표를 고르면 덮어씁니다." : RATE_PRESETS.find((p) => p.id === c.presetId)?.note}
        </div>
      </div>

      {c.kind === "survival" ? (
        <div className="mt-4 border-t border-navy/10 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-navy">지급 시점 (생존 시)</h3>
            <Button onClick={() => set({ points: [...c.points, { age: c.endAge, multiple: 1 }] })}>시점 추가</Button>
          </div>
          {c.points.length === 0 && <p className="mt-2 text-xs text-navy/50">시점이 없으면 급부가 없습니다. 만기환급금이면 만기 나이를 넣으세요.</p>}
          <ul className="mt-2 space-y-2">
            {c.points.map((p, i) => (
              <li key={i} className="flex items-center gap-2 text-sm">
                <NumInput value={p.age} min={s.age} max={120} className="w-20" onCommit={(v) => set({ points: c.points.map((x, j) => (j === i ? { ...x, age: Math.round(v) } : x)) })} />
                <span className="text-navy/60">세에</span>
                <NumInput value={p.multiple} step={0.1} min={0} className="w-20" onCommit={(v) => set({ points: c.points.map((x, j) => (j === i ? { ...x, multiple: v } : x)) })} />
                <span className="text-navy/60">배 = {won(p.multiple * c.amount)}</span>
                <Button onClick={() => set({ points: c.points.filter((_, j) => j !== i) })}>삭제</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="mt-4 border-t border-navy/10 pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-navy">보험금 증액·감액</h3>
            <Button onClick={addStep}>구간 추가</Button>
          </div>
          <p className="mt-1 text-xs text-navy/50">
            연령 구간마다 보장금액 배수를 정합니다. 구간이 없으면 전 기간 1.0배({won(c.amount)}). 겹치면 뒤 구간이 이깁니다.
          </p>
          <ul className="mt-2 space-y-2">
            {c.steps.map((st, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <NumInput value={st.fromAge} min={s.age} max={120} className="w-20" onCommit={(v) => setSteps(c.steps.map((x, j) => (j === i ? { ...x, fromAge: Math.round(v) } : x)))} />
                <span className="text-navy/60">~</span>
                <NumInput value={st.toAge} min={s.age} max={120} className="w-20" onCommit={(v) => setSteps(c.steps.map((x, j) => (j === i ? { ...x, toAge: Math.round(v) } : x)))} />
                <span className="text-navy/60">세</span>
                <NumInput value={st.multiple} step={0.1} min={0} max={10} className="w-20" onCommit={(v) => setSteps(c.steps.map((x, j) => (j === i ? { ...x, multiple: v } : x)))} />
                <span className="text-navy/60">배 = {won(st.multiple * c.amount)}</span>
                <Button onClick={() => setSteps(c.steps.filter((_, j) => j !== i))}>삭제</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
