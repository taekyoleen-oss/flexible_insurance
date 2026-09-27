import { waiverRates, type BenefitSpec, type FormulaSpec, type MethodSpec, type RateRef } from "./spec";

/**
 * 조건(MethodSpec) → 산출식. 앱 엔진 없이 조건만으로 산출방법서의 3장 이후를 만든다.
 *
 * 식은 산출 순서대로 묶는다 — 카드(조건 화면)와 절(산출방법서)이 같은 순서다.
 *   3. 탈퇴자·유지자·납입자   집단마다 l · l′   (탈퇴 사유가 같은 담보는 한 집단)
 *   4. 보험료의 현가          D · D′ · N · N′ · N*
 *   5. 보험금의 현가          담보마다 S · C · M · PVB
 *   6. 보험료의 계산          P · 기준연납순보험료 · G
 *   7~ 책임준비금 · 해지환급금
 *
 * 규칙은 기존 산출방법서를 따른다.
 *  - 유지자수·납입자수는 "율"이 아니라 "~를 제외한 생존자수"로 적는다
 *      사유 하나    lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q)
 *      사유 둘      lₓ₊ₜ₊₁ = lₓ₊ₜ (1 − q − r + q·r/2)   (q 사망률 · r 그 밖의 탈퇴 발생률)
 *      사유 셋 이상 1 − Σd + Σ_{i<j} dᵢ·dⱼ/2
 *  - 납입자수 l′ 는 담보의 탈퇴 사유로 똑같이 줄고, 납입만 면제되는 사유(f)가 있으면 더 준다
 *  - 사망형(role: death) 담보는 탈퇴 사유 전부에 같은 보험금(종신의 "사망 또는 80% 이상 장해")
 *  - 기호: n 보험기간 · m 납입기간 · k 납입주기별 계수(연 납입횟수) · ρ 납입기간 중 해지환급금 비율 — render 의 "기호의 정의" 절
 *  - 식은 한 줄에 하나, 설명은 그 위 줄(또는 식 제목)에 — 기존 산출방법서 모양이고, Word·한글 수식으로 옮기기 좋다
 *
 * 이 식 표기는 calc.ts 가 그대로 읽어 계산한다 — 식을 고치면 계산이 바뀐다.
 * 그래서 새 식을 더할 때는 calc.ts 의 문법(아래첨자 · Σ · if · min/max)을 벗어나지 않게 적는다.
 */

const at = (x: string) => `${x}_{x+t}`;

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

/** 여러 기호를 한 벌로 — 같은 밑글자가 둘 이상이면 q^{(1)} · q^{(2)} */
function numbered(base: string, n: number): string[] {
  return n === 1 ? [base] : Array.from({ length: n }, (_, i) => `${base}^{(${i + 1})}`);
}

// ── 집단 ────────────────────────────────────────────────────────────────────
/**
 * 탈퇴자·유지자·납입자 집단. 탈퇴 사유가 같은 담보는 l · l′ 가 똑같으므로 한 집단으로 묶어 한 번만 적는다.
 * 조건에 따로 적는 항목이 아니라 담보의 탈퇴 위험률(benefits[].exitRateIds)에서 나온다 — 집단을 고치면 그 담보들의 탈퇴 위험률이 바뀐다.
 */
export interface GroupModel {
  id: string;
  /** 탈퇴 사유를 이어 붙인 이름 — "사망 · 80% 이상 장해" */
  label: string;
  exits: RateRef[];
  /** 탈퇴 위험률의 기호 */
  syms: { sym: string; rate: RateRef }[];
  /** 납입만 면제되는 사유 (이 집단의 탈퇴 사유는 뺀다) */
  waivers: { sym: string; rate: RateRef }[];
  /** 적용해지율 (없으면 undefined) */
  lapseRate?: number;
  /** 이 집단을 쓰는 담보 번호 */
  benefitIdx: number[];
  legend: string[];
  lines: string[];
  note: string;
}

