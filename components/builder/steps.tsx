"use client";
import { useState, type ReactNode } from "react";
import { BENEFIT_KINDS, type BenefitKind, type PlanStep as Segment } from "@/lib/engine";
import { usePlan } from "./plan-provider";
import { Button, Field, Input, NumInput, Select } from "@/components/ui";
import { pct, won } from "@/lib/format";
import { kindLabel, RATE_KINDS } from "@/lib/plan-rates";
import { colLetter } from "@/lib/sheet-formula";
import { FREQS, PAY_YEARS, kindMeta, type ContractPatch, type CoveragePatch, type PlanStepCard, type StepStatus } from "@/lib/plan-state";

const BADGE: Record<StepStatus, { label: string; cls: string }> = {
  idle: { label: "대기", cls: "bg-navy/5 text-navy/50" },
  editing: { label: "입력 중", cls: "bg-[#fef3c7] text-[#92400e]" },
  done: { label: "완료", cls: "bg-sky/15 text-sky" },
  error: { label: "오류", cls: "bg-[#fee2e2] text-[#991b1b]" },
};

const Pct = ({ label, value, onCommit, hint }: { label: string; value: number; onCommit: (v: number) => void; hint?: string }) => (
  <Field label={label} hint={hint}>
    <div className="flex items-center gap-1">
      <NumInput value={Math.round(value * 1e4) / 100} step={0.05} min={0} onCommit={(v) => onCommit(v / 100)} className="text-right" />
      <span className="shrink-0 text-sm text-navy/60">%</span>
    </div>
  </Field>
);

