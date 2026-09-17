"use client";
import { Fragment, useRef, useState, type RefObject } from "react";
import { useDesign } from "@/components/design-provider";
import { FormulaHelp } from "@/components/formula-help";
import { Button, Field, MillionInput, onBackdropClick } from "@/components/ui";
import { PRESETS } from "@/lib/engine";
import { won } from "@/lib/format";
import { recommend } from "@/lib/recommend";
import type { Profile } from "@/lib/state";

/**
 * "재무정보·기준보험금" 버튼 + 팝업. 연소득·유동자산·기존 보장을 입력하면 니즈·HLV 기준보험금 후보가 계산되고,
 * 고른 금액과 추천 프리셋을 "적용"으로 설계에 반영한다. 설계는 1억으로 시작하므로 적용 전에는 연소득이 "미반영"이다.
 */
export function FinanceButton({ compact = false, dlgRef }: { compact?: boolean; dlgRef?: RefObject<HTMLDialogElement | null> }) {
  const { state, dispatch } = useDesign();
  const own = useRef<HTMLDialogElement>(null);
  const dlg = dlgRef ?? own;
  const p = state.profile;
  const r = recommend(state);
  const d = r.needs.detail;
  const [amount, setAmount] = useState<"needs" | "hlv" | "keep">("needs");
  const [usePreset, setUsePreset] = useState(false);
  const setP = (patch: Partial<Profile>) => dispatch({ type: "profile", patch });
  const open = () => { setAmount(state.infoApplied.income ? "keep" : "needs"); setUsePreset(false); dlg.current?.showModal(); };
  const apply = () => {
    if (usePreset && state.presetId === "custom" && !confirm("직접 편집한 모양이 지워지고 추천 프리셋으로 다시 그립니다. 계속할까요?")) return;
    dispatch({ type: "applyInfo", applied: amount === "keep" ? {} : { income: true }, S0: amount === "needs" ? r.suggestedS0 : amount === "hlv" ? r.hlvS0 : undefined, presetId: usePreset ? r.presetId : undefined });
    dlg.current?.close();
  };
  const rows: [string, string][] = [
    [`생활비 (연소득×${Math.round(state.settings.assumption.needs.livingRatio * 100)}% × ${r.needs.yearsToIndependence}년 현가)`, won(d.living)],
    ["자녀 교육·결혼", won(d.education)], ["부채 상환", won(d.debt)], ["정리 자금", won(d.finalExpense)], ["− 기존 보장·유동자산", `−${won(d.offset)}`],
  ];
  return (
    <>
      {compact ? <button type="button" className="rounded border border-navy/20 px-1.5 py-0.5 text-xs text-navy hover:bg-navy/5" onClick={open}>입력</button> : <Button primary onClick={open}>재무정보·기준보험금</Button>}
      <dialog ref={dlg} className="m-auto w-[min(92vw,640px)] whitespace-normal rounded-lg bg-white p-5 text-left shadow-xl backdrop:bg-navy/50" onClick={onBackdropClick}>
        <h3 className="font-display text-lg text-navy">재무정보·기준보험금</h3>
        <p className="mt-1 text-xs text-navy/60">설계는 기준보험금 1억으로 시작합니다. 재무 정보를 넣으면 필요보장(니즈)과 인적자본(HLV)이 계산되고, 고른 금액을 &quot;적용&quot;하면 설계의 기준보험금이 바뀝니다.</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="연소득"><MillionInput value={p.income} onChange={(v) => setP({ income: v })} max={1e3} /></Field>
          <Field label="유동자산"><MillionInput value={p.liquidAssets} onChange={(v) => setP({ liquidAssets: v })} max={1e4} /></Field>
          <Field label="단체보험 보험금"><MillionInput value={p.groupCover} onChange={(v) => setP({ groupCover: v })} max={1e4} /></Field>
          <Field label="정기보험 보험금"><MillionInput value={p.termCover} onChange={(v) => setP({ termCover: v })} max={1e4} /></Field>
        </div>
        <p className="mt-1 text-xs text-navy/50">자녀 나이·부채·은퇴시기는 프리셋 카드에서 입력하며 여기 계산에도 쓰입니다.</p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <div className="text-xs text-navy/60">필요보장 (니즈) <FormulaHelp id="needs" /></div>
            <div className="font-mono text-xl text-navy">{won(r.needs.needs)}</div>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-y-0.5 text-xs">{rows.map(([k, v]) => <Fragment key={k}><dt className="text-navy/60">{k}</dt><dd className="font-mono">{v}</dd></Fragment>)}</dl>
          </div>
          <div>
            <div className="text-xs text-navy/60">인적자본 (HLV, 은퇴까지 {r.needs.yearsToRetirement}년) <FormulaHelp id="hlv" /></div>
            <div className="font-mono text-xl text-navy">{won(r.needs.hlv)}</div>
          </div>
        </div>

        <h4 className="mt-4 text-sm font-medium text-navy">기준보험금</h4>
        <ul className="mt-1 space-y-1 text-sm">
          {([["needs", `필요보장(니즈) ${won(r.suggestedS0)}`], ["hlv", `인적자본(HLV) ${won(r.hlvS0)}`], ["keep", `유지 (${won(state.S0)})`]] as const).map(([k, t]) => (
            <li key={k} className="flex items-center gap-2"><input id={`fin-${k}`} type="radio" name="fin-amount" className="accent-sky" checked={amount === k} onChange={() => setAmount(k)} /><label htmlFor={`fin-${k}`}>{t}</label></li>
          ))}
        </ul>
        <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-sky" checked={usePreset} onChange={(e) => setUsePreset(e.target.checked)} /><span>추천 프리셋 적용 · <span className="font-medium">{PRESETS[r.presetId].label}</span> <span className="text-xs text-navy/60">{r.reason}</span></span></label>

        <div className="mt-5 flex justify-end gap-2"><Button onClick={() => dlg.current?.close()}>닫기</Button><Button primary onClick={apply}>적용</Button></div>
      </dialog>
    </>
  );
}