export function groupModels(spec: MethodSpec): GroupModel[] {
  const lapseRate = (spec.basis.lapse ?? []).find((l) => l.rate > 0)?.rate;
  const allWaivers = waiverRates(spec);
  const out: GroupModel[] = [];
  const keys: string[] = [];                            // 집단을 가르는 열쇠 — 탈퇴 위험률 id 를 이은 것
  spec.benefits.forEach((b, bi) => {
    const exits = (b.exitRateIds ?? []).map((id) => spec.rates.find((r) => r.id === id)).filter((r): r is RateRef => !!r);
    const key = exits.map((r) => r.id).join(",");
    const at = keys.indexOf(key);
    if (at >= 0) { out[at].benefitIdx.push(bi); return; }
    keys.push(key);
    const deaths = exits.filter((c) => c.role === "death"), others = exits.filter((c) => c.role !== "death");
    const dq = numbered("q", deaths.length), dr = numbered("r", others.length);
    const syms = exits.map((rate) => ({ rate, sym: rate.role === "death" ? dq[deaths.indexOf(rate)] : dr[others.indexOf(rate)] }));
    // 납입면제 사유 가운데 이 집단의 탈퇴 사유인 것은 탈퇴로 이미 줄었다 — 납입자수에서 다시 빼지 않는다
    const ws = allWaivers.filter((w) => !exits.includes(w));
    const wsym = numbered("f", ws.length);
    const waivers = ws.map((rate, i) => ({ rate, sym: wsym[i] }));
    out.push({ id: `g${out.length + 1}`, label: exits.map(reasonOf).join(" · ") || "(탈퇴 사유 없음)", exits, syms, waivers, lapseRate,
      benefitIdx: [bi], ...groupText(syms, waivers, lapseRate, allWaivers.length - ws.length ? allWaivers.filter((w) => exits.includes(w)) : []) });
  });
  return out;
}

function groupText(syms: { sym: string; rate: RateRef }[], waivers: { sym: string; rate: RateRef }[], lapseRate: number | undefined, already: RateRef[]) {
  const s = syms.map((x) => x.sym), lapse = lapseRate !== undefined;
  const legend = syms.map((x) => `${x.sym}_x : ${x.rate.name}`);
  if (waivers.length) legend.push(`${waivers.map((w) => `${w.sym}_x`).join(" · ")} : ${waivers.map((w) => w.rate.name).join(" · ")} — 납입만 면제되는 사유`);
  if (lapse) legend.push("w_x : 적용해지율 (납입기간 중)");

  const lines: string[] = ["기준 인원", "l_x = l′_x = 100,000"];
  const Q = s.length === 1 ? at(s[0]) : "Q_{x+t}";
  if (s.length > 1) lines.push("탈퇴율 — 사유가 겹치는 부분을 절반으로 본다", `Q_{x+t} = ${lossText(s)}`);
  const keep = !s.length ? "1" : lapse ? `1 − ${Q} − w_{x+t} + ${Q}·w_{x+t}/2` : `1 − ${Q}`;
  lines.push("유지자수", `l_{x+t+1} = l_{x+t} × ( ${keep} )`);
  if (waivers.length) {
    if (waivers.length > 1) lines.push("납입면제 사유", `f_{x+t} = ${lossText(waivers.map((w) => w.sym))}`);
    lines.push("납입자수", `l′_{x+t+1} = l′_{x+t} × ( ${lapse
      ? `1 − ${Q} − f_{x+t} − w_{x+t} + ( ${Q}·f_{x+t} + ${Q}·w_{x+t} + f_{x+t}·w_{x+t} )/2`
      : `1 − ${Q} − f_{x+t} + ${Q}·f_{x+t}/2`} )`);
  } else lines.push("납입자수 — 납입만 면제되는 사유가 없어 유지자수와 같다", `l′_{x+t+1} = l′_{x+t} × ( ${keep} )`);
  const note = `납입자수는 ${waivers.length ? "탈퇴 사유에 더해 f 사유가 생길 때도" : "탈퇴 사유로 유지자수와 똑같이"} 줄어든다 — 별도의 납입면제율을 곱하지 않는다.`
    + (already.length ? ` 납입면제 사유 중 ${already.map(reasonOf).join("·")} 은(는) 이 집단의 탈퇴 사유라 탈퇴로 이미 줄었다.` : "");
  return { legend, lines, note };
}

// ── 담보 ────────────────────────────────────────────────────────────────────
export interface BenefitModel {
  idx: number;
  b: BenefitSpec;
  group: GroupModel;
  /** 급부 발생률의 기호 — 탈퇴 사유이면 그 기호, 아니면 따로 준 g */
  event?: { sym: string; rate: RateRef };
  legend: string[];
  lines: string[];
  note?: string;
}

/** 면책 개월 — 계산하는 앱(자유설계보험)과 같은 환산(30.4일 = 1개월) */
export const waitMonths = (days?: number) => (days ? Math.round(days / 30.4) : 0);

