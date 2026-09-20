"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { PlanGuide } from "@/components/builder/plan-guide";
import { PlanProvider, usePlan } from "@/components/builder/plan-provider";
import { BenefitChart, PlanEvidence, PlanReserveTable, PremiumCard, ReserveChart } from "@/components/builder/plan-result";
import { RateSheetPanel } from "@/components/builder/rate-sheet";
import { TabBar } from "@/components/builder/tab-bar";
import { StepList } from "@/components/builder/steps";
import { Button } from "@/components/ui";
import { won } from "@/lib/format";

const TABS = ["위험률 시트", "조건"] as const;
type Tab = (typeof TABS)[number];

function Builder() {
  const { state: s, dispatch, product, loaded } = usePlan();
  const [tab, setTab] = useState<Tab>("위험률 시트");
  if (!loaded) return null;
  const col = (name: Tab, node: ReactNode) => <div className={`${tab === name ? "block" : "hidden"} space-y-4 lg:block`}>{node}</div>;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-navy">상품 만들기 <span className="text-base font-normal text-navy/50">{s.productName}</span></h1>
          <p className="text-sm text-navy/60">왼쪽 시트에 위험률을 넣고 오른쪽에서 단계별로 조건을 정하면 산출방법서와 같은 순서로 보험료·책임준비금·해약환급금이 나옵니다.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg text-navy">{won(product.effective.monthlyGross)}</span>
          <Link href="/builder/doc" className="rounded bg-sky px-3 py-1.5 text-sm font-medium text-white hover:bg-sky/90">산출식 문서</Link>
          <Button onClick={() => { if (confirm("기본 예시(2대질병)로 되돌릴까요?")) dispatch({ type: "reset" }); }}>초기화</Button>
        </div>
      </div>
      <div className="mb-3 flex gap-2 lg:hidden">
        {TABS.map((t) => <Button key={t} primary={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</Button>)}
      </div>
      <TabBar />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_430px]">
        {col("위험률 시트", <RateSheetPanel />)}
        {col("조건", <StepList />)}
      </div>
      <div className="mt-4 space-y-4">
        <div className="grid gap-4 xl:grid-cols-2">
          <PremiumCard />
          <BenefitChart />
        </div>
        <ReserveChart />
        <PlanReserveTable />
        <PlanEvidence />
        <PlanGuide />
      </div>
    </>
  );
}

export default function BuilderPage() {
  return <PlanProvider><Builder /></PlanProvider>;
}
