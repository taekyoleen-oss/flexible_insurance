"use client";
import { useEffect, useState } from "react";
import { useDesign } from "@/components/design-provider";
import { Button, Card, Field, MillionInput, NumInput, Select } from "@/components/ui";
import { won } from "@/lib/format";
import { loadLibrary, type LibraryEntry } from "@/lib/library";
import { fromDesign, fromManual, type ManualOld, type OldContract } from "@/lib/redesign";

type Source = "current" | "library" | "manual";
const SOURCE_LABEL: Record<Source, string> = { current: "현재 설계", library: "보관함", manual: "직접 입력" };

/** 원계약 입력: 이 앱 설계(현재·보관함)는 경과년만, 타사 계약은 직접 입력 */
export function OldContractForm({ value, onChange }: { value: OldContract | null; onChange: (o: OldContract) => void }) {
  const { state } = useDesign();                   // 루트(내 설계)
  const [source, setSource] = useState<Source>("current");
  const [elapsed, setElapsed] = useState(10);
  const [lib, setLib] = useState<LibraryEntry[]>([]);
  const [libId, setLibId] = useState("");
  const [manual, setManual] = useState<ManualOld>({ sex: "M", entryAge: 40, benefit: 1e8, payYears: 20, elapsed: 10, interest: 0.035 });
  useEffect(() => { const l = loadLibrary().filter((e) => !e.redesign); setLib(l); if (l[0]) setLibId(l[0].id); }, []);

  const build = (): OldContract | null => {
    if (source === "current") return fromDesign(state, elapsed);
    if (source === "library") { const e = lib.find((x) => x.id === libId); return e ? fromDesign(e.state, elapsed, e.name) : null; }
    return fromManual(manual, state.settings);
  };
  const apply = () => { const o = build(); if (o) onChange(o); };

  return (
    <Card title="1. 원계약">
      <div className="flex flex-wrap gap-2 text-sm">
        {(Object.keys(SOURCE_LABEL) as Source[]).map((s) => (
          <Button key={s} primary={source === s} aria-pressed={source === s} onClick={() => setSource(s)}>{SOURCE_LABEL[s]}</Button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {source === "library" && (
          <Field label="보관함 항목"><Select value={libId} onChange={(e) => setLibId(e.target.value)}>{lib.length === 0 && <option value="">저장된 설계 없음</option>}{lib.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</Select></Field>
        )}
        {source !== "manual" ? (
          <Field label="경과년" hint="가입 후 지난 연수(재설계 시점)"><NumInput value={elapsed} min={0} max={60} onCommit={(v) => setElapsed(Math.round(v))} /></Field>
        ) : (
          <>
            <Field label="성별"><Select value={manual.sex} onChange={(e) => setManual({ ...manual, sex: e.target.value as ManualOld["sex"] })}><option value="M">남</option><option value="F">여</option></Select></Field>
            <Field label="가입연령"><NumInput value={manual.entryAge} min={15} max={70} onCommit={(v) => setManual({ ...manual, entryAge: Math.round(v) })} /></Field>
            <Field label="보험금(평준)"><MillionInput value={manual.benefit} onChange={(v) => setManual({ ...manual, benefit: v })} min={1} max={1e4} /></Field>
            <Field label="납입기간(년)"><NumInput value={manual.payYears} min={1} max={40} onCommit={(v) => setManual({ ...manual, payYears: Math.round(v) })} /></Field>
            <Field label="경과년"><NumInput value={manual.elapsed} min={0} max={60} onCommit={(v) => setManual({ ...manual, elapsed: Math.round(v) })} /></Field>
            <Field label="원계약 예정이율(%)"><NumInput value={Math.round(manual.interest * 1e4) / 100} step={0.05} min={0} max={20} onCommit={(v) => setManual({ ...manual, interest: v / 100 })} /></Field>
            <Field label="현재 준비금 (0이면 엔진 계산)"><MillionInput value={manual.reserve ?? 0} onChange={(v) => setManual({ ...manual, reserve: v || undefined })} min={0} max={1e4} /></Field>
            <Field label="현재 해약환급금 (0이면 엔진 계산)"><MillionInput value={manual.cash ?? 0} onChange={(v) => setManual({ ...manual, cash: v || undefined })} min={0} max={1e4} /></Field>
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button primary onClick={apply} disabled={source === "library" && !libId}>원계약으로 사용</Button>
        {value && <span className="text-xs text-navy/60">{value.label} · {value.attainedAge}세 · 현재 보험금 {won(value.benefitNow)} · 준비금 {won(value.reserve)} · 환급금 {won(value.cash)} · 월 {won(value.monthlyGross)} · 이율 {(value.interest * 100).toFixed(2)}%</span>}
      </div>
    </Card>
  );
}