/** 연령 구간 배수 → if 식. 구간이 있으면 덮이지 않은 나이는 0 배다(자유설계보험 stepMultiple 과 같다) */
function stepsText(b: BenefitSpec): string | undefined {
  if (!b.steps?.length) return undefined;
  return b.steps.reduce((acc, s) => `if( ${s.fromAge} ≤ x+t ≤ ${s.toAge}, ${s.multiple}, ${acc} )`, "0");
}

export function benefitModels(spec: MethodSpec): BenefitModel[] {
  const groups = groupModels(spec);
  return spec.benefits.map((b, idx) => {
    const group = groups.find((g) => g.benefitIdx.includes(idx))!;
    const lapse = group.lapseRate !== undefined;
    const half = lapse ? "·( 1 − w_{x+t}/2 )" : "";
    const legend: string[] = [];
    let event: BenefitModel["event"];
    if (b.role !== "death") {
      const rate = spec.rates.find((r) => r.id === b.rateId);
      const inGroup = rate ? group.syms.find((s) => s.rate === rate) : undefined;
      if (inGroup) event = inGroup;
      else if (rate) { event = { sym: "g", rate }; legend.push(`g_x : ${rate.name}`); }
    }
    const lines: string[] = [];
    // 보장금액 배수 S — 연령 구간 배수 × 면책 (첫해)
    const mo = waitMonths(b.waitDays), steps = stepsText(b);
    const survival = b.role === "other" && !!b.points?.length;
    const parts = [survival ? "0" : steps ?? "1", ...(mo && !survival ? [`if( t = 0, 1 − ${mo}/12, 1 )`] : [])];
    lines.push(mo ? `보장금액의 배수 — 면책 ${b.waitDays}일이라 첫해는 ( 1 − ${mo}/12 ) 배` : "보장금액의 배수", `S_t = ${parts.join(" × ")}`);
    // 급부 발생자
    if (b.role === "death") {
      const Q = group.syms.length === 1 ? `${group.syms[0].sym}_{x+t}` : "Q_{x+t}";
      lines.push("급부 발생자 — 탈퇴자 전부가 급부 대상이다", `C_{x+t} = l_{x+t}·${Q}${half}·v^{t+½}`);
    } else {
      lines.push("급부 발생자", `C_{x+t} = l_{x+t}·${event?.sym ?? "g"}_{x+t}${half}·v^{t+½}`);
    }
    lines.push("보험금 현가의 누계", "M_{x+t} = Σ_{u=t}^{n−1} S_u·C_{x+u}");
    if (survival) {
      lines.push("생존 지급 시점의 배수", `E_t = ${b.points!.map((p) => `if( t = ${p.age} − x, ${p.multiple}, 0 )`).join(" + ")}`,
        "보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x + Σ_{u=0}^{n} E_u·D_{x+u}");
    } else lines.push("보험금 현가 (PVB) — 보장금액 1원당", "PVB = M_x");
    const note = b.role === "death" && group.exits.length > 1
      ? `${group.exits.map(reasonOf).join("·")} 모두 같은 보험금을 지급하므로 탈퇴자 전부가 급부 대상이다.`
      : b.role === "incidence" ? "진단 확정 시 지급하고 그 담보는 소멸한다." : undefined;
    return { idx, b, group, event, legend, lines, ...(note ? { note } : {}) };
  });
}

