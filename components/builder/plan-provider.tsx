"use client";
import { createContext, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from "react";
import type { PlanResult } from "@/lib/engine";
import type { ResolvedSheet } from "@/lib/plan-rates";
import { evaluatePlan, initialPlan, planReducer, planSteps, PLAN_STORAGE_KEY, sanitizePlan, type PlanAction, type PlanState, type PlanStepCard } from "@/lib/plan-state";

export interface PlanCtx {
  state: PlanState;
  dispatch: Dispatch<PlanAction>;
  result: PlanResult;
  sheet: ResolvedSheet;      // 시트 평가 결과(값·오류)
  steps: PlanStepCard[];
  loaded: boolean;
}

const Ctx = createContext<PlanCtx | null>(null);

export function PlanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(planReducer, undefined, initialPlan);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PLAN_STORAGE_KEY);
      if (raw) dispatch({ type: "load", state: sanitizePlan(JSON.parse(raw)) });
    } catch { /* 저장값이 깨졌으면 기본 예시로 시작 */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(state)); } catch { /* 저장 불가 환경은 무시 */ }
  }, [state, loaded]);

  const value = useMemo<PlanCtx>(() => {
    const { result, sheet } = evaluatePlan(state);
    return { state, dispatch, result, sheet, steps: planSteps(state, result, sheet), loaded };
  }, [state, loaded]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlan(): PlanCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlan must be used inside PlanProvider");
  return c;
}
