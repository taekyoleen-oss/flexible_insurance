"use client";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { usePlan } from "./plan-provider";
import { Button, Card, Input, NumInput, Select } from "@/components/ui";
import { parseRateFile, parseRateText, rateCsv, RATE_KINDS, RATE_PRESETS, type RateKind } from "@/lib/plan-rates";
import { CELL_ERROR_KO, colLetter, isFormula } from "@/lib/sheet-formula";
import { COLUMN_RECIPES, snippetsFor } from "@/lib/sheet-snippets";
import { COLUMN_ORIGIN_LABEL, columnOrigin } from "@/lib/plan-state";

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

const KIND_TONE: Record<RateKind, string> = {
  death: "bg-navy/10 text-navy",
  incidence: "bg-[#a34a1e]/10 text-[#a34a1e]",
  recurring: "bg-sky/15 text-sky",
  other: "bg-navy/5 text-navy/60",
};

/**
 * 위험률 스프레드시트. A열은 연령(읽기 전용), B열부터 사용자 열.
 * 칸에는 숫자나 `=수식`을 넣는다 — 수식은 Excel처럼 A1 참조를 쓰고, 고른 칸에 맞는 추천을 옆에 띄운다.
 */
export function RateSheetPanel() {
  const { state: s, dispatch, sheet: res, tab, main } = usePlan();
  const sh = tab.sheet;
  const isMain = tab.id === main.id;
  const [sel, setSel] = useState<{ col: number; row: number }>({ col: 0, row: 0 });
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState("");
  const [showTips, setShowTips] = useState(true);
  const file = useRef<HTMLInputElement>(null);

  const col = sh.columns[Math.min(sel.col, sh.columns.length - 1)];
  const row = Math.min(sel.row, sh.ages.length - 1);
  const raw = col?.cells[row] ?? "";
  useEffect(() => { setDraft(raw); }, [raw, col?.id, row]);

  const commit = (value: string) => { if (col) dispatch({ type: "cell", colId: col.id, row, value }); };
  const apply = (formula: string, fill?: boolean) => {
    commit(formula);
    if (fill && col) setTimeout(() => dispatch({ type: "fillDown", colId: col.id, row }), 0);
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.trim() || !text.includes("\n")) return;      // 한 칸 붙여넣기는 기본 동작에 맡긴다
    e.preventDefault();
    try {
      const t = parseRateText(text);
      dispatch({ type: "pasteTable", ages: t.ages, columns: t.columns });
      setMsg(`붙여넣기: ${t.ages.length}개 연령 × ${t.columns.length}개 열`);
    } catch (err) { setMsg(err instanceof Error ? err.message : "붙여넣기를 읽지 못했습니다."); }
  };

  const onFile = async (f: File) => {
    try {
      const t = await parseRateFile(f);
      dispatch({ type: "pasteTable", ages: t.ages, columns: t.columns });
      setMsg(`${f.name}: ${t.ages.length}개 연령 × ${t.columns.length}개 열`);
    } catch (err) { setMsg(err instanceof Error ? err.message : "파일을 읽지 못했습니다."); }
  };

  const err = col ? res.errors[row]?.[sel.col + 1] ?? null : null;
  const tips = col ? snippetsFor({ sheet: sh, col, colIdx: sh.columns.indexOf(col), row }) : [];

  return (
    <Card title={<span className="flex flex-wrap items-baseline gap-2">위험률 시트<span className="text-sm font-normal text-navy/50">A열 연령 · B열부터 위험률 · 칸에 숫자나 =수식</span></span>}>
      {/* 도구 모음 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-navy/60">연령</span>
        <div className="w-16"><NumInput value={sh.ages[0] ?? 0} min={0} max={120} onCommit={(v) => dispatch({ type: "ageRange", from: Math.round(v), to: sh.ages[sh.ages.length - 1] ?? 80 })} /></div>
        <span className="text-navy/60">~</span>
        <div className="w-16"><NumInput value={sh.ages[sh.ages.length - 1] ?? 0} min={0} max={120} onCommit={(v) => dispatch({ type: "ageRange", from: sh.ages[0] ?? 40, to: Math.round(v) })} /></div>
        <Select className="w-auto" value="" onChange={(e) => { if (e.target.value) { dispatch({ type: "addColumn", presetId: e.target.value }); setMsg(`열 추가: ${RATE_PRESETS.find((p) => p.id === e.target.value)?.label ?? ""}`); } }}>
          <option value="">＋ 열 추가 (기존 표)</option>
          {RATE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </Select>
        <Button onClick={() => file.current?.click()}>업로드</Button>
        <Button onClick={() => download(`위험률_${s.productName || "시트"}.csv`, rateCsv(sh, res))}>CSV</Button>
        <input ref={file} type="file" accept=".csv,.xlsx,.xls" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
      </div>
      <p className="mt-1 text-xs text-navy/55">표 안을 누르고 <b>Ctrl+V</b>로 Excel에서 여러 열을 한 번에 붙여넣을 수 있습니다 — 1열 연령, 2열부터 위험률(머리글 행은 열 이름으로 씁니다).</p>
      {msg && <p className="mt-1 text-xs text-sky">{msg}</p>}

      {/* 수식 입력줄 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded bg-navy/5 px-2 py-1 font-mono text-xs text-navy/70">{colLetter(sh.columns.indexOf(col) + 1)}{row + 1}</span>
        <Input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") { commit(draft); setSel({ col: sel.col, row: Math.min(row + 1, sh.ages.length - 1) }); } if (e.key === "Escape") setDraft(raw); }}
          placeholder="숫자 또는 =수식 (예: =B3*0.65)" className="min-w-[220px] flex-1" />
        <Button onClick={() => col && dispatch({ type: "fillDown", colId: col.id, row })} title="이 칸을 아래 끝까지 채웁니다 (상대 행 참조는 한 칸씩 밀립니다)">아래로 채우기</Button>
        <Button onClick={() => setShowTips((v) => !v)}>{showTips ? "추천 숨기기" : "수식 추천"}</Button>
      </div>
      {err && <p className="mt-1 text-xs text-[#a34a1e]">{err} — {CELL_ERROR_KO[err]}</p>}

      {showTips && (
        <div className="mt-2 rounded border border-navy/10 bg-cream/60 p-2">
          <p className="mb-1 text-xs font-medium text-navy/70">이 칸에 쓸 만한 수식</p>
          <div className="flex flex-wrap gap-1.5">
            {tips.map((t) => (
              <button key={t.id} type="button" title={`${t.formula}\n\n${t.why}`} onClick={() => apply(t.formula, t.fill)}
                className="rounded border border-navy/15 bg-white px-2 py-1 text-left text-[11px] text-navy/80 hover:border-sky hover:bg-sky/5">
                <span className="font-medium">{t.label}</span>
                <span className="ml-1 font-mono text-navy/45">{t.formula}</span>
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-navy/50">누르면 이 칸에 넣고 아래 끝까지 채웁니다. 상대 행 참조(<span className="font-mono">B2</span>)는 채울 때 한 칸씩 밀려 &quot;앞 값 이어받기&quot;가 됩니다. 쓸 수 있는 함수: IF · MIN · MAX · ABS · ROUND · SUM.</p>
        </div>
      )}

      {/* 열 머리 */}
      <div className="mt-3 overflow-auto" onPaste={onPaste}>
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-white">
            <tr>
              <th className="w-12 border border-navy/10 bg-cream px-1 py-1 text-left font-medium text-navy/50">A<div className="font-normal">연령</div></th>
              {sh.columns.map((c, i) => (
                <th key={c.id} className={`min-w-[130px] border border-navy/10 px-1 py-1 text-left align-top ${c.id === col?.id ? "bg-sky/10" : "bg-cream"}`}>
                  <div className="flex items-center gap-1">
                    <span className="font-mono text-[10px] text-navy/40">{colLetter(i + 1)}</span>
                    <input value={c.name} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { name: e.target.value } })}
                      className="w-full min-w-0 rounded border border-transparent bg-transparent px-1 text-xs font-medium text-navy hover:border-navy/20 focus:border-sky focus:bg-white focus:outline-none" />
                    <button type="button" onClick={() => dispatch({ type: "removeColumn", colId: c.id })} disabled={sh.columns.length <= 1}
                      className="shrink-0 px-1 text-navy/40 hover:text-[#a34a1e] disabled:opacity-30" title="열 삭제">×</button>
                  </div>
                  {!isMain && (() => { const o = columnOrigin(main, tab, c); return (
                    <div className={`mt-0.5 truncate text-[10px] ${o === "main-changed" ? "text-[#a34a1e]" : o === "own" ? "text-sky" : "text-navy/35"}`} title={COLUMN_ORIGIN_LABEL[o]}>{COLUMN_ORIGIN_LABEL[o]}</div>
                  ); })()}
                  <div className="mt-1 flex items-center gap-1">
                    <select value={c.kind} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { kind: e.target.value as RateKind } })}
                      title={RATE_KINDS.find((k) => k.kind === c.kind)?.hint}
                      className={`rounded px-1 py-0.5 text-[10px] font-medium ${KIND_TONE[c.kind]}`}>
                      {RATE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                    </select>
                    <label className="flex items-center gap-0.5 text-[10px] text-navy/60" title="이 열을 납입면제(납입자 집단 l′) 탈퇴율 f에 넣습니다">
                      <input type="checkbox" className="accent-sky" checked={c.waiver} onChange={(e) => dispatch({ type: "column", colId: c.id, patch: { waiver: e.target.checked } })} />
                      면제
                    </label>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sh.ages.map((age, r) => (
              <tr key={age}>
                <td className="border border-navy/10 bg-cream/60 px-1 py-0.5 font-mono text-[11px] text-navy/60">{age}</td>
                {sh.columns.map((c, i) => {
                  const cellErr = res.errors[r]?.[i + 1] ?? null;
                  const value = res.values[r]?.[i + 1] ?? 0;
                  const input = c.cells[r] ?? "";
                  const on = c.id === col?.id && r === row;
                  return (
                    <td key={c.id} onClick={() => setSel({ col: i, row: r })}
                      className={`cursor-cell border px-1 py-0.5 text-right font-mono text-[11px] ${on ? "border-sky bg-sky/10" : "border-navy/10"} ${cellErr ? "bg-[#a34a1e]/10 text-[#a34a1e]" : isFormula(input) ? "text-sky" : "text-navy/80"}`}
                      title={cellErr ? `${cellErr} — ${CELL_ERROR_KO[cellErr]}` : isFormula(input) ? `${input} → ${value}` : undefined}>
                      {cellErr ?? (Math.round(value * 1e10) / 1e10)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 새 열 레시피 */}
      <details className="mt-3">
        <summary className="cursor-pointer text-xs text-navy/60">수식으로 새 열 만들기</summary>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {COLUMN_RECIPES.map((rec) => (
            <button key={rec.id} type="button" title={rec.hint}
              onClick={() => { dispatch({ type: "addRecipeColumn", recipeId: rec.id }); setSel({ col: sh.columns.length, row: 0 }); setMsg(`"${rec.label}" 열을 추가했습니다 — 수식이 채워졌습니다. 칸을 눌러 고쳐 쓰세요.`); }}
              className="rounded border border-navy/15 bg-white px-2 py-1 text-left text-[11px] text-navy/80 hover:border-sky hover:bg-sky/5">
              {rec.label}
            </button>
          ))}
        </div>
      </details>
    </Card>
  );
}
