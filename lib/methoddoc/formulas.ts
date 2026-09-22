import type { FormulaSpec, MethodSpec, RateRef } from "./spec";

/**
 * 조건(MethodSpec) → 산출식. 앱 엔진 없이 조건만으로 산출방법서의 3장 이후를 만든다.
 *
 * 규칙은 기존 산출방법서를 따른다.
 *  - 유지자수·납입자수는 "율"이 아니라 "~를 제외한 생존자수"로 적는다
 *      사유 하나    lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q)
 *      사유 둘      lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q − k + q·k/2)
 *      사유 셋 이상 1 − Σd + Σ_{i<j} dᵢ·dⱼ/2
 *  - 납입자수 l′ 는 담보의 탈퇴 사유로 똑같이 줄고, 납입만 면제되는 사유(role: waiver)가 있으면 f 로 더 준다
 *  - 사망형(role: death) 담보는 탈퇴 사유 전부에 같은 보험금(종신의 "사망 또는 80% 이상 장해")
 */

const at = (x: string) => `${x}_{x+t}`;

/** 1 − Σd + Σ_{i<j} dᵢ·dⱼ/2 */
export function survivalText(syms: string[]): string {
  if (!syms.length) return "1";
  if (syms.length === 1) return `1 − ${at(syms[0])}`;
  const pairs = pairsOf(syms);
  return `1 − ${syms.map(at).join(" − ")} + ${pairs.length === 1 ? pairs[0] : `( ${pairs.join(" + ")} )`}/2`;
}

/** 탈퇴율 = 1 − 잔존 — 사유 둘이면 q + k − q·k/2 */
export function lossText(syms: string[]): string {
  const pairs = pairsOf(syms);
  return `${syms.map(at).join(" + ")}${pairs.length ? ` − ${pairs.length === 1 ? pairs[0] : `( ${pairs.join(" + ")} )`}/2` : ""}`;
}

function pairsOf(syms: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) out.push(`${at(syms[i])}·${at(syms[j])}`);
  return out;
}

/** 위험률 이름을 지급 사유 낱말로 — "제7회 경험생명표 사망률" → "사망", "80% 이상 장해율" → "80% 이상 장해" */
export const reasonOf = (r: RateRef) => (r.role === "death" ? "사망" : r.name.replace(/\s*(발생)?[율률]\s*[a-zA-Z]?$/, ""));