// ── 공통 — 현가와 보험료 ─────────────────────────────────────────────────────
/** 담보마다 똑같은 식: 현가(D · N · N*)와 보험료(P · G) */
export function commonModels(spec: MethodSpec): { key: string; label: string; path: string; lines: string[]; note?: string }[] {
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const meth = isMethodExpenses(spec);
  const I = "basis.interest";
  return [
    { key: "pv:D", label: "유지자수·납입자수의 현가 (D · D′)", path: I, lines: ["D_{x+t} = l_{x+t}·v^t", "D′_{x+t} = l′_{x+t}·v^t"] },
    ...(lapse ? [{ key: "pv:W", label: "해지자의 현가 (W)", path: `${I}|basis.lapse`, lines: ["W_{x+t} = l_{x+t}·w_{x+t}·v^{t+½}"] }] : []),
    { key: "pv:N", label: "현가의 누계 (N · N′)", path: I, lines: ["N_{x+t} = Σ_{u≥t} D_{x+u}", "N′_{x+t} = Σ_{u≥t} D′_{x+u}"] },
    { key: "pv:NStar", label: "연납 환산 납입기수 (N*)", path: `${I}|expenses`,
      lines: ["N* = k · [ ( N′_x − N′_{x+m} ) − ( k−1 )/( 2·k )·( D′_x − D′_{x+m} ) ]"],
      note: "k 는 납입주기별 계수(연납 1, 6개월납 2, 3개월납 4, 월납 12)이다." },
    { key: "premium:P", label: "순보험료 (P)", path: "benefits", lines: ["P = PVB / N*"],
      note: "담보마다 그 담보의 보험금 현가 PVB 와 그 담보가 속한 집단의 N* 로 낸다. 보장금액 1원당이므로 10만원당 보험료는 × 100,000 이다." },
    { key: "premium:base", label: "기준연납순보험료", path: "benefits|expenses", lines: ["P_base = PVB / ( N′_x − N′_{x+min(n,20)} )"] },
    { key: "premium:G", label: "영업보험료", path: "expenses", lines: [meth
      ? "G = [ P + ( α_S + α_P·P_base )·D′_x/N* + β_S/k + β′·( N_{x+m} − N_{x+n} )/N* ] / ( 1 − β_G − γ )"
      : "G = [ P + α·D′_x/N* + β·( N_x − N_{x+n} )/N* ] / ( 1 − γ )"],
      note: "보장기간 n이 20년보다 짧으면 α_P는 α_P × n/20으로 줄인다. 10만원당 보험료에서 한 번만 반올림하고, 담보 보험료 = 10만원당 보험료 × (보장금액 ÷ 100,000)으로 한다." },
  ];
}

