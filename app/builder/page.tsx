"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ContractCard, ExpenseCard } from "@/components/builder/contract-card";
import { CoverageEditor, CoverageList } from "@/components/builder/coverage-card";
import { PlanGuide } from "@/components/builder/plan-guide";
import { PlanProvider, usePlan } from "@/components/builder/plan-provider";
import { BenefitChart, PlanEvidence, PlanReserveTable, PremiumCard, ReserveChart } from "@/components/builder/plan-result";
import { RatePasteBox, RateSheet } from "@/components/builder/rate-sheet";
import { Button } from "@/components/ui";

const TABS = ["조건", "산출"] as const;
type Tab = (typeof TABS)[number];

function Builder() {
  const { loaded, dispatch } = usePlan();
  const [tab, setTab] = useState<Tab>("산출");
  if (!loaded) return null;
  const col = (name: Tab, node: ReactNode) => <div className={`${tab === name ? "block" : "hidden"} space-y-4 lg:block`}>{node}</div>;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-navy">상품 만들기</h1>
          <p className="text-sm text-navy/60">위험률과 조건을 넣으면 산출방법서와 같은 순서로 보험료·책임준비금·해약환급금을 산출합니다.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/formulas" className="self-center text-sm text-sky hover:underline">산출 수식</Link>
          <Button onClick={() => { if (confirm("기본 예시(2대질병)로 되돌릴까요?")) dispatch({ type: "reset" }); }}>초기화</Button>
        </div>
      </div>
      <div className="mb-4 flex gap-2 lg:hidden">
        {TABS.map((t) => <Button key={t} primary={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</Button>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {col("조건", <><CoverageList /><ContractCard /><ExpenseCard /></>)}
        {col("산출", (
          <>
            <CoverageEditor />
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-4"><RateSheet /><RatePasteBox /></div>
              <div className="space-y-4"><PremiumCard /><BenefitChart /></div>
            </div>
            <ReserveChart />
            <PlanReserveTable />
            <PlanEvidence />
            <PlanGuide />
          </>
        ))}
      </div>
    </>
  );
}

export default function BuilderPage() {
  return <PlanProvider><Builder /></PlanProvider>;
}
