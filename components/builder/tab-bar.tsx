"use client";
import { useState } from "react";
import { usePlan } from "./plan-provider";
import { Button } from "@/components/ui";
import { won } from "@/lib/format";
import { COLUMN_ORIGIN_LABEL, columnOrigin, overriddenKeys, TAB_COND_LABEL } from "@/lib/plan-state";

/**
 * 시트 탭. 첫 장이 주계약이고 나머지는 특약이다.
 * 특약은 주계약 조건을 기본값으로 물려받고, 다르게 둔 조건만 뱃지로 표시한다.
 */
export function TabBar() {
  const { state: s, dispatch, product, tab, main } = usePlan();
  const [editing, setEditing] = useState<string | null>(null);
  const isMain = tab.id === main.id;
  const ov = overriddenKeys(tab);
  const changedCols = tab.sheet.columns.filter((c) => columnOrigin(main, tab, c) === "main-changed");
  const ownCols = isMain ? [] : tab.sheet.columns.filter((c) => columnOrigin(main, tab, c) === "own");

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-end gap-1 border-b border-navy/15">
        {s.tabs.map((t, i) => {
          const on = t.id === tab.id;
          const r = product.tabs.find((x) => x.tab.id === t.id)?.result;
          const diff = i > 0 ? overriddenKeys(t).length : 0;
          return (
            <div key={t.id} className={`-mb-px flex items-center gap-1 rounded-t border border-b-0 px-2 py-1.5 ${on ? "border-navy/15 bg-white" : "border-transparent bg-navy/5 hover:bg-navy/10"}`}>
              {editing === t.id ? (
                <input autoFocus value={t.name} onChange={(e) => dispatch({ type: "renameTab", id: t.id, name: e.target.value })}
                  onBlur={() => setEditing(null)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") setEditing(null); }}
                  className="w-24 rounded border border-sky px-1 text-sm focus:outline-none" />
              ) : (
                <button type="button" onClick={() => (on ? setEditing(t.id) : dispatch({ type: "selectTab", id: t.id }))}
                  title={on ? "한 번 더 누르면 이름을 고칩니다" : "이 탭 보기"}
                  className={`text-sm ${on ? "font-semibold text-navy" : "text-navy/60"}`}>
                  {i === 0 && <span className="mr-1 rounded bg-sky/15 px-1 text-[10px] font-medium text-sky">주</span>}
                  {t.name}
                </button>
              )}
              <span className="font-mono text-[10px] text-navy/40">{won(r?.effective.monthlyGross ?? 0)}</span>
              {diff > 0 && <span className="rounded bg-[#fef3c7] px-1 text-[10px] text-[#92400e]" title="주계약과 다른 조건이 있습니다">↯{diff}</span>}
              {i > 0 && on && <button type="button" onClick={() => { if (confirm(`"${t.name}" 탭을 지울까요?`)) dispatch({ type: "removeTab", id: t.id }); }} className="px-1 text-xs text-navy/40 hover:text-[#a34a1e]" title="탭 삭제">×</button>}
            </div>
          );
        })}
        <button type="button" onClick={() => dispatch({ type: "addTab" })} disabled={s.tabs.length >= 10}
          className="-mb-px rounded-t px-2 py-1.5 text-sm text-sky hover:bg-sky/5 disabled:opacity-40" title="주계약 시트를 복사해 특약 탭을 만듭니다">＋ 특약</button>
        <div className="flex-1" />
        {!isMain && (
          <div className="flex items-center gap-1 pb-1">
            <Button onClick={() => { if (confirm("주계약 시트를 그대로 복사해 이 탭 시트를 덮을까요?")) dispatch({ type: "copyMainSheet" }); }}>주계약 시트 복사</Button>
            <Button onClick={() => dispatch({ type: "moveTab", id: tab.id, dir: -1 })} title="앞으로">◀</Button>
            <Button onClick={() => dispatch({ type: "moveTab", id: tab.id, dir: 1 })} title="뒤로">▶</Button>
          </div>
        )}
      </div>

      {!isMain && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-navy/10 bg-cream/60 px-2 py-1.5 text-xs">
          <span className="text-navy/60">이 특약은 주계약 조건을 물려받습니다.</span>
          {ov.length === 0
            ? <span className="text-navy/45">다르게 둔 조건 없음</span>
            : ov.map((k) => (
                <span key={k} className="flex items-center gap-1 rounded bg-[#fef3c7] px-1.5 py-0.5 text-[#92400e]">
                  {TAB_COND_LABEL[k]} 다름
                  <button type="button" onClick={() => dispatch({ type: "resetOverride", key: k })} className="underline" title="주계약 값으로 되돌립니다">되돌리기</button>
                </span>
              ))}
          {changedCols.length > 0 && <span className="rounded bg-[#fef3c7] px-1.5 py-0.5 text-[#92400e]" title={changedCols.map((c) => c.name).join(", ")}>{COLUMN_ORIGIN_LABEL["main-changed"]} {changedCols.length}열</span>}
          {ownCols.length > 0 && <span className="rounded bg-sky/10 px-1.5 py-0.5 text-sky" title={ownCols.map((c) => c.name).join(", ")}>{COLUMN_ORIGIN_LABEL.own} {ownCols.length}열</span>}
        </div>
      )}
    </div>
  );
}
