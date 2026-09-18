"use client";
import { useState } from "react";
import { CompareTable } from "@/components/compare/compare-table";
import { ScheduleEditor } from "@/components/canvas/schedule-editor";
import { useDesign } from "@/components/design-provider";
import { ResultChart } from "@/components/result/result-chart";
import { Button } from "@/components/ui";
import { manwon, pct, won } from "@/lib/format";
import { celebrations, effective, lowKind, PRODUCT_LABEL } from "@/lib/state";
import { riderPremiums, riderTotal } from "@/lib/riders";

const YEARS = [1, 2, 3, 5, 10, 15, 20, 30];
const Row = ({ k, v }: { k: string; v: string }) => <><dt className="text-navy/60">{k}</dt><dd className="text-right font-mono">{v}</dd></>;

export default function PrintPage() {
  const { state, result: r, violations, loaded } = useDesign();
  const [withAgent, setWithAgent] = useState(true);
  if (!loaded) return null;
  const p = state.profile, eff = effective(r, state.payYears), a = state.settings.assumption, cels = celebrations(state.blocks);
  const riderRows = riderPremiums(state).filter((x) => x.on);
  const today = new Date().toLocaleDateString("ko-KR");
  const loading: [string, number][] = [["신계약비 α", r.loading.alpha], ["유지비 정액 β_S", r.loading.betaS], ["납입 후 유지비 β′", r.loading.betaPrime], ["유지비율 β_G", r.loading.betaG], ["수금비 γ", r.loading.gamma]];
  return (
    <div className="mx-auto max-w-[190mm] text-[13px] text-ink">
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <Button primary onClick={() => window.print()}>인쇄 / PDF 저장</Button>
        <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} />설계사용 3쪽 포함</label>
        <span className="text-xs text-navy/50">브라우저 인쇄 대화상자에서 &quot;PDF로 저장&quot;을 고르세요.</span>
      </div>

      <section className="print-page space-y-3">
        <h1 className="font-display text-2xl text-navy">{PRODUCT_LABEL[p.product]} 제안서</h1>
        <p className="text-navy/70">{today} · 피보험자 {p.age}세 {p.sex === "M" ? "남" : "여"} · 기준보험금 {won(state.S0)} · {state.payYears}년납 월납{state.waiver ? " · 납입면제" : ""}{eff.isLow ? ` · ${lowKind(eff.ratio)}` : ""}</p>
        <ScheduleEditor height={300} amount readOnly />
        {cels.length > 0 && <p className="text-xs text-navy/60">축하금: {cels.map((c) => `${c.fromAge}세 ${won(c.multiple * state.S0)}`).join(" · ")}</p>}
        <dl className="grid grid-cols-[1fr_auto] gap-y-1">
          <Row k="월 보험료" v={won(eff.monthly)} />
          {riderRows.map((x) => <Row key={x.id} k={`${x.label} · ${won(x.amount)}${x.kind === "daily" ? "/일" : ""}`} v={won(x.monthly)} />)}
          {riderRows.length > 0 && <Row k={`최종 합계 (주계약 + 특약 ${riderRows.length}건)`} v={won(eff.monthly + riderTotal(riderRows))} />}
          <Row k="총 납입보험료" v={won(eff.totalPaid)} />
          <Row k="초기 보험금 / 최대 보험금" v={`${won(r.S[0] * state.S0)} / ${won(Math.max(...r.S) * state.S0)}`} />
          <Row k={`납입 완료(${state.payYears}년) 환급률`} v={pct(eff.rate[state.payYears])} />
          {eff.isLow && <Row k={`${lowKind(eff.ratio)} 조건`} v={`납입기간 중 환급금 ${Math.round(eff.ratio * 100)}% · 적용해지율 ${pct(eff.lapseRate)} → 보험료 −${pct(eff.premiumDiscount)}`} />}
        </dl>
      </section>

      <section className="print-page space-y-3">
        <h2 className="font-display text-xl text-navy">책임준비금·보험료 누계와 해약환급금</h2>
        <ResultChart width={680} />
        <table className="w-full text-xs"><thead><tr className="text-navy/60"><th className="text-left">경과</th><th className="text-right">납입 누계</th><th className="text-right">해약환급금</th><th className="text-right">환급률</th></tr></thead>
          <tbody>{YEARS.filter((t) => t <= r.n).map((t) => <tr key={t} className="border-t border-navy/10 font-mono"><td>{t}년</td><td className="text-right">{won(eff.paid[t])}</td><td className="text-right">{won(eff.cash[t])}</td><td className="text-right">{pct(eff.rate[t])}</td></tr>)}</tbody></table>
        <CompareTable chartWidth={680} />
        <p className="text-xs text-navy/60">가정: {a.label} · 예정이율 {pct(a.interest, 2)} · 표준이율 {pct(a.standardInterest, 2)} · 위험률 {p.product === "cancer" ? "암발생률(생명장기제2024-112호)" : "제7회 경험생명표"}{eff.isLow ? ` · 적용해지율 ${pct(eff.lapseRate)}(납입기간 중)` : ""} · 이 제안서는 설계 참고용이며 실제 계약 조건은 약관에 따릅니다.</p>
      </section>

      {withAgent && (
        <section className="print-page space-y-3">
          <h2 className="font-display text-xl text-navy">설계사용 · 산출 근거</h2>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1">
            <Row k="입력" v={`${p.age}세 ${p.sex} · 자녀 ${p.childrenAges.join(",") || "없음"} · 연소득 ${manwon(p.income)} · 부채 ${manwon(p.debt)} · 기존 보장 ${manwon(p.groupCover + p.termCover)}`} />
            <Row k="가정 세트" v={`${a.id} (${a.version})`} />
            <Row k="설계 제약" v={violations.length ? violations.map((v) => v.code).join(", ") + " 위반" : "E01~E08 통과"} />
            <Row k="10만원당 순 / 기준연납 / 영업" v={`${r.per100k.net} / ${r.per100k.base} / ${r.per100k.gross}원`} />
            <Row k="신계약비 (산출 / 표준 / 해약공제 기준)" v={`${r.per100k.alpha} / ${r.per100k.alphaStd} / ${r.per100k.newBiz}원`} />
            {loading.map(([k, v]) => <Row key={k} k={`부가보험료 ${k}`} v={won(v)} />)}
          </dl>
          <p className="text-xs text-navy/60">변경점 {state.anchors.join(", ") || "없음"} · 프리셋 {state.presetId} · 저장 시각 {state.updatedAt ? new Date(state.updatedAt).toLocaleString("ko-KR") : "-"}</p>
        </section>
      )}
    </div>
  );
}