// ── 산출방법서에 실을 식 ─────────────────────────────────────────────────────
export function generateFormulas(spec: MethodSpec): FormulaSpec[] {
  const out: FormulaSpec[] = [];
  const lapse = (spec.basis.lapse ?? []).some((l) => l.rate > 0);
  const low = lapse && spec.basis.lowRatio !== undefined;
  const idx = (r: RateRef) => `rates[${spec.rates.indexOf(r)}]`;
  const groups = groupModels(spec);
  const multi = spec.benefits.length > 1;

  // 3. 탈퇴자·유지자·납입자 — 집단마다
  for (const g of groups) {
    out.push({
      section: "탈퇴자·유지자·납입자", key: `group:${g.id}`,
      // 이 집단의 담보 + 탈퇴 위험률 + (있으면) 납입면제·해지율 — 어느 조건을 골라도 이 식이 표시되게
      path: [...g.benefitIdx.map((i) => `benefits[${i}]`), ...g.exits.map(idx),
        ...(g.waivers.length ? ["basis.waiver", ...(spec.basis.waiverRateIds?.length ? ["basis.waiverRateIds"] : []), ...g.waivers.map((w) => idx(w.rate))] : []),
        ...(lapse ? ["basis.lapse"] : [])].join("|"),
      label: `유지자수·납입자수 — ${g.label}`,
      text: [...g.legend, "", ...g.lines].join("\n"),
      note: `${g.benefitIdx.map((i) => spec.benefits[i].name).join(" · ")} 담보가 이 집단을 쓴다. ${g.note}`,
    });
  }

  // 4. 보험료의 현가 · 6. 보험료의 계산 — 담보마다 같은 식
  for (const c of commonModels(spec)) {
    out.push({ section: c.key.startsWith("pv") ? "보험료의 현가" : "보험료의 계산", key: c.key, label: c.label, path: c.path,
      text: c.lines.join("\n"), ...(c.note ? { note: c.note } : {}) });
  }

  // 5. 보험금의 현가 — 담보마다
  for (const m of benefitModels(spec)) {
    out.push({
      section: "보험금의 현가", key: `benefit:${m.b.id}`,
      path: [`benefits[${m.idx}]`, ...(m.event && !m.group.syms.includes(m.event) ? [idx(m.event.rate)] : [])].join("|"),
      label: `보험금의 현가 — ${multi ? `${m.b.unit ? `${m.b.unit} ` : ""}${m.b.name}` : m.b.name}`,
      text: [...m.legend, ...(m.legend.length ? [""] : []), ...m.lines].join("\n"),
      note: [`보장금액 ${m.b.amount !== undefined ? `${Math.round(m.b.amount).toLocaleString("ko-KR")}원` : "—"}${m.b.role === "recurring" ? "/일" : ""}`
        + `${m.b.endAge ? ` · ${m.b.endAge}세까지` : ""}${m.b.waitDays ? ` · 면책 ${m.b.waitDays}일` : ""} · 집단 “${m.group.label}”.`, m.note].filter(Boolean).join(" "),
    });
  }

  // 보험료의 계산에 딸린 것 — 저해지·무해지
  if (low) out.push({ section: "보험료의 계산", key: "premium:low", label: "저해지·무해지환급형", path: "basis.lowRatio", text: [
    "납입기간 중 해지하면 돌려주는 금액의 현가",
    "CSV_t = Σ_{u≥t} W_{x+u} · ρ · ( W^표준_u + W^표준_{u+1} ) / 2",
    "저해지·무해지환급형 순보험료",
    "Ā_x = PVB + CSV_0",
    "P = Ā_x / N*",
  ].join("\n"),
    note: "ρ : 납입기간 중 해지환급금 비율(무해지 0). W^{표준} : 같은 조건의 표준형(완전 환급) 해지환급금. 적용해지율 w = 0 이면 CSV = 0 이고 보험료가 표준형과 같아진다. 납입기간 뒤(u ≥ m)에는 W = 0 이라 더해지지 않는다." });

  const dy = spec.surrender.deductionYears ?? 7;
  const ratio = spec.basis.lowRatio;
  const meth = isMethodExpenses(spec);
  out.push(
    { section: "책임준비금의 계산", key: "reserve:P", label: "준비금 산출용 순보험료", path: "basis.standardInterest",
      text: "P_β = ( PVB + CSV_0 + β′·( N_{x+m} − N_{x+n} ) ) / ( N′_x − N′_{x+m} )" },
    { section: "책임준비금의 계산", key: "reserve:V", label: "연말 책임준비금", path: "basis.standardInterest", text:
      "V_t = [ M_{x+t} + Σ_{u>t} E_u·D_{x+u} + CSV_t + β′·( N_{x+max(t,m)} − N_{x+n} ) − P_β·( N′_{x+t} − N′_{x+m} )·[t≤m] ] / D_{x+t}",
      note: "순보식에 납입 후 유지비 β′를 더한 형태. 표준준비금은 표준이율로 같은 식을 계산한다." },
    { section: "해지환급금의 계산", key: "surrender:deduct", label: "해약공제", path: "surrender",
      text: `해약공제_t = α^공제 · max( min(m,${dy}) − t, 0 ) / min(m,${dy})` },
    { section: "해지환급금의 계산", key: "surrender:alpha", label: "해약공제 기준 신계약비", path: "surrender",
      text: ["α^공제 = min( α, α^std )", ...(meth ? ["α = α_S + α_P · round₅( P_base )"] : [])].join("\n"),
      ...(meth ? { note: "영업보험료 G 에는 반올림 전 P_base 를 쓴다." } : {}) },
    { section: "해지환급금의 계산", key: "surrender:W", label: "표준형 해지환급금", path: "surrender", text: "W^표준_t = max( V_t − 해약공제_t, 0 )" },
    ...(low && ratio !== undefined ? [{ section: "해지환급금의 계산", key: "surrender:low", label: "저해지·무해지환급형 해지환급금", path: "surrender|basis.lowRatio",
      text: ["납입기간 중", `W_t = ${Math.round(ratio * 100)}% × W^표준_t`, "납입 완료 후", "W_t = W^표준_t"].join("\n") }] : []),
    { section: "해지환급금의 계산", key: "surrender:ratio", label: "환급률", path: "surrender", text: "환급률_t = W_t / 납입누계_t" },
    { section: "해지환급금의 계산", key: "surrender:paid", label: "납입누계", path: "surrender", text: "납입누계_t = min(t, m) × k × G" },
  );
  return out;
}

/**
 * 조건의 식(사용자가 따로 적은 것)을 자동 생성 식에 얹는다. 같은 절·제목이면 사용자 글이 이기고,
 * 자리(path)와 짝(key)은 자동 식의 것을 그대로 지킨다 — 고친 식도 계산(calc.ts)과 대응 표시에 그대로 쓰인다.
 */
export function withFormulas(spec: MethodSpec): MethodSpec {
  const mine = new Map(spec.formulas.map((f, i) => [`${f.section}|${f.label}`, { f, i }]));
  const used = new Set<number>();
  const auto = generateFormulas(spec).map((a) => {
    const hit = mine.get(`${a.section}|${a.label}`);
    if (!hit) return a;
    used.add(hit.i);
    return { ...a, text: hit.f.text, ...(hit.f.note !== undefined ? { note: hit.f.note } : {}), edited: true as const };
  });
  return { ...spec, formulas: [...auto, ...spec.formulas.map((f, i) => ({ ...f, path: f.path ?? `formulas[${i}]` })).filter((_, i) => !used.has(i))] };
}