/** Life_Prem_Calc 파이프라인과 같은 모양의 단계 카드 — 번호·코드·제목·상태 배지·요약 칩·ⓘ·이동·삭제·펼치기 */
function StepCard({ step, index, expanded, onToggle, move, remove, children }: {
  step: PlanStepCard; index: number; expanded: boolean; onToggle: () => void;
  move?: (dir: -1 | 1) => void; remove?: () => void; children: ReactNode;
}) {
  const [help, setHelp] = useState(false);
  const b = BADGE[step.status];
  const btn = "rounded px-1 py-0.5 text-xs text-navy/50 hover:bg-navy/5 disabled:opacity-30";
  return (
    <section className={`rounded-xl border bg-white shadow-sm transition-colors ${expanded ? "border-sky" : "border-navy/10"}`}>
      <header className="flex cursor-pointer items-center gap-3 px-3 py-2.5" onClick={onToggle}>
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${step.status === "done" ? "bg-sky text-white" : step.status === "error" ? "bg-[#fee2e2] text-[#991b1b]" : "bg-navy/5 text-navy/50"}`}>{index + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-navy/40">{step.code}</span>
            <h3 className="text-sm font-semibold text-navy">{step.title}</h3>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${b.cls}`}>{b.label}</span>
          </div>
          {!expanded && step.summary.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {step.summary.filter(Boolean).map((t, i) => <span key={i} className="rounded bg-navy/5 px-1.5 py-0.5 font-mono text-[11px] text-navy/60">{t}</span>)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => setHelp((v) => !v)} className={`rounded-full px-1.5 py-0.5 text-xs ${help ? "bg-sky/10 text-sky" : "text-navy/40 hover:bg-navy/5"}`} title="설명 보기">ⓘ</button>
          {move && <><button type="button" className={btn} onClick={() => move(-1)} title="위로">▲</button><button type="button" className={btn} onClick={() => move(1)} title="아래로">▼</button></>}
          {remove && <button type="button" onClick={remove} className="rounded px-1.5 py-0.5 text-xs text-navy/50 hover:bg-[#fee2e2] hover:text-[#991b1b]" title="삭제">삭제</button>}
        </div>
        <span className="shrink-0 rounded border border-navy/15 px-1.5 py-0.5 text-[11px] text-navy/50">{expanded ? "▾ 접기" : "▸ 펼치기"}</span>
      </header>
      {help && <div className="border-t border-navy/10 bg-sky/[0.03] px-3 py-2 text-xs leading-relaxed text-navy/70">{step.help}</div>}
      {expanded && (
        <div className="border-t border-navy/10 px-3 py-3">
          {step.message && <p className={`mb-2 rounded px-2 py-1.5 text-xs ${step.status === "error" ? "bg-[#fee2e2] text-[#991b1b]" : "bg-[#fef3c7] text-[#92400e]"}`}>{step.message}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

// ── 단계 본문 ────────────────────────────────────────────────────────────────
function ProductBody() {
  const { state: s, dispatch } = usePlan();
  const set = (patch: ContractPatch) => dispatch({ type: "contract", patch });
  return (
    <div className="space-y-3">
      <Field label="상품 이름"><Input value={s.productName} onChange={(e) => set({ productName: e.target.value })} className="font-sans" /></Field>
      <Field label="메모"><Input value={s.memo} onChange={(e) => set({ memo: e.target.value })} className="font-sans" placeholder="산출 조건·출처 메모" /></Field>
    </div>
  );
}

function ContractBody() {
  const { state: s, dispatch, result } = usePlan();
  const set = (patch: ContractPatch) => dispatch({ type: "contract", patch });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="성별"><Select value={s.sex} onChange={(e) => set({ sex: e.target.value as "M" | "F" })}><option value="M">남</option><option value="F">여</option></Select></Field>
      <Field label="가입나이"><NumInput value={s.age} min={0} max={90} onCommit={(v) => set({ age: Math.round(v) })} /></Field>
      <Field label="보험기간" hint={s.termYears === 0 ? `자동 ${result.n}년` : "0 = 자동"}><NumInput value={s.termYears} min={0} max={110} onCommit={(v) => set({ termYears: Math.round(v) })} /></Field>
      <Field label="납입기간">
        <Select value={s.payYears} onChange={(e) => set({ payYears: Number(e.target.value) })}>
          {PAY_YEARS.map((y) => <option key={y} value={y}>{y}년납</option>)}
          {!PAY_YEARS.includes(s.payYears as (typeof PAY_YEARS)[number]) && <option value={s.payYears}>{s.payYears}년납</option>}
        </Select>
      </Field>
      <Field label="납입주기"><Select value={s.freq} onChange={(e) => set({ freq: Number(e.target.value) })}>{FREQS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}</Select></Field>
    </div>
  );
}

function BasisBody() {
  const { state: s, dispatch } = usePlan();
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Pct label="예정이율 i" value={s.interest} onCommit={(v) => dispatch({ type: "contract", patch: { interest: v } })} />
        <Pct label="표준이율" value={s.standardInterest} onCommit={(v) => dispatch({ type: "contract", patch: { standardInterest: v } })} hint="표준책임준비금" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-sky" checked={s.low.on} onChange={(e) => dispatch({ type: "low", patch: { on: e.target.checked } })} />
        저해지·무해지환급형
      </label>
      {s.low.on && (
        <div className="grid grid-cols-2 gap-3">
          <Pct label="환급률 w^r (0 = 무해지)" value={s.low.ratio} onCommit={(v) => dispatch({ type: "low", patch: { ratio: v } })} />
          <Pct label="적용해지율 w" value={s.low.lapseRate} onCommit={(v) => dispatch({ type: "low", patch: { lapseRate: v } })} hint="납입기간 중에만" />
          <p className="col-span-2 text-xs text-navy/55">납입기간 중 해약환급금 = 표준형 × {Math.round(s.low.ratio * 100)}%. 해지급부 현가 CSV를 급부 현가에 더해 다시 산출합니다.</p>
        </div>
      )}
    </div>
  );
}

function RatesBody() {
  const { state: s, dispatch, sheet: res } = usePlan();
  return (
    <div className="space-y-2">
      <p className="text-xs text-navy/55">왼쪽 시트의 열입니다. 유형이 담보·납입면제와의 연결을 정합니다.</p>
      <ul className="space-y-1.5">
        {s.sheet.columns.map((c, i) => (
          <li key={c.id} className="rounded border border-navy/10 p-2">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-navy/40">{colLetter(i + 1)}</span>
              <Input value={c.name} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { name: e.target.value } })} className="h-7 flex-1 py-0.5 font-sans text-xs" />
              <button type="button" onClick={() => dispatch({ type: "removeColumn", colId: c.id })} disabled={s.sheet.columns.length <= 1} className="px-1 text-navy/40 hover:text-[#a34a1e] disabled:opacity-30" title="열 삭제">×</button>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Select value={c.kind} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { kind: e.target.value as typeof c.kind } })} className="w-auto py-0.5 text-xs">
                {RATE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
              </Select>
              <label className="flex items-center gap-1 text-xs text-navy/70">
                <input type="checkbox" className="accent-sky" checked={c.waiver} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { waiver: e.target.checked } })} />
                납입면제에 포함
              </label>
              <span className="font-mono text-[11px] text-navy/40">{(res.byId[c.id]?.[0] ?? 0).toPrecision(3)} …</span>
            </div>
            <p className="mt-1 text-[11px] text-navy/50">{RATE_KINDS.find((k) => k.kind === c.kind)?.hint}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WaiverBody() {
  const { state: s, dispatch } = usePlan();
  const cols = s.sheet.columns.filter((c) => c.waiver);
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="accent-sky" checked={s.waiver} onChange={(e) => dispatch({ type: "contract", patch: { waiver: e.target.checked } })} />
        납입면제 적용
      </label>
      <p className="text-xs text-navy/55">
        납입면제 체크를 켠 열의 합이 납입자 집단 l′의 탈퇴율 f가 됩니다. 급부집단 l은 그대로라 보장은 계속됩니다.
      </p>
      <ul className="space-y-1">
        {s.sheet.columns.map((c, i) => (
          <li key={c.id}>
            <label className="flex items-center gap-2 text-xs text-navy/70">
              <input type="checkbox" className="accent-sky" checked={c.waiver} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { waiver: e.target.checked } })} />
              <span className="font-mono text-navy/40">{colLetter(i + 1)}</span> {c.name}
              <span className="text-navy/40">({kindLabel(c.kind)})</span>
            </label>
          </li>
        ))}
      </ul>
      {cols.length > 0 && <p className="text-[11px] text-navy/50">f = {cols.map((c) => c.name).join(" + ")}</p>}
      <p className="text-[11px] text-navy/50">표가 없으면 왼쪽 시트에서 &quot;납입면제 발생률 f&quot; 열을 불러오거나, 수식(예: <span className="font-mono">=B3*0.5</span>)으로 만들거나, Excel에서 붙여넣으세요.</p>
    </div>
  );
}

