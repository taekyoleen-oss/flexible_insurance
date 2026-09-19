"use client";
import { createContext, useContext, useEffect, useMemo, useReducer, useState, type Dispatch, type ReactNode } from "react";
import type { PlanResult } from "@/lib/engine";
import { evaluatePlan, initialPlan, planReducer, PLAN_STORAGE_KEY, sanitizePlan, selectedCoverage, type PlanAction, type PlanCoverageState, type PlanState } from "@/lib/plan-state";

export interface PlanCtx {
  state: PlanState;
  dispatch: Dispatch<PlanAction>;
  result: PlanResult;
  current: PlanCoverageState;
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

  const value = useMemo<PlanCtx>(() => ({
    state, dispatch, result: evaluatePlan(state), current: selectedCoverage(state)!, loaded,
  }), [state, loaded]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlan(): PlanCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlan must be used inside PlanProvider");
  return c;
}
