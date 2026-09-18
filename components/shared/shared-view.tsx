"use client";
import { ScheduleEditor } from "@/components/canvas/schedule-editor";
import { useDesign } from "@/components/design-provider";
import { PremiumSummary } from "@/components/result/premium-summary";
import { ResultChart } from "@/components/result/result-chart";
import { Button, Card } from "@/components/ui";
import { won } from "@/lib/format";
import { celebrations, assumptionOf, lowKind } from "@/lib/state";

/** 공유 링크로 열리는 읽기 전용 1열 뷰 */
export function SharedView({ onImport, app }: { onImport?: () => void; app: string }) {
  const { state, result } = useDesign();
  const p = state.profile, cels = celebrations(state.blocks);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card title="보험금 스케줄">
        <p className="mb-2 text-sm text-navy/70">{p.age}세 {p.sex === "M" ? "남" : "여"} · 기준보험금 {won(state.S0)} · {state.payYears}년납{state.lowSurrender ? ` · ${lowKind(assumptionOf(state).lowSurrender.ratio)}` : ""}</p>
        <ScheduleEditor height={280} amount readOnly />
        {cels.length > 0 && <p className="mt-2 text-xs text-navy/60">축하금: {cels.map((c) => `${c.fromAge}세 ${won(c.multiple * state.S0)}`).join(" · ")}</p>}
      </Card>
      <PremiumSummary />
      <ResultChart />
      <p className="text-xs text-navy/50">가정 {result.meta.assumptionId} ({result.meta.assumptionVersion}) · 앱 {app} · 이 화면은 읽기 전용입니다.</p>
      {onImport && <Button primary onClick={onImport}>내 설계로 가져오기</Button>}
    </div>
  );
}
