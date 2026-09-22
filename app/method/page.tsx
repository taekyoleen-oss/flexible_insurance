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
import { validateSpec, type Confidence, type Evidence, type MethodSpec, type ParseResult } from "@/lib/methoddoc/spec";
import { applySpecToPlan, openSpecAsPlan, planFromSpec, readSpecJson, specFromPlanStorage } from "@/lib/methoddoc-bridge";

const TONE: Record<Confidence, string> = {
  high: "bg-sky/15 text-sky", medium: "bg-[#fef3c7] text-[#92400e]", low: "bg-[#fee2e2] text-[#991b1b]",
};
const CONF_LABEL: Record<Confidence, string> = { high: "표에서 직접", medium: "본문 규칙", low: "AI 추정" };

/** 폴더·여러 파일을 한 번에 올렸을 때의 목록 */
interface QueueItem { name: string; size: number; status: "대기" | "읽는 중" | "완료" | "실패"; doc?: ExtractedDoc; res?: ParseResult; error?: string }

const READABLE = /\.(docx|hwpx?|pdf|xlsx?|csv|txt|md)$/i;

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
  const [queue, setQueue] = useState<QueueItem[]>([]);
  /** 다른 앱(Life_ins_Doc_Convert_Studio 등)이 낸 MethodSpec JSON — 검수 없이 설계 전체로 옮긴다 */
  const [json, setJson] = useState<{ name: string; spec: MethodSpec; warnings: string[]; done: boolean } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/method-llm").then((r) => r.json()).then((d: { available: boolean }) => setLlmReady(d.available)).catch(() => setLlmReady(false));
  }, []);

  const ask: LlmAsk = async (req) => {
    const r = await fetch("/api/method-llm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
    const d = (await r.json()) as { answers?: Record<string, string | number | boolean>; error?: string };
    if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
    return d.answers ?? {};
  };

  /** 파일 하나를 읽고 항목을 뽑는다 */
  const readOne = async (f: File): Promise<{ doc: ExtractedDoc; res: ParseResult }> => {
    const d = await extractDoc(f.name, new Uint8Array(await f.arrayBuffer()), sheetReader);
    let r = parseMethodDoc(d, { fallbackName: f.name.replace(/\.[^.]+$/, "") });
    if (llmOn && llmReady) r = await fillWithLlm(r, d, ask);
    return { doc: d, res: r };
  };

  const show = (name: string, d: ExtractedDoc, r: ParseResult) => {
    setFileName(name); setDoc(d); setRes(r); setErr(null);
    setAccepted(new Set(r.evidence.filter((e) => e.confidence !== "low").map((e) => e.path)));
    setTab("review");
  };

  /** 폴더·여러 파일을 차례로 읽는다. 하나가 실패해도 나머지는 계속 */
  const onFiles = async (files: File[]) => {
    setJson(null);
    if (files.length === 1 && /\.json$/i.test(files[0].name)) {
      try {
        const spec = readSpecJson(await files[0].text());
        setErr(null); setRes(null); setDoc(null); setQueue([]);
        setJson({ name: files[0].name, spec, warnings: planFromSpec(spec).warnings, done: false });
      } catch (e) { setErr({ msg: e instanceof SyntaxError ? "JSON 을 읽지 못했습니다." : e instanceof Error ? e.message : String(e) }); }
      return;
    }
    const list = files.filter((f) => READABLE.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    if (!list.length) { setErr({ msg: "읽을 수 있는 파일이 없습니다 (DOCX·HWP·HWPX·PDF·XLSX·CSV·TXT)." }); return; }
    setErr(null); setRes(null); setDoc(null);
    setQueue(list.map((f) => ({ name: f.name, size: f.size, status: "대기" })));
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      setBusy(`${i + 1}/${list.length} ${f.name}`);
      setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "읽는 중" } : x)));
      try {
        const { doc: d, res: r } = await readOne(f);
        setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "완료", doc: d, res: r } : x)));
        if (i === 0) show(f.name, d, r);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setQueue((q) => q.map((x, j) => (j === i ? { ...x, status: "실패", error: msg } : x)));
        if (list.length === 1) setErr(e instanceof ExtractError ? { msg, why: e.why } : { msg });
      }
    }
    setBusy("");
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
          <Button onClick={() => folder.current?.click()} disabled={!!busy}>폴더 고르기</Button>
          <input ref={file} type="file" multiple accept=".docx,.hwp,.hwpx,.pdf,.xlsx,.xls,.csv,.txt,.md,.json" className="hidden"
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void onFiles(fs); e.target.value = ""; }} />
          <input ref={folder} type="file" className="hidden" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void onFiles(fs); e.target.value = ""; }} />
          <span className="text-xs text-navy/55">DOCX · HWP(5.x) · HWPX · <b>PDF</b> · XLSX · CSV · TXT — 여러 개·폴더째 가능 · MethodSpec <b>JSON</b></span>
          <label className="ml-auto flex items-center gap-1.5 text-sm" title={llmReady === false ? "서버에 ANTHROPIC_API_KEY 가 없어 꺼져 있습니다" : "규칙이 못 찾은 항목만 문단 발췌로 물어봅니다"}>
            <input type="checkbox" className="accent-sky" checked={llmOn} disabled={!llmReady} onChange={(e) => setLlmOn(e.target.checked)} />
            AI 보조 {llmReady === false && <span className="text-navy/40">(미설정)</span>}
          </label>
        </div>
        <p className="mt-1 text-xs text-navy/50">
          규칙(표 → 본문)만으로 먼저 뽑고, AI 보조를 켜면 빈 항목만 문단 발췌로 물어봅니다. AI가 채운 값은 빨간 뱃지로 표시되며 기본적으로 적용하지 않습니다.
          HWP 는 한글에서 PDF 로 저장해 올려도 됩니다 — 같은 결과가 나옵니다. DRM이 걸린 파일·스캔 PDF(글자 없는 이미지)는 읽을 수 없어 이유를 알려 드립니다.
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
        {queue.length > 1 && (
          <ul className="mt-2 max-h-56 divide-y divide-navy/10 overflow-auto rounded border border-navy/10">
            {queue.map((q, i) => (
              <li key={i} className="flex items-center gap-2 px-2 py-1 text-xs">
                <span className={`w-12 shrink-0 rounded px-1 text-center ${q.status === "완료" ? "bg-sky/15 text-sky" : q.status === "실패" ? "bg-[#fee2e2] text-[#991b1b]" : "bg-navy/5 text-navy/50"}`}>{q.status}</span>
                <button type="button" disabled={!q.res} onClick={() => q.doc && q.res && show(q.name, q.doc, q.res)}
                  className="flex-1 truncate text-left text-navy/80 enabled:hover:text-sky disabled:text-navy/40">{q.name}</button>
                <span className="shrink-0 text-navy/45">
                  {q.res ? `항목 ${q.res.evidence.length}개` : q.error ? q.error.slice(0, 60) : `${Math.round(q.size / 1024)}KB`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(doc?.warnings.length || res?.warnings.length) ? (
          <ul className="mt-1 space-y-0.5 text-xs text-[#92400e]">
            {[...(doc?.warnings ?? []), ...(res?.warnings ?? [])].map((w, i) => <li key={i}>· {w}</li>)}
          </ul>
        ) : null}
      </Card>

      {json && (() => {
        const s = json.spec, tables = s.rates.filter((r) => r.table?.ages?.length || r.tables?.M || r.tables?.F).length;
        return (
          <Card title="MethodSpec JSON → 상품 만들기 (설계 전체)">
            <p className="text-sm text-navy/80">
              <b>{s.meta.productName || json.name}</b> · 계약정보 {s.contract.age !== undefined ? `${s.contract.age}세 ${s.contract.sex === "F" ? "여" : "남"}` : "기본값"} · 담보 {s.benefits.length}개 · 위험률 {s.rates.length}개(값 표 {tables}개)
              {s.units.length > 1 && <> · 계약 단위 {s.units.length}개</>}
            </p>
            <p className="mt-1 text-xs text-navy/55">
              Life_ins_Doc_Convert_Studio 등 다른 앱이 낸 조건입니다. 검수 없이 기초율·사업비·위험률 표(시트 열)·담보를 통째로 옮겨 &quot;상품 만들기&quot; 설계를 바꿉니다. 계약정보(성별·가입나이·기간·가입금액)는 JSON 에 없으면 기본값으로 두고 상품 만들기 M02 에서 고칩니다.
              지금 설계가 필요하면 상품 만들기의 보관함에 먼저 저장하세요.
            </p>
            {json.warnings.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-[#92400e]">{json.warnings.map((w, i) => <li key={i}>· {w}</li>)}</ul>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button primary disabled={json.done} onClick={() => {
                if (!window.confirm("지금 '상품 만들기' 설계를 이 조건으로 바꿀까요?")) return;
                openSpecAsPlan(s);
                setJson({ ...json, done: true });
              }}>상품 만들기에 넣기</Button>
              {json.done && <Link href="/builder" className="rounded bg-sky px-3 py-1.5 text-sm font-medium text-white hover:bg-sky/90">넣었습니다 — 상품 만들기 열기 →</Link>}
            </div>
          </Card>
        );
      })()}

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
          <li>· <b>DRM·스캔 PDF는 못 읽습니다.</b> 해제본을 DOCX·HWPX·PDF(글자가 살아 있는 것) 로 저장해 올려 주세요. 한글의 &quot;PDF로 저장&quot;은 글자가 남습니다.</li>
          <li>· <b>자동 적용하지 않습니다.</b> 항상 검수에서 고른 것만 반영합니다. AI가 채운 값은 기본 해제 상태입니다.</li>
          <li>· 위험률 <b>표</b>는 별첨 엑셀을 시트에 직접 붙여넣는 쪽이 정확합니다. 본문에서는 계열 이름·근거 문구만 가져옵니다.</li>
          <li>· <b>MethodSpec JSON</b>(Life_ins_Doc_Convert_Studio 에서 위험률 표를 이어 내보낸 것)은 위험률 표·담보까지 통째로 옮깁니다. 남·여 두 벌이면 계약정보 성별의 표를 씁니다.</li>
          <li>· 회사마다 표기가 달라 사전({LLM_FIELDS.length}개 항목)을 늘려 가며 적중률을 올립니다. 안 잡히는 표기를 알려 주시면 사전에 넣겠습니다.</li>
        </ul>
      </Card>
    </div>
  );
}
