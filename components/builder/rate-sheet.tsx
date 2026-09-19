"use client";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { usePlan } from "./plan-provider";
import { Button, Card, Field, NumInput } from "@/components/ui";
import { kindMeta } from "@/lib/plan-state";
import { parseRateFile, parseRateText, rateCoverage, rateCsv, type RateGrid } from "@/lib/plan-rates";

/** 한 칸. 타이핑 중에는 문자열을 그대로 두고 blur/Enter에 숫자로 확정한다 */
function Cell({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text.replace(/[,\s]/g, ""));
    if (text.trim() !== "" && Number.isFinite(n) && n !== value) onCommit(n);
    else setText(String(value));
  };
  return (
    <input value={text} inputMode="decimal" onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-right font-mono text-xs hover:border-navy/20 focus:border-sky focus:bg-white focus:outline-none" />
  );
}

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
};

/** 위험률 시트: 셀 직접 입력 · Excel 붙여넣기 · CSV/XLSX 업로드 · 기존 표 불러오기 */
export function RateSheet() {
  const { state: s, dispatch, current: c, result } = usePlan();
  const [msg, setMsg] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const g = c.grid;
  const meta = kindMeta(c.kind);
  const eventLabel = c.kind === "daily" ? "연간 기대 지급일수" : "급부 발생률";
  const row = result.coverages.find((r) => r.id === c.id);
  const cover = rateCoverage(g, s.age, Math.min(c.endAge, s.age + (row?.n ?? 1) - 1));

  const setGrid = (grid: RateGrid, note = "") => { dispatch({ type: "coverage", id: c.id, patch: { grid, presetId: "custom" } }); setMsg(note); };
  const setCell = (i: number, col: "event" | "exit", v: number) =>
    setGrid({ ...g, [col]: g[col].map((x, j) => (j === i ? v : x)) });

  const setRange = (from: number, to: number) => {
    const lo = Math.max(0, Math.min(from, to)), hi = Math.min(120, Math.max(from, to));
    const find = (a: number) => g.ages.indexOf(a);
    const ages: number[] = [], event: number[] = [], exit: number[] = [];
    for (let a = lo; a <= hi; a++) { const i = find(a); ages.push(a); event.push(i >= 0 ? g.event[i] : 0); exit.push(i >= 0 ? g.exit[i] : 0); }
    setGrid({ ages, event, exit });
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text.trim()) return;
    e.preventDefault();
    try {
      const grid = parseRateText(text);
      setGrid(grid, `붙여넣기: ${grid.ages.length}개 연령을 읽었습니다.`);
    } catch (err) { setMsg(err instanceof Error ? err.message : "붙여넣기를 읽지 못했습니다."); }
  };

  const onFile = async (f: File) => {
    try {
      const grid = await parseRateFile(f);
      setGrid(grid, `${f.name}: ${grid.ages.length}개 연령을 읽었습니다.`);
    } catch (err) { setMsg(err instanceof Error ? err.message : "파일을 읽지 못했습니다."); }
  };

  return (
    <Card title={<span>위험률 시트 <span className="text-sm font-normal text-navy/50">{c.label} · {meta.label}</span></span>}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="연령 범위">
          <div className="flex items-center gap-1">
            <NumInput value={g.ages[0] ?? s.age} min={0} max={120} className="w-20" onCommit={(v) => setRange(Math.round(v), g.ages[g.ages.length - 1] ?? c.endAge)} />
            <span className="text-sm text-navy/60">~</span>
            <NumInput value={g.ages[g.ages.length - 1] ?? c.endAge} min={0} max={120} className="w-20" onCommit={(v) => setRange(g.ages[0] ?? s.age, Math.round(v))} />
          </div>
        </Field>
        <div className="flex flex-wrap gap-2 pb-1">
          <Button onClick={() => file.current?.click()}>CSV·Excel 업로드</Button>
          <Button onClick={() => download(`위험률_${c.label}.csv`, rateCsv(g))}>CSV 내려받기</Button>
          <input ref={file} type="file" accept=".csv,.xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
        </div>
      </div>
      <p className="mt-2 text-xs text-navy/60">
        표 안을 누르고 <b>Ctrl+V</b>로 Excel에서 그대로 붙여넣을 수 있습니다 — 1열 연령, 2열 {eventLabel}, 3열(선택) 탈퇴율.
        담보 조건의 &quot;위험률 출처&quot;에서 기존 표를 불러온 뒤 고쳐 써도 됩니다.
      </p>
      {msg && <p className="mt-1 text-xs text-sky">{msg}</p>}
      {!cover.ok && (
        <p className="mt-1 text-xs text-[#a34a1e]">
          표가 {cover.min}~{cover.max}세만 덮습니다. 가입나이 {s.age}세 ~ 만기 {c.endAge}세 밖의 나이는 가장 가까운 연령 값을 이어 씁니다.
        </p>
      )}

      <div onPaste={onPaste} tabIndex={0} className="mt-3 max-h-96 overflow-auto rounded border border-navy/10 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-cream text-navy/60">
            <tr>
              <th className="px-2 py-1 text-left font-medium">연령</th>
              <th className="px-2 py-1 text-right font-medium">{eventLabel}</th>
              <th className="px-2 py-1 text-right font-medium">탈퇴율</th>
            </tr>
          </thead>
          <tbody>
            {g.ages.map((a, i) => (
              <tr key={a} className="border-t border-navy/5">
                <td className="px-2 py-0.5 font-mono text-navy/70">{a}</td>
                <td className="px-1 py-0.5">{c.kind === "survival" ? <span className="block text-right text-navy/30">—</span> : <Cell value={g.event[i] ?? 0} onCommit={(v) => setCell(i, "event", v)} />}</td>
                <td className="px-1 py-0.5"><Cell value={g.exit[i] ?? 0} onCommit={(v) => setCell(i, "exit", v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-navy/50">
        탈퇴율 = 그 담보가 없어지는 사유 전부. {meta.label}은 {c.kind === "incidence" ? "사망률 + 발생률" : c.kind === "death" ? "사망률(= 발생률)" : c.kind === "daily" ? "사망률만(입원은 반복 지급이라 소멸하지 않음)" : "사망률"}입니다.
        {c.kind === "survival" && " 생존형은 발생률을 쓰지 않고 지급 시점으로 정합니다."}
      </p>
      <p className="mt-1 text-xs text-navy/50">표를 고치거나 붙여넣으면 위험률 출처가 &quot;직접 입력&quot;으로 바뀝니다. 담보 조건에서 기존 표를 다시 고르면 덮어씁니다.</p>
    </Card>
  );
}

/** 텍스트로 한 번에 붙여넣기(표가 아주 클 때) */
export function RatePasteBox() {
  const { dispatch, current: c } = usePlan();
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const apply = () => {
    try {
      const grid = parseRateText(text);
      dispatch({ type: "coverage", id: c.id, patch: { grid, presetId: "custom" } });
      setMsg(`${grid.ages.length}개 연령을 읽었습니다.`); setText("");
    } catch (err) { setMsg(err instanceof Error ? err.message : "읽지 못했습니다."); }
  };
  return (
    <details className="rounded-lg border border-navy/10 bg-white p-4 shadow-sm">
      <summary className="cursor-pointer text-sm text-navy">텍스트로 붙여넣기</summary>
      <p className="mt-2 text-xs text-navy/60">Excel에서 복사한 내용을 그대로 붙여넣고 적용을 누르세요. 탭·쉼표·세미콜론 구분을 모두 읽습니다.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder={"40\t0.00123\t0.00250\n41\t0.00131\t0.00268"}
        className="mt-2 w-full rounded border border-navy/20 p-2 font-mono text-xs focus:border-sky focus:outline-none" />
      <div className="mt-2 flex items-center gap-2">
        <Button primary onClick={apply} disabled={!text.trim()}>적용</Button>
        {msg && <span className="text-xs text-sky">{msg}</span>}
      </div>
    </details>
  );
}
