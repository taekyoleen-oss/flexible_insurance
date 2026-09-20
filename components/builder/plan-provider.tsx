"use client";
import { createContext, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from "react";
import type { PlanResult } from "@/lib/engine";
import type { ResolvedSheet } from "@/lib/plan-rates";
import {
  activeTab, evaluateProduct, initialPlan, planReducer, planSteps, PLAN_STORAGE_KEY, sanitizePlan, tabConditions,
  type PlanAction, type PlanState, type PlanStepCard, type PlanTab, type ProductResult, type TabConditions,
} from "@/lib/plan-state";

export interface PlanCtx {
  state: PlanState;
  dispatch: Dispatch<PlanAction>;
  product: ProductResult;     // 전 탭 합계
  tab: PlanTab;               // 보고 있는 탭
  main: PlanTab;              // 주계약 탭
  cond: TabConditions;        // 이 탭에 실제 적용되는 조건(상속 반영)
  result: PlanResult;         // 이 탭 산출
  sheet: ResolvedSheet;       // 이 탭 시트 평가
  steps: PlanStepCard[];
  loaded: boolean;
}

const Ctx = createContext<PlanCtx | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(planReducer, undefined, initialPlan);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY) ?? localStorage.getItem("fwl:plan:v2");
      if (raw) dispatch({ type: "load", state: sanitizePlan(JSON.parse(raw)) });
    } catch { /* 저장값이 깨졌으면 기본 예시로 시작 */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(state)); } catch { /* 저장 불가 환경은 무시 */ }
  }, [state, loaded]);

  const value = useMemo<PlanCtx>(() => {
    const product = evaluateProduct(state);
    const tab = activeTab(state);
    const cur = product.tabs.find((t) => t.tab.id === tab.id) ?? product.tabs[0];
    return {
      state, dispatch, product, tab, main: state.tabs[0], cond: tabConditions(state, tab),
      result: cur.result, sheet: cur.sheet, steps: planSteps(state, product), loaded,
    };
  }, [state, loaded]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlan(): PlanCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlan must be used inside PlanProvider");
  return c;
}
