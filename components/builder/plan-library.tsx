"use client";
import { useEffect, useState } from "react";
import { usePlan } from "./plan-provider";
import { Button, Card, Input } from "@/components/ui";
import { won } from "@/lib/format";
import { sanitizePlan, type PlanState } from "@/lib/plan-state";
import { downloadText, makeSlotStore, type Slot } from "@/lib/slots";

/** 일반 상품 보관함. 현재 작업본(fwl:plan:v3)과 따로, 이름 붙인 사본을 여러 건 둔다 */
export const PLAN_LIBRARY_KEY = "fwl:plans:v1";
export const planStore = makeSlotStore<PlanState>(PLAN_LIBRARY_KEY, (raw) => sanitizePlan(raw), 50);

const stamp = (t: number) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const autoName = (s: PlanState) => `${s.productName || "상품"} · ${s.age}세 ${s.sex === "M" ? "남" : "여"} · ${s.tabs.length}탭`;

export function PlanLibrary() {
  const { state, dispatch, product } = usePlan();
  const [list, setList] = useState<Slot<PlanState>[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => { setList(planStore.load()); }, []);
  useEffect(() => { setName(autoName(state)); }, [state.productName, state.age, state.sex, state.tabs.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const guard = (f: () => void) => { try { f(); setMsg(""); } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); } };
  const save = () => guard(() => { setList(planStore.put(name, state)); setMsg(`"${name}" 저장`); });
  const open = (s: Slot<PlanState>) => {
    if (state.updatedAt > 0 && !confirm(`"${s.name}" 을 불러옵니다. 지금 작업 중인 내용은 사라집니다(먼저 저장하세요).`)) return;
    dispatch({ type: "load", state: s.data });
    setMsg(`"${s.name}" 불러옴`);
  };

  const importFile = async (f: File) => {
    try {
      const raw = JSON.parse(await f.text()) as { name?: string; state?: unknown; data?: unknown };
      const data = sanitizePlan(raw.state ?? raw.data ?? raw);
      const nm = typeof raw.name === "string" ? raw.name : f.name.replace(/\.json$/i, "");
      setList(planStore.put(nm, data));
      setMsg(`"${nm}" 가져옴`);
    } catch (e) { setMsg(`가져오지 못했습니다: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const kb = Math.round(planStore.bytes() / 1024);

  return (
    <Card title={<span>보관함 <span className="text-sm font-normal text-navy/50">{list.length}/{planStore.max}건 · {kb}KB</span></span>}>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="min-w-[220px] flex-1 font-sans" placeholder="저장할 이름" />
        <Button primary onClick={save}>현재 설계 저장</Button>
        <Button onClick={() => downloadText(`${(state.productName || "상품").replace(/[^\w가-힣]+/g, "_")}.plan.json`, JSON.stringify({ name, state }, null, 2))}>JSON 내보내기</Button>
        <label className="cursor-pointer rounded border border-navy/20 px-3 py-1.5 text-sm text-navy hover:bg-navy/5">
          JSON 가져오기
          <input type="file" accept=".json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ""; }} />
        </label>
      </div>
      {msg && <p className="mt-1 text-xs text-sky">{msg}</p>}
      <p className="mt-1 text-xs text-navy/50">
        같은 이름으로 저장하면 덮어씁니다. 보관함은 이 브라우저에만 남습니다 — 다른 기기로 옮기려면 JSON 으로 내보내세요.
      </p>

      {list.length === 0 ? (
        <p className="mt-3 text-sm text-navy/50">저장된 설계가 없습니다.</p>
      ) : (
        <ul className="mt-3 divide-y divide-navy/10">
          {list.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-1.5 text-sm">
              {renaming === s.id ? (
                <Input autoFocus defaultValue={s.name} className="w-56 font-sans"
                  onBlur={(e) => { setList(planStore.rename(s.id, e.target.value)); setRenaming(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }} />
              ) : (
                <button type="button" onClick={() => open(s)} className="flex-1 truncate text-left text-navy hover:text-sky" title="이 설계를 불러옵니다">
                  {s.name}
                </button>
              )}
              <span className="font-mono text-xs text-navy/45">{s.data.tabs.length}탭 · {stamp(s.savedAt)}</span>
              <Button onClick={() => setRenaming(s.id)}>이름</Button>
              <Button onClick={() => { if (confirm(`"${s.name}" 을 보관함에서 지울까요?`)) setList(planStore.remove(s.id)); }}>삭제</Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-navy/50">지금 작업본: {state.productName || "이름 없음"} · {state.tabs.length}탭 · {won(product.effective.monthlyGross)}</p>
    </Card>
  );
}
