"use client";
import Link from "next/link";
import { FormulaText } from "@/components/formula-text";
import { PlanProvider, usePlan } from "@/components/builder/plan-provider";
import { Button } from "@/components/ui";
import { buildPlanDoc, docToHtml, docToMarkdown, isNumericCell, planDocTitle, type DocBlock } from "@/lib/plan-doc";

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
            <tr key={i}>{row.map((c, j) => <td key={j} className={`break-keep border border-navy/15 px-2 py-1 ${j > 0 && isNumericCell(c) ? "text-right font-mono" : ""}`}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Doc() {
  const { state: s, product, loaded } = usePlan();
  if (!loaded) return null;
  const title = planDocTitle(s);
  const sections = buildPlanDoc(s, product);
  const file = (s.productName || "상품").replace(/[^\w가-힣]+/g, "_");
  const save = (kind: "md" | "html") => {
    const body = kind === "md" ? "﻿" + docToMarkdown(sections, title) : docToHtml(sections, title);
    const url = URL.createObjectURL(new Blob([body], { type: kind === "md" ? "text/markdown;charset=utf-8" : "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${file}_산출방법서.${kind}`; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mx-auto max-w-[190mm]">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href="/builder" className="text-sm text-sky hover:underline">← 상품 만들기</Link>
        <div className="flex-1" />
        <Button onClick={() => save("md")}>Markdown</Button>
        <Button onClick={() => save("html")}>HTML</Button>
        <Button primary onClick={() => window.print()}>인쇄 / PDF 저장</Button>
      </div>
      <h1 className="font-display text-2xl text-navy">{title}</h1>
      <p className="mt-1 text-xs text-navy/50">지금 입력한 조건으로 실제 수행한 계산입니다. 기호는 보험수리 표기를 따르고, 목차는 참조 산출방법서(기초율 → 급부 → 보험료 → 책임준비금 → 해지환급금)를 따릅니다.</p>
      {sections.map((sec) => (
        <section key={sec.id} className="mt-6 break-inside-avoid">
          <h2 className="border-b border-navy/15 pb-1 font-display text-lg text-navy">{sec.title}</h2>
          {sec.blocks.map((b, i) => <Block key={i} b={b} />)}
        </section>
      ))}
      <p className="mt-8 text-xs text-navy/50">중립 모델(MethodSpec)을 거쳐 만듭니다 — <span className="font-mono">lib/methoddoc</span>. 같은 모델을 거꾸로 읽어 조건을 채우는 것이 <a href="/method" className="text-sky underline">산출방법서 변환기</a>입니다.</p>
    </div>
  );
}

export default function PlanDocPage() {
  return <PlanProvider><Doc /></PlanProvider>;
}
