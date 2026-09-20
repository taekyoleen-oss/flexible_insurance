"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { FormulaText } from "@/components/formula-text";
import { Button, Card } from "@/components/ui";
import { extractDoc, ExtractError, type ExtractedDoc, type SheetReader } from "@/lib/methoddoc/extract";
import { parseMethodDoc } from "@/lib/methoddoc/parse";
import { fillWithLlm, LLM_FIELDS, type LlmAsk } from "@/lib/methoddoc/llm";
import { docToHtml, docToMarkdown, renderMethodDoc, type DocBlock } from "@/lib/methoddoc/render";
import { validateSpec, type Confidence, type Evidence, type ParseResult } from "@/lib/methoddoc/spec";
import { applySpecToPlan, specFromPlanStorage } from "@/lib/methoddoc-bridge";

const TONE: Record<Confidence, string> = {
  high: "bg-sky/15 text-sky", medium: "bg-[#fef3c7] text-[#92400e]", low: "bg-[#fee2e2] text-[#991b1b]",
};
const CONF_LABEL: Record<Confidence, string> = { high: "표에서 직접", medium: "본문 규칙", low: "AI 추정" };

/** SheetJS 를 extract 에 주입한다 — methoddoc 모듈 자체는 엑셀 파서를 모른다 */
const sheetReader: SheetReader = (buf) => {
  const wb = XLSX.read(buf, { type: "array" });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, blankrows: false })
      .map((r) => (r as unknown[]).map((c) => String(c ?? "").trim())),
  }));
};

