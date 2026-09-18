"use client";
import { FormulaHelp } from "@/components/formula-help";
import Link from "next/link";
import type { ReactNode } from "react";
import { useDesign } from "@/components/design-provider";
import { Button, Card, Field, NumInput, Select, MillionInput } from "@/components/ui";
import { ASSUMPTIONS, compute, DEFAULT_ENVELOPE, getAssumption, type AssumptionSet, type EnvelopeParams } from "@/lib/engine";
import { won } from "@/lib/format";
import { DEFAULT_SETTINGS, TABLE } from "@/lib/state";

/** 소수(0.025) ↔ 퍼센트 입력(2.5) */
const Pct = ({ label, value, onCommit, hint }: { label: ReactNode; value: number; onCommit: (v: number) => void; hint?: string }) => (
  <Field label={label} hint={hint}><div className="flex items-center gap-1"><NumInput value={Math.round(value * 1e4) / 100} step={0.05} min={0} max={100} onCommit={(v) => onCommit(v / 100)} /><span className="text-sm text-navy/60">%</span></div></Field>
);

const G1 = { sex: "M" as const, age: 31, payYears: 20, S0: 1e8, termYears: 59, blocks: [{ fromAge: 31, toAge: 89, multiple: 1, kind: "death" as const }] };

export default function SettingsPage() {
  const { state, dispatch, loaded } = useDesign();
  if (!loaded) return null;
  const { assumption: a, envelope: env } = state.settings;
  const setA = (patch: Partial<AssumptionSet>) => dispatch({ type: "settings", patch: { assumption: { ...a, ...patch } } });
  const setExp = (patch: Record<string, number>) => setA({ expenses: { ...a.expenses, ...patch } as AssumptionSet["expenses"] });
  const setEnv = (patch: Partial<EnvelopeParams>) => dispatch({ type: "settings", patch: { envelope: { ...env, ...patch } } });
  const baseId = a.id === "custom" ? (a.label.match(/기본: ([\w-]+)/)?.[1] ?? "default-2026") : a.id;

  // 골든 G1: 검증 세트로 31세 남 정기 59년 20년납 → 10만원당 영업보험료 133원 (엔진 테스트와 같은 조건)
  const g1 = compute(G1, getAssumption("verify-term-1504"), TABLE);
  const g1now = compute(G1, a, TABLE);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between"><h1 className="font-display text-2xl text-navy">설정</h1><Link href="/design" className="text-sm text-sky hover:underline">← 설계로</Link></div>
      <p className="text-sm text-navy/60">설정은 현재 설계와 함께 저장되고 공유 링크·제안서에 실립니다. 숫자를 고치면 &quot;사용자 정의&quot; 세트가 됩니다.</p>

      <Card title="가정 세트">
        <Field label="세트">
          <Select value={baseId} onChange={(e) => dispatch({ type: "settings", patch: { assumption: getAssumption(e.target.value) } })}>
            {ASSUMPTIONS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
        <p className="mt-1 text-xs text-navy/60">현재: {a.label}{a.id === "custom" ? "" : ` (${a.version})`}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Pct label={<>예정이율 <FormulaHelp id="commutation" /></>} value={a.interest} onCommit={(v) => setA({ interest: v })} />
          <Pct label="표준이율 (표준 준비금)" value={a.standardInterest} onCommit={(v) => setA({ standardInterest: v })} />
          <Pct label={<>저해지 환급금 비율 (납입기간 중, 0 = 무해지) <FormulaHelp id="lowSurrender" /></>} value={a.lowSurrender.ratio} onCommit={(v) => setA({ lowSurrender: { ...a.lowSurrender, ratio: v } })} />
          <Pct label={<>적용해지율 w (납입기간 중, 납입 후 0) <FormulaHelp id="lowSurrender" /></>} value={a.lowSurrender.lapseRate} onCommit={(v) => setA({ lowSurrender: { ...a.lowSurrender, lapseRate: v } })} />
        </div>
        <h3 className="mt-4 text-sm font-medium text-navy">사업비 ({a.expenses.model === "method" ? "산출방법서형" : "3이원 단순형"})</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {a.expenses.model === "method" ? (
            <>
              <Pct label="신계약비 정액 α_S (기준보험금 대비)" value={a.expenses.alphaS} onCommit={(v) => setExp({ alphaS: v })} />
              <Field label="신계약비율 α_P (기준연납순보험료 배수)"><NumInput value={a.expenses.alphaP} step={0.05} min={0} max={5} onCommit={(v) => setExp({ alphaP: v })} /></Field>
              <Pct label="유지비 정액 β_S" value={a.expenses.betaS} onCommit={(v) => setExp({ betaS: v })} />
              <Pct label="유지비율 β_G" value={a.expenses.betaG} onCommit={(v) => setExp({ betaG: v })} />
              <Pct label="납입 후 유지비 β′" value={a.expenses.betaPrime} onCommit={(v) => setExp({ betaPrime: v })} />
              <Pct label="수금비 γ" value={a.expenses.gamma} onCommit={(v) => setExp({ gamma: v })} />
            </>
          ) : (
            <>
              <Pct label="α" value={a.expenses.alpha} onCommit={(v) => setExp({ alpha: v })} />
              <Pct label="β" value={a.expenses.beta} onCommit={(v) => setExp({ beta: v })} />
              <Pct label="γ" value={a.expenses.gamma} onCommit={(v) => setExp({ gamma: v })} />
            </>
          )}
        </div>
        <h3 className="mt-4 text-sm font-medium text-navy">니즈 계산</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <Pct label="할인율" value={a.needs.discount} onCommit={(v) => setA({ needs: { ...a.needs, discount: v } })} />
          <Pct label="생활비 비율" value={a.needs.livingRatio} onCommit={(v) => setA({ needs: { ...a.needs, livingRatio: v } })} />
          <Pct label="본인 소비 비율 (HLV)" value={a.needs.selfRatio} onCommit={(v) => setA({ needs: { ...a.needs, selfRatio: v } })} />
          <Field label="자녀 1인 교육·결혼"><MillionInput value={a.needs.educationPerChild} onChange={(v) => setA({ needs: { ...a.needs, educationPerChild: v } })} max={1e4} /></Field>
          <Field label="정리 자금"><MillionInput value={a.needs.finalExpense} onChange={(v) => setA({ needs: { ...a.needs, finalExpense: v } })} max={1e4} /></Field>
          <Field label="자녀 독립 연령"><NumInput value={a.needs.independenceAge} min={18} max={35} onCommit={(v) => setA({ needs: { ...a.needs, independenceAge: v } })} /></Field>
        </div>
      </Card>

      <Card title="설계 제약 (envelope)">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="초기 고정 연수 (E01)"><NumInput value={env.fixYears} min={0} max={20} onCommit={(v) => setEnv({ fixYears: v })} /></Field>
          <Pct label="연 증가율 상한 (E02)" value={env.maxGrowth} onCommit={(v) => setEnv({ maxGrowth: v })} />
          <Field label="증액 종료 연령 (E03)"><NumInput value={env.growthEndAge} min={40} max={100} onCommit={(v) => setEnv({ growthEndAge: v })} /></Field>
          <Field label="최대 배수 (E04)"><NumInput value={env.maxMultiple} step={0.1} min={1} max={10} onCommit={(v) => setEnv({ maxMultiple: v })} /></Field>
          <Pct label="감액 하한 (E05)" value={env.minMultiple} onCommit={(v) => setEnv({ minMultiple: v })} />
          <Field label="최소 보험금 (E06)"><MillionInput value={env.minAmount} onChange={(v) => setEnv({ minAmount: v })} max={1e3} /></Field>
          <Field label="심사 한도 (E07)"><MillionInput value={env.uwLimit} onChange={(v) => setEnv({ uwLimit: v })} max={1e5} /></Field>
        </div>
        <Button className="mt-3" onClick={() => setEnv(DEFAULT_ENVELOPE)}>제약 기본값</Button>
      </Card>

      <Card title="검산">
        <p className="text-sm">골든 G1 (31세 남 · 90세 만기 · 20년납 · 검증 세트 3.4%): 10만원당 영업보험료 <span className="font-mono">{g1.per100k.gross}원</span> — 기대값 133원 {g1.per100k.gross === 133 ? "✓" : "✗"}</p>
        <p className="mt-1 text-sm">같은 계약을 현재 설정으로: <span className="font-mono">{g1now.per100k.gross}원</span> (1억 기준 월 {won(g1now.monthly.gross)})</p>
        <Button className="mt-3" onClick={() => dispatch({ type: "settings", patch: DEFAULT_SETTINGS })}>모두 기본값으로</Button>
      </Card>
    </div>
  );
}