/** 사업비가 산출방법서형(α_S·α_P·β_S·β_G·β′·γ)인지 */
const isMethodExpenses = (spec: MethodSpec) =>
  !spec.expenses.length || spec.expenses.some((e) => /^(α_S|α_P|β_S|β_G|β′|β'|α1|α2|β1|β2)$/.test(e.symbol));

export function generateFormulas(spec: MethodSpec): FormulaSpec[] {
  const out: FormulaSpec[] = [];
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const low = lapse && spec.basis.lowRatio !== undefined;
  const waivers = spec.basis.waiver ? spec.rates.filter((r) => r.role === "waiver") : [];
  const multi = spec.benefits.length > 1;

  // 담보별 유지자수·납입자수·급부
  spec.benefits.forEach((b, bi) => {
    const cols = (b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);
    const count = { q: cols.filter((c) => c.role === "death").length, k: cols.filter((c) => c.role !== "death").length };
    const seen = { q: 0, k: 0 };
    const syms = cols.map((c) => {
      const base = c.role === "death" ? "q" : "k";
      seen[base]++;
      return count[base] > 1 ? `${base}^{(${seen[base]})}` : base;
    });
    const legend = cols.map((c, i) => `${syms[i]}_x : ${c.name}`);
    if (waivers.length) legend.push(`f_x : ${waivers.map((w) => w.name).join(" · ")} — 납입만 면제되는 사유`);
    if (lapse) legend.push("w_x : 적용해지율 (납입기간 중)");

    const lines: string[] = [];
    const Q = syms.length === 1 ? at(syms[0]) : "Q_{x+t}";
    if (syms.length > 1 && (lapse || waivers.length)) lines.push(`탈퇴율  Q_{x+t} = ${lossText(syms)}`);
    const keep = !syms.length ? "1" : lapse ? `1 − ${Q} − w_{x+t} + ${Q}·w_{x+t}/2` : survivalText(syms);
    lines.push(`유지자수  l_{x+t+1} = l_{x+t} × ( ${keep} )`);
    if (waivers.length) {
      const pay = lapse
        ? `1 − ${Q} − f_{x+t} − w_{x+t} + ( ${Q}·f_{x+t} + ${Q}·w_{x+t} + f_{x+t}·w_{x+t} )/2`
        : `1 − ${Q} − f_{x+t} + ${Q}·f_{x+t}/2`;
      lines.push(`납입자수  l′_{x+t+1} = l′_{x+t} × ( ${pay} )`);
    } else {
      lines.push(`납입자수  l′_{x+t+1} = l′_{x+t} × ( ${keep} )        → l′_{x+t} = l_{x+t}`);
    }
    const half = lapse ? "·( 1 − w_{x+t}/2 )" : "";
    if (b.role === "death") {
      lines.push(lapse ? `급부 발생자  C_{x+t} = l_{x+t}·${Q}${half}·v^{t+½}` : "급부 발생자  C_{x+t} = ( l_{x+t} − l_{x+t+1} )·v^{t+½}");
    } else if (b.role === "incidence") {
      const ev = cols.findIndex((c) => c.id === b.rateId);
      lines.push(`급부 발생자  C_{x+t} = l_{x+t}·${ev >= 0 ? syms[ev] : "g"}_{x+t}${half}·v^{t+½}`);
    } else if (b.role === "recurring") {
      lines.push(`급부  C_{x+t} = l_{x+t}·g_{x+t}${half}·v^{t+½}        (g : ${spec.rates.find((r) => r.id === b.rateId)?.name ?? "연간 기대 지급일수"})`);
    }
    const why = b.role === "death" && cols.length > 1
      ? `${cols.map(reasonOf).join("·")} 모두 같은 보험금을 지급하므로 탈퇴자 전부가 급부 대상이다. `
      : b.role === "incidence" ? "진단 확정 시 지급하고 그 담보는 소멸한다. " : "";
    out.push({
      section: "계산기수",
      // 이 담보 + 그 탈퇴 위험률 + (있으면) 납입면제·해지율 — 어느 조건을 골라도 이 식이 표시되게
      path: [`benefits[${bi}]`, ...cols.map((c) => `rates[${spec.rates.indexOf(c)}]`),
        ...(waivers.length ? ["basis.waiver", ...waivers.map((w) => `rates[${spec.rates.indexOf(w)}]`)] : []),
        ...(lapse ? ["basis.lapse"] : [])].join("|"),
      label: multi ? `유지자수·납입자수 — ${b.unit ? `${b.unit} ` : ""}${b.name}` : `유지자수·납입자수 — ${b.name}`,
      text: [...legend, "", "l_x = l′_x = 100,000", ...lines].join("\n"),
      note: `${why}납입자수 l′ 는 ${waivers.length ? "탈퇴 사유에 더해 f 사유 발생 시에도" : "탈퇴 사유로 유지자수와 똑같이"} 줄어든다 — 별도의 납입면제율을 곱하지 않는다.`,
    });
  });

  out.push({ section: "계산기수", label: "계산기수", path: "basis.interest", text:
    "D_{x+t} = l_{x+t}·v^t    D′_{x+t} = l′_{x+t}·v^t\n" +
    "C_{x+t} = l_{x+t}·g_{x+t}·( 1 − w_{x+t}/2 )·v^{t+½}    W_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}\n" +
    "N_{x+t} = Σ_{u≥t} D_{x+u}    N′_{x+t} = Σ_{u≥t} D′_{x+u}",
    note: "g 는 위 담보별 식의 급부 발생률이다. Q·(1−w/2) + w = Q + w − Q·w/2 이므로 급부·해지 탈퇴의 합이 l_{x+t} − l_{x+t+1} 과 정확히 일치한다." });

  const meth = isMethodExpenses(spec);
  out.push(
    { section: "보험료의 계산", label: "급부 현가와 납입기수", path: "benefits", text:
      "PVB = Σ_{t=0}^{n−1} S_t·C_{x+t} + Σ_{t=0}^{n} C_t·D_{x+t}\n" +
      "N* = mm · [ ( N′_x − N′_{x+m} ) − ( mm−1 )/( 2·mm )·( D′_x − D′_{x+m} ) ]" },
    { section: "보험료의 계산", label: "순보험료·기준연납순보험료", path: "benefits", text:
      "P = PVB / N*        P_base = PVB / ( N′_x − N′_{x+min(n,20)} )" },
    { section: "보험료의 계산", label: "영업보험료", path: "expenses", text: meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/mm + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )",
      note: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다. 10만원당 보험료에서 한 번만 반올림하고, 담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000)으로 한다." },
  );
  if (low) out.push({ section: "보험료의 계산", label: "저해지·무해지환급형", path: "basis.lowRatio", text:
    "CSV_t = Σ_{u≥t, u<m} W_{x+u} · w^r · ( W^표준_u + W^표준_{u+1} ) / 2\n" +
    "Ā_x = PVB + CSV_0        P = Ā_x / N*",
    note: "W^표준은 같은 조건의 표준형(완전 환급) 해지환급금이다. w = 0으로 두면 CSV = 0이고 보험료가 표준형과 완전히 같아진다." });

  const dy = spec.surrender.deductionYears ?? 7;
  const ratio = spec.basis.lowRatio;
  out.push(
    { section: "책임준비금의 계산", label: "연말 책임준비금", path: "basis.standardInterest", text:
      "P_β = ( PVB + CSV_0 + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )\n" +
      "V_t = [ Σ_{u≥t} S_u·C_{x+u} + Σ_{u>t} C_u·D_{x+u} + CSV_t + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}",
      note: "순보식에 납입 후 유지비 β′를 더한 형태. 표준준비금은 표준이율로 같은 식을 계산한다." },
    { section: "해지환급금의 계산", label: "해약공제와 해지환급금", path: "surrender", text:
      `해약공제_t = α^공제 · max( min(m,${dy}) − t, 0 ) / min(m,${dy})        α^공제 = min( α, α^std )\n` +
      (meth ? "α = α_S + α_P · round₅( P_base )    (영업보험료 G 에는 반올림 전 P_base 를 쓴다)\n" : "") +
      "W^표준_t = max( V_t − 해약공제_t, 0 )" +
      (low && ratio !== undefined ? `\n납입기간 중: W_t = ${Math.round(ratio * 100)}% × W^표준_t        납입 완료 후: W_t = W^표준_t` : "") },
    { section: "해지환급금의 계산", label: "환급률", path: "surrender", text: "환급률_t = W_t / 납입누계_t,   납입누계_t = min(t, m) × mm × G" },
  );
  return out;
}

/** 조건의 식(사용자가 따로 적은 것) 앞에 자동 생성 식을 붙인다. 같은 라벨이면 사용자 것이 이긴다 */
export function withFormulas(spec: MethodSpec): MethodSpec {
  const own = new Set(spec.formulas.map((f) => `${f.section}|${f.label}`));
  const auto = generateFormulas(spec).filter((f) => !own.has(`${f.section}|${f.label}`));
  return { ...spec, formulas: [...auto, ...spec.formulas.map((f, i) => ({ ...f, path: f.path ?? `formulas[${i}]` }))] };
}