function Block({ b }: { b: DocBlock }) {
  if (b.t === "p") return <p className="mt-2 text-sm text-navy/80">{b.text}</p>;
  if (b.t === "note") return <p className="mt-2 border-l-2 border-sky/50 bg-sky/[0.04] py-1 pl-3 text-xs text-navy/70">{b.text}</p>;
  if (b.t === "formula") return <FormulaText text={b.text} block className="mt-2" />;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead><tr>{b.head.map((h, i) => <th key={i} className="border border-navy/15 bg-cream px-2 py-1 text-left font-medium text-navy/70">{h}</th>)}</tr></thead>
        <tbody>{b.rows.map((row, i) => (
          <tr key={i}>{row.map((c, j) => <td key={j} className={`border border-navy/15 px-2 py-1 ${j ? "text-right font-mono" : ""}`}>{c}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  );
}

export default function MethodPage() {
  const [doc, setDoc] = useState<ExtractedDoc | null>(null);
  const [res, setRes] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [err, setErr] = useState<{ msg: string; why?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [llmOn, setLlmOn] = useState(false);
  const [llmReady, setLlmReady] = useState<boolean | null>(null);
  const [tab, setTab] = useState<"review" | "doc" | "source">("review");
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/method-llm").then((r) => r.json()).then((d: { available: boolean }) => setLlmReady(d.available)).catch(() => setLlmReady(false));
  }, []);

  const ask: LlmAsk = async (req) => {
    const r = await fetch("/api/method-llm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const d = (await r.json()) as { answers?: Record<string, string | number | boolean>; error?: string };
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    return d.answers ?? {};
  };

  const onFile = async (f: File) => {
    setErr(null); setRes(null); setDoc(null); setBusy("읽는 중…"); setFileName(f.name);
    try {
      const d = await extractDoc(f.name, new Uint8Array(await f.arrayBuffer()), sheetReader);
      setDoc(d);
      setBusy("항목 뽑는 중…");
      let r = parseMethodDoc(d, { fallbackName: f.name.replace(/\.[^.]+$/, "") });
      if (llmOn && llmReady) { setBusy("AI 보조로 빈 항목 채우는 중…"); r = await fillWithLlm(r, d, ask); }
      setRes(r);
      setAccepted(new Set(r.evidence.filter((e) => e.confidence !== "low").map((e) => e.path)));
      setTab("review");
    } catch (e) {
      setErr(e instanceof ExtractError ? { msg: e.message, why: e.why } : { msg: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(""); }
  };

  const download = (name: string, body: string, type: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  };

  const spec = res?.spec;
  const accEvidence = (res?.evidence ?? []).filter((e) => accepted.has(e.path));
  const toggle = (p: string) => setAccepted((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  const title = spec ? `${spec.meta.productName || fileName} 보험료 및 책임준비금 산출방법서` : "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-navy">산출방법서 변환기</h1>
          <p className="text-sm text-navy/60">
            산출방법서를 읽어 입력 조건으로 바꾸고(→), 반대로 입력 조건을 산출방법서로 냅니다(←).
            가운데 형식은 <span className="font-mono">MethodSpec</span> 하나이고, 이 기능은 앱과 분리되어 있어 다른 앱에도 그대로 옮길 수 있습니다.
          </p>
        </div>
        <Link href="/builder" className="rounded border border-navy/20 px-3 py-1.5 text-sm text-navy hover:bg-navy/5">상품 만들기 →</Link>
      </div>

      {/* 1. 읽기 */}
      <Card title="① 산출방법서 읽기 → 입력 조건">
        <div className="flex flex-wrap items-center gap-2">
          <Button primary onClick={() => file.current?.click()} disabled={!!busy}>{busy || "파일 고르기"}</Button>
          <input ref={file} type="file" accept=".docx,.hwp,.hwpx,.xlsx,.xls,.csv,.txt,.md" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }} />
          <span className="text-xs text-navy/55">DOCX · HWP(5.x) · HWPX · XLSX · CSV · TXT</span>
          <label className="ml-auto flex items-center gap-1.5 text-sm" title={llmReady === false ? "서버에 ANTHROPIC_API_KEY 가 없어 꺼져 있습니다" : "규칙이 못 찾은 항목만 문단 발췌로 물어봅니다"}>
            <input type="checkbox" className="accent-sky" checked={llmOn} disabled={!llmReady} onChange={(e) => setLlmOn(e.target.checked)} />
            AI 보조 {llmReady === false && <span className="text-navy/40">(미설정)</span>}
          </label>
        </div>
        <p className="mt-1 text-xs text-navy/50">
          규칙(표 → 본문)만으로 먼저 뽑고, AI 보조를 켜면 빈 항목만 문단 발췌로 물어봅니다. AI가 채운 값은 빨간 뱃지로 표시되며 기본적으로 적용하지 않습니다.
          DRM이 걸린 파일·스캔 PDF는 읽을 수 없어 이유를 알려 드립니다.
        </p>
        {err && (
          <p className="mt-2 rounded bg-[#fee2e2] px-3 py-2 text-sm text-[#991b1b]">
            {err.msg}
            {err.why === "drm" && <span className="mt-1 block text-xs">사내 DRM 해제본으로 다시 올려 주세요.</span>}
            {err.why === "unsupported" && <span className="mt-1 block text-xs">한글/워드에서 DOCX 또는 HWPX 로 저장해 올리면 읽을 수 있습니다.</span>}
          </p>
        )}
        {doc && (
          <p className="mt-2 text-xs text-navy/60">
            <b>{fileName}</b> · {doc.kind.toUpperCase()} · 문단 {doc.paragraphs.length}개 · 표 {doc.tables.length}개
            {res && <> · 뽑은 항목 {res.evidence.length}개{res.missing.length > 0 && <span className="text-[#a34a1e]"> · 못 찾음 {res.missing.join(", ")}</span>}</>}
          </p>
        )}
        {(doc?.warnings.length || res?.warnings.length) ? (
          <ul className="mt-1 space-y-0.5 text-xs text-[#92400e]">
            {[...(doc?.warnings ?? []), ...(res?.warnings ?? [])].map((w, i) => <li key={i}>· {w}</li>)}
          </ul>
        ) : null}
      </Card>

      {res && spec && (
        <>
          <div className="flex gap-2">
            {(["review", "doc", "source"] as const).map((t) => (
              <Button key={t} primary={tab === t} onClick={() => setTab(t)}>
                {t === "review" ? `검수 (${accepted.size}/${res.evidence.length})` : t === "doc" ? "산출방법서로 다시 보기" : "원문"}
              </Button>
            ))}
            <div className="flex-1" />
            <Button onClick={() => download(`${(spec.meta.productName || "spec").replace(/[^\w가-힣]+/g, "_")}.methodspec.json`, JSON.stringify(spec, null, 2), "application/json")}>MethodSpec JSON</Button>
            <Button onClick={() => download(`${(spec.meta.productName || "doc").replace(/[^\w가-힣]+/g, "_")}_산출방법서.md`, docToMarkdown(renderMethodDoc(spec), title), "text/markdown;charset=utf-8")}>Markdown</Button>
            <Button onClick={() => download(`${(spec.meta.productName || "doc").replace(/[^\w가-힣]+/g, "_")}_산출방법서.html`, docToHtml(renderMethodDoc(spec), title), "text/html;charset=utf-8")}>HTML</Button>
          </div>

          {tab === "review" && (
            <Card title="② 검수 — 무엇을 어디서 읽었는지 확인하고 고릅니다">
              <div className="mb-2 flex flex-wrap gap-2 text-xs">
                <Button onClick={() => setAccepted(new Set(res.evidence.map((e) => e.path)))}>전부 적용</Button>
                <Button onClick={() => setAccepted(new Set())}>전부 해제</Button>
                <Button onClick={() => setAccepted(new Set(res.evidence.filter((e) => e.confidence !== "low").map((e) => e.path)))}>AI 추정만 빼기</Button>
                <Button primary onClick={() => {
                  const n = applySpecToPlan(spec, accEvidence);
                  alert(n > 0 ? `${n}개 항목을 '상품 만들기' 입력에 넣었습니다. 상품 만들기 화면에서 확인하세요.` : "적용할 항목이 없습니다.");
                }}>고른 항목을 상품 만들기에 넣기</Button>
              </div>
              <table className="w-full text-xs">
                <thead className="text-navy/60">
                  <tr><th className="w-8" /><th className="py-1 text-left font-medium">항목</th><th className="py-1 text-left font-medium">값</th><th className="py-1 text-left font-medium">출처</th><th className="py-1 text-left font-medium">원문</th></tr>
                </thead>
                <tbody>
                  {res.evidence.map((e: Evidence) => (
                    <tr key={e.path} className="border-t border-navy/10 align-top">
                      <td className="py-1"><input type="checkbox" className="accent-sky" checked={accepted.has(e.path)} onChange={() => toggle(e.path)} /></td>
                      <td className="py-1 text-navy/80">{e.label}<div className="font-mono text-[10px] text-navy/40">{e.path}</div></td>
                      <td className="py-1 font-mono text-navy">{String(e.value)}</td>
                      <td className="py-1"><span className={`rounded px-1.5 py-0.5 ${TONE[e.confidence]}`}>{CONF_LABEL[e.confidence]}</span><div className="text-[10px] text-navy/45">{e.source}</div></td>
                      <td className="max-w-[28rem] py-1 text-navy/55">{e.raw.slice(0, 160)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {validateSpec(spec).length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-[#a34a1e]">
                  {validateSpec(spec).map((w, i) => <li key={i}>! {w}</li>)}
                </ul>
              )}
              <p className="mt-2 text-xs text-navy/50">
                위험률 표 자체는 여기서 옮기지 않습니다 — 엑셀 별첨을 &quot;상품 만들기&quot;의 시트에 붙여넣거나 업로드하세요(연령 1열, 위험률 2열부터).
              </p>
            </Card>
          )}

          {tab === "doc" && (
            <Card title="③ 읽은 내용을 다시 산출방법서 형태로">
              <p className="mb-2 text-xs text-navy/55">같은 MethodSpec 에서 낸 것입니다. 왕복이 맞는지 원문과 비교해 보세요.</p>
              {renderMethodDoc(spec).map((sec) => (
                <section key={sec.id} className="mt-4">
                  <h3 className="border-b border-navy/15 pb-1 font-display text-base text-navy">{sec.title}</h3>
                  {sec.blocks.map((b, i) => <Block key={i} b={b} />)}
                </section>
              ))}
            </Card>
          )}

          {tab === "source" && doc && (
            <Card title="원문">
              <div className="max-h-[32rem] space-y-2 overflow-auto text-xs">
                {doc.tables.map((t, i) => (
                  <div key={`t${i}`}>
                    <p className="font-medium text-navy/70">표 {i + 1}</p>
                    <table className="w-full border-collapse"><tbody>
                      {[t.head, ...t.rows].map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-navy/10 px-1 py-0.5 text-navy/70">{c.slice(0, 120)}</td>)}</tr>)}
                    </tbody></table>
                  </div>
                ))}
                <p className="mt-3 font-medium text-navy/70">문단</p>
                {doc.paragraphs.map((p, i) => <p key={i} className="text-navy/60"><span className="mr-1 font-mono text-navy/30">{i + 1}</span>{p}</p>)}
              </div>
            </Card>
          )}
        </>
      )}

      {/* 2. 내보내기 */}
      <Card title="④ 입력 조건 → 산출방법서">
        <p className="text-xs text-navy/60">
          &quot;상품 만들기&quot;에 저장된 조건을 그대로 산출방법서로 냅니다. 코딩에 쓰는 조건이 곧 문서가 되도록, 같은 MethodSpec 을 거칩니다.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Link href="/builder/doc" className="rounded bg-sky px-3 py-1.5 text-sm font-medium text-white hover:bg-sky/90">지금 설계로 산출방법서 보기</Link>
          <Button onClick={() => {
            const s = specFromPlanStorage();
            if (!s) { alert("저장된 설계가 없습니다. 먼저 '상품 만들기'에서 조건을 넣으세요."); return; }
            download(`${(s.meta.productName || "spec").replace(/[^\w가-힣]+/g, "_")}.methodspec.json`, JSON.stringify(s, null, 2), "application/json");
          }}>지금 설계를 MethodSpec JSON 으로</Button>
        </div>
      </Card>

      <Card title="이 기능의 한계 (알고 쓰세요)">
        <ul className="space-y-1 text-xs text-navy/60">
          <li>· <b>수식은 뽑지 않습니다.</b> 산출방법서의 수식은 HWP 수식객체·이미지라 텍스트로 나오지 않습니다. 기호·산식은 앱 쪽 정의를 씁니다.</li>
          <li>· <b>DRM·스캔 PDF는 못 읽습니다.</b> 해제본을 DOCX·HWPX 로 저장해 올려 주세요.</li>
          <li>· <b>자동 적용하지 않습니다.</b> 항상 검수에서 고른 것만 반영합니다. AI가 채운 값은 기본 해제 상태입니다.</li>
          <li>· 위험률 <b>표</b>는 별첨 엑셀을 시트에 직접 붙여넣는 쪽이 정확합니다. 본문에서는 계열 이름·근거 문구만 가져옵니다.</li>
          <li>· 회사마다 표기가 달라 사전({LLM_FIELDS.length}개 항목)을 늘려 가며 적중률을 올립니다. 안 잡히는 표기를 알려 주시면 사전에 넣겠습니다.</li>
        </ul>
      </Card>
    </div>
  );
}