function CoverageBody({ id }: { id: string }) {
  const { state: s, dispatch, result } = usePlan();
  const c = s.coverages.find((x) => x.id === id)!;
  const meta = kindMeta(c.kind);
  const row = result.coverages.find((r) => r.id === id);
  const set = (patch: CoveragePatch) => dispatch({ type: "coverage", id, patch });
  const setSegs = (steps: Segment[]) => set({ steps });
  const lastAge = Math.min(c.endAge, s.age + result.n - 1);
  const letterOf = (colId: string) => { const i = s.sheet.columns.findIndex((x) => x.id === colId); return i < 0 ? "—" : colLetter(i + 1); };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="담보 이름"><Input value={c.label} onChange={(e) => set({ label: e.target.value })} className="font-sans" /></Field>
        <Field label="급부 유형" hint={meta.hint}>
          <Select value={c.kind} onChange={(e) => set({ kind: e.target.value as BenefitKind })}>{BENEFIT_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</Select>
        </Field>
        <Field label={`보장금액 (${meta.unit})`}>
          <div className="flex items-center gap-1">
            <NumInput value={Math.round(c.amount / 1e4)} min={0} step={100} onCommit={(v) => set({ amount: Math.max(0, Math.round(v) * 1e4) })} className="text-right" />
            <span className="shrink-0 text-sm text-navy/60">만원</span>
          </div>
        </Field>
        <Field label="보장 종료 연령" hint={`${row?.n ?? 0}년`}><NumInput value={c.endAge} min={s.age} max={120} onCommit={(v) => set({ endAge: Math.max(s.age, Math.round(v)) })} /></Field>
        <Field label="면책기간 (개월)" hint={c.waitMonths > 0 ? `첫해 급부 ${Math.round((1 - c.waitMonths / 12) * 100)}%` : "없음"}>
          <NumInput value={c.waitMonths} min={0} max={24} onCommit={(v) => set({ waitMonths: Math.max(0, Math.round(v)) })} />
        </Field>
        {c.kind !== "survival" && (
          <Field label="급부 열" hint={`${letterOf(c.eventColId)}열`}>
            <Select value={c.eventColId} onChange={(e) => set({ eventColId: e.target.value })}>
              {s.sheet.columns.map((x, i) => <option key={x.id} value={x.id}>{colLetter(i + 1)} · {x.name} ({kindLabel(x.kind)})</option>)}
            </Select>
          </Field>
        )}
      </div>

      <div>
        <p className="text-xs font-medium text-navy/70">탈퇴 열 (합산)</p>
        <p className="mb-1 text-[11px] text-navy/50">이 담보를 소멸시키는 사유 전부. 최초발생 열은 넣고, 반복지급 열은 넣지 않습니다.</p>
        <div className="flex flex-wrap gap-2">
          {s.sheet.columns.map((x, i) => (
            <label key={x.id} className="flex items-center gap-1 rounded border border-navy/10 px-1.5 py-0.5 text-xs text-navy/70">
              <input type="checkbox" className="accent-sky" checked={c.exitColIds.includes(x.id)}
                onChange={(e) => set({ exitColIds: e.target.checked ? [...c.exitColIds, x.id] : c.exitColIds.filter((y) => y !== x.id) })} />
              <span className="font-mono text-navy/40">{colLetter(i + 1)}</span> {x.name}
            </label>
          ))}
        </div>
      </div>

      {c.kind === "survival" ? (
        <div className="border-t border-navy/10 pt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-navy/70">지급 시점 (생존 시)</h4>
            <Button onClick={() => set({ points: [...c.points, { age: c.endAge + 1, multiple: 1 }] })}>시점 추가</Button>
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {c.points.map((p, i) => (
              <li key={i} className="flex items-center gap-1.5 text-xs">
                <NumInput value={p.age} min={s.age} max={120} className="w-16" onCommit={(v) => set({ points: c.points.map((x, j) => (j === i ? { ...x, age: Math.round(v) } : x)) })} />
                <span className="text-navy/60">세에</span>
                <NumInput value={p.multiple} step={0.1} min={0} className="w-16" onCommit={(v) => set({ points: c.points.map((x, j) => (j === i ? { ...x, multiple: v } : x)) })} />
                <span className="text-navy/60">배 = {won(p.multiple * c.amount)}</span>
                <Button onClick={() => set({ points: c.points.filter((_, j) => j !== i) })}>삭제</Button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="border-t border-navy/10 pt-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-navy/70">보험금 증액·감액</h4>
            <Button onClick={() => setSegs([...c.steps, { fromAge: c.steps.length ? Math.min(c.steps[c.steps.length - 1].toAge + 1, lastAge) : s.age, toAge: lastAge, multiple: c.steps.length ? 0.5 : 1 }])}>구간 추가</Button>
          </div>
          <p className="mt-1 text-[11px] text-navy/50">구간이 없으면 전 기간 1.0배({won(c.amount)}). 겹치면 뒤 구간이 이깁니다.</p>
          <ul className="mt-1.5 space-y-1.5">
            {c.steps.map((st, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                <NumInput value={st.fromAge} min={s.age} max={120} className="w-16" onCommit={(v) => setSegs(c.steps.map((x, j) => (j === i ? { ...x, fromAge: Math.round(v) } : x)))} />
                <span className="text-navy/60">~</span>
                <NumInput value={st.toAge} min={s.age} max={120} className="w-16" onCommit={(v) => setSegs(c.steps.map((x, j) => (j === i ? { ...x, toAge: Math.round(v) } : x)))} />
                <span className="text-navy/60">세</span>
                <NumInput value={st.multiple} step={0.1} min={0} max={10} className="w-16" onCommit={(v) => setSegs(c.steps.map((x, j) => (j === i ? { ...x, multiple: v } : x)))} />
                <span className="text-navy/60">배 = {won(st.multiple * c.amount)}</span>
                <Button onClick={() => setSegs(c.steps.filter((_, j) => j !== i))}>삭제</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {row && <p className="border-t border-navy/10 pt-2 font-mono text-xs text-navy/60">이 담보 보험료 {won(row.monthlyGross)} · 10만원당 {row.per100k.gross.toLocaleString()}원</p>}
    </div>
  );
}

function ExpenseBody() {
  const { state: s, dispatch } = usePlan();
  const e = s.expenses;
  const set = (patch: Record<string, number>) => dispatch({ type: "expenses", patch });
  return (
    <div className="space-y-3">
      <Field label="모형">
        <Select value={e.model} onChange={(ev) => dispatch({ type: "expenseModel", model: ev.target.value as typeof e.model })}>
          <option value="method">산출방법서형 (α_S·α_P·β_S·β_G·β′·γ)</option>
          <option value="simple">3이원 단순형 (α·β·γ)</option>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        {e.model === "method" ? (
          <>
            <Pct label="신계약비 정액 α_S" value={e.alphaS} onCommit={(v) => set({ alphaS: v })} hint="보장금액 대비" />
            <Field label="신계약비율 α_P" hint="기준연납순보험료 배수"><NumInput value={e.alphaP} step={0.05} min={0} max={5} onCommit={(v) => set({ alphaP: v })} className="text-right" /></Field>
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
    </div>
  );
}

function ResultBody() {
  const { state: s, result: r } = usePlan();
  const eff = r.effective;
  const paidOut = r.survival.slice(0, r.payYears + 1).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-2 text-sm">
      <div>
        <div className="text-xs text-navy/60">{s.freq === 12 ? "월" : s.freq === 1 ? "연" : `${12 / s.freq}개월`} 영업보험료</div>
        <div className="font-mono text-2xl text-navy">{won(eff.monthlyGross)}</div>
      </div>
      <dl className="grid grid-cols-[1fr_auto] gap-y-1 text-xs">
        <dt className="text-navy/60">순보험료</dt><dd className="font-mono">{won(eff.monthlyNet)}</dd>
        <dt className="text-navy/60">총 납입 ({r.payYears}년)</dt><dd className="font-mono">{won(eff.totalPaid)}</dd>
        <dt className="text-navy/60">납입 완료 환급률</dt><dd className="font-mono">{pct(eff.rate[r.payYears] ?? 0)}{paidOut > 0 && ` + ${won(paidOut)}`}</dd>
        {r.low && <><dt className="text-navy/60">표준형 대비</dt><dd className="font-mono">−{pct(r.low.premiumDiscount)}</dd></>}
      </dl>
      <p className="text-[11px] text-navy/50">아래 그래프와 표에 담보별 보험료·연도별 보장금액·책임준비금·해약환급금이 나옵니다.</p>
    </div>
  );
}

/** 오른쪽 단계 목록 */
export function StepList() {
  const { state: s, dispatch, steps } = usePlan();
  const covCount = s.coverages.length;
  return (
    <div className="space-y-2">
      {steps.map((step, i) => {
        const cov = step.coverageId;
        return (
          <StepCard key={step.id} step={step} index={i} expanded={s.open.includes(step.id)} onToggle={() => dispatch({ type: "toggleStep", id: step.id })}
            move={cov ? (dir) => dispatch({ type: "moveCoverage", id: cov, dir }) : undefined}
            remove={cov && covCount > 1 ? () => dispatch({ type: "removeCoverage", id: cov }) : undefined}>
            {step.id === "product" && <ProductBody />}
            {step.id === "contract" && <ContractBody />}
            {step.id === "basis" && <BasisBody />}
            {step.id === "rates" && <RatesBody />}
            {step.id === "waiver" && <WaiverBody />}
            {cov && <CoverageBody id={cov} />}
            {step.id === "expense" && <ExpenseBody />}
            {step.id === "result" && <ResultBody />}
          </StepCard>
        );
      })}
      {idxGuard(covCount)}
      <div className="flex flex-wrap gap-2 rounded-xl border border-dashed border-navy/20 p-2">
        <span className="self-center text-xs text-navy/60">담보 추가</span>
        {BENEFIT_KINDS.map((k) => (
          <Button key={k.kind} onClick={() => dispatch({ type: "addCoverage", kind: k.kind })} disabled={covCount >= 12} title={k.hint}>＋ {k.label}</Button>
        ))}
      </div>
    </div>
  );
}

// 담보 수가 상한에 닿았을 때만 안내를 띄운다
const idxGuard = (n: number) => (n >= 12 ? <p className="text-xs text-[#a34a1e]">담보는 12개까지 넣을 수 있습니다.</p> : null);
