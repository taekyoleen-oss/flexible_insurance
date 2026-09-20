"use client";
import Link from "next/link";
import { FormulaText } from "@/components/formula-text";
import { PlanProvider, usePlan } from "@/components/builder/plan-provider";
import { Button } from "@/components/ui";
import { buildPlanDoc, docToMarkdown, type DocBlock } from "@/lib/plan-doc";

function Block({ b }: { b: DocBlock }) {
  if (b.t === "p") return <p className="mt-2 text-sm text-navy/80">{b.text}</p>;
  if (b.t === "note") return <p className="mt-2 border-l-2 border-sky/50 bg-sky/[0.04] py-1 pl-3 text-xs text-navy/70">{b.text}</p>;
  if (b.t === "formula") return <FormulaText text={b.text} block className="mt-2" />;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead><tr>{b.head.map((h) => <th key={h} className="border border-navy/15 bg-cream px-2 py-1 text-left font-medium text-navy/70">{h}</th>)}</tr></thead>
        <tbody>
          {b.rows.map((row, i) => (
            <tr key={i}>{row.map((c, j) => <td key={j} className={`border border-navy/15 px-2 py-1 ${j === 0 ? "" : "text-right font-mono"}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Doc() {
  const { state: s, result, sheet, loaded } = usePlan();
  if (!loaded) return null;
  const title = `${s.productName || "상품"} 보험료 및 책임준비금 산출식`;
  const sections = buildPlanDoc(s, result, sheet);
  const save = () => {
    const url = URL.createObjectURL(new Blob(["﻿" + docToMarkdown(sections, title)], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${(s.productName || "상품").replace(/[^\w가-힣]+/g, "_")}_산출식.md`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mx-auto max-w-[190mm]">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href="/builder" className="text-sm text-sky hover:underline">← 상품 만들기</Link>
        <div className="flex-1" />
        <Button onClick={save}>Markdown 내려받기</Button>
        <Button primary onClick={() => window.print()}>인쇄 / PDF 저장</Button>
      </div>
      <h1 className="font-display text-2xl text-navy">{title}</h1>
      <p className="mt-1 text-xs text-navy/50">지금 입력한 조건으로 실제 수행한 계산입니다. 기호는 보험수리 표기를 따릅니다.</p>
      {sections.map((sec) => (
        <section key={sec.id} className="mt-6 break-inside-avoid">
          <h2 className="border-b border-navy/15 pb-1 font-display text-lg text-navy">{sec.title}</h2>
          {sec.blocks.map((b, i) => <Block key={i} b={b} />)}
        </section>
      ))}
      <p className="mt-8 text-xs text-navy/50">산출 엔진과 기호 정의는 docs/산출방법서_설계형보험.md 와 같습니다.</p>
    </div>
  );
}

export default function PlanDocPage() {
  return <PlanProvider><Doc /></PlanProvider>;
}
