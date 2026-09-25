import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { applySpecToPlan, planFromSpec, readSpecJson } from "@/lib/methoddoc-bridge";
import { emptySpec, type Evidence, type MethodSpec, type RateRef } from "@/lib/methoddoc/spec";
import { activeTab, evaluateProduct, PLAN_RECIPES, PLAN_STORAGE_KEY, sanitizePlan, type PlanState } from "@/lib/plan-state";

/**
 * 위험률 표 → (Studio 조건) → MethodSpec JSON → 이 앱의 계산.
 * Studio 의 샘플 위험률 표(samples/08_위험률표_종합_남녀.csv — 가상의 값)를 Studio 가 붙이는 모양(RateRef.tables {M,F} · table)으로 만들어
 * 계약정보 성별의 값이 시트 열에 그대로 들어가고 보험료가 나오는지, 검수로 고른 새 위험률이 시트 열로 더해지는지 본다.
 */
const CSV = new URL("../../../Life_ins_Doc_Convert_Studio/samples/08_위험률표_종합_남녀.csv", import.meta.url);

/** CSV → 열 이름 → {ages, values} */
function readCsv() {
  const rows = readFileSync(CSV, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(","));
  const head = rows[0], ages = rows.slice(1).map((r) => Number(r[0]));
  const col = (name: string) => { const i = head.indexOf(name); return { ages, values: rows.slice(1).map((r) => Number(r[i])) }; };
  return { head, ages, col };
}

/** Studio 가 attachTables 로 붙이는 모양 그대로 */
function studioSpec(): MethodSpec {
  const { col } = readCsv();
  const q: RateRef = { id: "q", name: "제7회 경험생명표 사망률", role: "death", tables: { M: col("사망률(남)"), F: col("사망률(여)") }, table: { ...col("사망률(남)"), sex: "M" } };
  const r2: RateRef = { id: "r2", name: "2대질병 발생률", role: "incidence", table: col("2대질병 발생률") };
  const rc: RateRef = { id: "rc", name: "암발생률", role: "incidence", tables: { M: col("암발생률(남)"), F: col("암발생률(여)") }, table: { ...col("암발생률(남)"), sex: "M" } };
  return {
    ...emptySpec("2대질병 진단보험"),
    basis: { interest: 0.025, standardInterest: 0.0325, waiver: false },
    rates: [q, r2, rc],
    expenses: [
      { group: "계약체결비용", symbol: "α_S", basis: "보험가입금액", rate: 0.01, phase: "초년도" }, { group: "계약체결비용", symbol: "α_P", basis: "기준연납순보험료", times: 1, phase: "초년도" },
      { group: "계약관리비용", symbol: "β_S", basis: "매년 보험가입금액", rate: 0.0015, phase: "납입중" }, { group: "계약관리비용", symbol: "β_G", basis: "영업보험료", rate: 0.045, phase: "납입중" },
      { group: "계약관리비용", symbol: "β′", basis: "매년 보험가입금액", rate: 0.001, phase: "납입후" }, { group: "수금비용", symbol: "γ", basis: "영업보험료", rate: 0.025 },
    ],
    benefits: [{ id: "b1", name: "2대질병 진단", role: "incidence", trigger: "진단 확정 시", amount: 3e7, endAge: 80, rateId: "r2", exitRateIds: ["q", "r2"] }],
  };
}

const store = new Map<string, string>();
beforeEach(() => store.clear());
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(),
} });
const load = () => sanitizePlan(JSON.parse(store.get(PLAN_STORAGE_KEY)!));
const seed = (s: PlanState) => store.set(PLAN_STORAGE_KEY, JSON.stringify(s));

describe.runIf(existsSync(CSV))("Studio 위험률 표 → MethodSpec → 이 앱의 계산", () => {
  it("JSON 열기: 계약정보 성별(기본 남)의 값이 시트 열에 그대로, 보험료가 나온다 · 여자로 바꾸면 여자 표", () => {
    const spec = readSpecJson(JSON.stringify(studioSpec()));
    const { state, warnings } = planFromSpec(spec);
    expect(warnings).toEqual([]);
    const tab = activeTab(state), at = (a: number) => tab.sheet.ages.indexOf(a);
    expect(tab.sheet.columns.map((c) => [c.name, c.kind])).toEqual([["제7회 경험생명표 사망률", "death"], ["2대질병 발생률", "incidence"], ["암발생률", "incidence"]]);
    expect([tab.sheet.columns[0].cells[at(40)], tab.sheet.columns[1].cells[at(40)], tab.sheet.columns[2].cells[at(80)]]).toEqual(["0.00086", "0.0016", "0.031245"]);
    expect(tab.coverages[0].exitColIds).toEqual([tab.sheet.columns[0].id, tab.sheet.columns[1].id]);
    const p = evaluateProduct(state);
    expect(p.effective.monthlyGross).toBeGreaterThan(0);
    // 여자 계약정보 — Studio 가 두 벌(tables) 다 실었으므로 여자 표가 들어간다
    const f = planFromSpec({ ...spec, contract: { sex: "F" } }).state;
    expect(activeTab(f).sheet.columns[0].cells[at(40)]).toBe("0.00051");
    expect(evaluateProduct(f).effective.monthlyGross).not.toBeCloseTo(p.effective.monthlyGross, 6);
  });

  it("검수로 고른 위험률(시트에 없는 이름)은 시트 열로 더해진다 — 표가 있으면 그 값, 있는 열은 그대로", () => {
    seed(PLAN_RECIPES.find((r) => r.id === "whole")!.build("M", 40));
    const before = activeTab(load()).sheet.columns.map((c) => c.name);
    const spec = studioSpec();
    const ev = (i: number): Evidence => ({ path: `rates[${i}]`, label: "위험률", value: spec.rates[i].name, raw: "", source: "표 1", confidence: "high" });
    expect(applySpecToPlan(spec, [ev(0), ev(1), ev(2)])).toBe(2);       // 사망률은 같은 이름의 열이 있어 건드리지 않는다
    const tab = activeTab(load());
    expect(tab.sheet.columns.map((c) => c.name)).toEqual([...before, "2대질병 발생률", "암발생률"]);
    expect(tab.sheet.columns.at(-1)!.cells[tab.sheet.ages.indexOf(40)]).toBe("0.0019");
    expect(evaluateProduct(load()).effective.monthlyGross).toBeGreaterThan(0);
    // 표 없는 위험률은 0 으로 — 값을 붙여넣으라는 뜻
    const bare: MethodSpec = { ...spec, rates: [{ id: "z", name: "치매 발생률", role: "incidence" }] };
    expect(applySpecToPlan(bare, [{ ...ev(0), path: "rates[0]", value: "치매 발생률" }])).toBe(1);
    expect(activeTab(load()).sheet.columns.at(-1)!.cells.every((c) => c === "0")).toBe(true);
  });
});
