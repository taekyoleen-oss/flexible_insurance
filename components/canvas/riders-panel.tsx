"use client";
import { useDesign } from "@/components/design-provider";
import { FormulaHelp } from "@/components/formula-help";
import { Card, MillionInput, ThousandInput } from "@/components/ui";
import { won } from "@/lib/format";
import { RIDER_RATE_NOTE, riderPremiums, riderTotal } from "@/lib/riders";
import { effective, PRODUCT_LABEL } from "@/lib/state";

/** 특약: 체크로 부가하고 보장금액을 바꾸면 옆에 월 보험료가 바로 바뀐다. 보험기간·납입기간은 주계약을 따른다 */
export function RidersPanel() {
  const { state, dispatch, result } = useDesign();
  const rows = riderPremiums(state);
  const main = effective(result, state.payYears).monthly;
  const extra = riderTotal(rows);
  return (
    <Card title={<>특약 <FormulaHelp id="riders" /></>}>
      <p className="mb-2 text-xs text-navy/60">주계약({PRODUCT_LABEL[state.profile.product]})에 붙는 정액 특약입니다. 보험기간은 100세 만기({state.profile.age}세 가입 → {rows[0]?.termYears}년), 납입기간은 주계약과 같으며({rows[0]?.payYears}년납), 보장금액을 바꾸면 보험료가 바로 계산됩니다.</p>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={r.id} className={`grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 rounded border px-2 py-1.5 text-sm ${r.on ? "border-sky/40 bg-sky/5" : "border-navy/10"}`}>
            <input type="checkbox" className="accent-sky" checked={r.on} aria-label={`${r.label} 부가`} onChange={(e) => dispatch({ type: "rider", id: r.id, patch: { on: e.target.checked } })} />
            <div className="min-w-0">
              <div className="font-medium text-navy">{r.label} <span className="text-xs font-normal text-navy/50">{r.unitLabel}</span></div>
              <div className="mt-1 flex items-center gap-1">
                {r.kind === "daily"
                  ? <ThousandInput value={r.amount} onChange={(v) => dispatch({ type: "rider", id: r.id, patch: { amount: v } })} min={10} max={1000} ariaLabel={`${r.label} 1일당 금액`} />
                  : <MillionInput value={r.amount} onChange={(v) => dispatch({ type: "rider", id: r.id, patch: { amount: v } })} min={1} max={500} ariaLabel={`${r.label} 보장금액`} />}
              </div>
              <div className="mt-0.5 text-[10px] text-navy/40" title={RIDER_RATE_NOTE[r.id]}>위험률: {RIDER_RATE_NOTE[r.id]}</div>
            </div>
            <div className="text-right font-mono text-navy">{won(r.monthly)}<div className="text-[10px] font-sans text-navy/50">월</div></div>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1 border-t border-navy/10 pt-2 text-sm">
        <dt className="text-navy/60">주계약 월 보험료</dt><dd className="font-mono">{won(main)}</dd>
        <dt className="text-navy/60">특약 합계 ({rows.filter((r) => r.on).length}건)</dt><dd className="font-mono">{won(extra)}</dd>
        <dt className="font-medium text-navy">최종 합계</dt><dd className="font-mono font-medium text-navy">{won(main + extra)}</dd>
      </dl>
      <p className="mt-2 text-[11px] text-navy/50">암발생률(2024-112호)과 암입원율은 제공받은 값입니다. &quot;(임시)&quot; 위험률은 회사 요율이 없어 사망률·암발생률에 계수를 곱한 값이며 회사 위험률로 교체하면 보험료가 바뀝니다.</p>
    </Card>
  );
}
