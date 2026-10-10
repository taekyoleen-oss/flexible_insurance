import { calcSheets, roundDigits, sheetsByUnit, type CalcContract, type CalcSheet, type Node } from "./calc";
import { rateTable, type MethodSpec } from "./spec";

/**
 * 보험료 계산 → 파이썬 코드(셀 단위). 산출 과정을 **단계마다 주석과 함께** 적어 그대로 실행할 수 있다.
 *
 * 엑셀(calc-xlsx.ts)과 같은 원천 — 읽어 둔 식(CalcColumn.eq)의 AST 를 파이썬 식으로 옮긴다:
 *   l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )   →   l[t+1] = (l[t]*(1-Q[t]))
 *   N_{x+t}   = Σ_{u≥t} D_{x+u}             →   N[t] = sum(D[u] for u in range(t, n+1))
 *   P         = PVB / N*                    →   P = (PVB/Nstar)
 * 값(위험률·계약·기초율)만 자료이고 나머지는 식이다 — 파이썬이 낸 값이 앱·엑셀과 같아야 한다(tests/calc-py.test.ts 가 파이썬을 돌려 확인한다).
 * 브라우저에서는 Pyodide 로 셀을 하나씩 실행한다(components/PythonPanel.tsx).
 */
export interface PyCell { title: string; code: string }

/** 기호 → 파이썬 이름. 그리스 문자·프라임·별표·첨자·한글 이름을 알파벳 이름으로 */
const NAME_MAP: Record<string, string> = {
  "l′": "lp", "D′": "Dp", "N′": "Np", "N*": "Nstar", "PVB′": "PVB_p", "G₁": "G1", "G_10만": "G_100k", "V_10만": "V_100k",
  "P_β": "P_beta", "W^{표준}": "W_std", "V^{표준}": "V_std", "V^{결산}": "V_acc", "α^{공제}": "alpha_ded", "α^{표준}": "alpha_std", 해약공제: "deduction", 납입누계: "paid", 환급률: "refund_rate", "V^{10만}": "V_100k",
  "α_S": "alpha_S", "α_P": "alpha_P", "β_S": "beta_S", "β_G": "beta_G", "β′": "beta_prime", γ: "gamma", α: "alpha", β: "beta", ρ: "rho",
  "v^t": "vt", "v^{t+½}": "vth",
  // 적립형
  "P^{위험}": "P_risk", "E^{체결}": "E_acq", "P^{적립}": "P_save", "j^{보증}": "j_guar", "j^{공시}": "j_pub", "α′": "alpha_p", 사망보험금: "death_benefit",
};
export function pyName(sym: string): string {
  if (NAME_MAP[sym]) return NAME_MAP[sym];
  return sym.replace(/′/g, "p").replace(/\*/g, "star").replace(/\^\{\((\d+)\)\}/g, "_$1").replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080))
    .replace(/[{}^]/g, "").replace(/[^A-Za-z0-9_]/g, "_");
}

interface Ctx { series: Set<string>; scalars: Set<string>; known: Set<string> }

const OPS: Record<string, string> = { "+": "+", "−": "-", "×": "*", "/": "/", "=": "==", "≤": "<=", "≥": ">=", "<": "<", ">": ">" };

/** 자리 식 → 파이썬 식 (t · u · n · m 과 수) */
function pyIndex(node: Node): string {
  switch (node.t) {
    case "num": return String(node.v);
    case "ref": return node.name;
    case "neg": return `-(${pyIndex(node.a)})`;
    case "bin": return `(${pyIndex(node.a)}${OPS[node.op] ?? "+"}${pyIndex(node.b)})`;
    case "call": return `${node.f}(${node.args.map(pyIndex).join(", ")})`;
    default: return "0";
  }
}

/** 식(AST) → 파이썬 식. 계열은 리스트 자리, 스칼라는 이름. 0 으로 나누면 0(앱과 같다) */
export function toPython(node: Node, c: Ctx): string {
  switch (node.t) {
    case "num": return String(node.v);
    case "neg": return `-(${toPython(node.a, c)})`;
    case "bin": {
      if (node.op === "^" && node.a.t === "ref" && node.a.name === "v" && !node.a.idx) return `v**(${pyIndex(node.b)})`;
      const a = toPython(node.a, c), b = toPython(node.b, c);
      if (node.op === "^") return `(${a})**(${b})`;
      if (node.op === "/") return `div(${a}, ${b})`;
      if (["=", "≤", "≥", "<", ">"].includes(node.op)) return `(1 if ${a} ${OPS[node.op]} ${b} else 0)`;
      return `(${a}${OPS[node.op]}${b})`;
    }
    case "call": {
      const args = node.args.map((x) => toPython(x, c));
      if (node.f === "if") return `(${args[1]} if ${args[0]} else ${args[2] ?? 0})`;
      if (node.f.startsWith("round")) return `rnd(${args[0]}, ${roundDigits(node.f)})`;
      return `${node.f}(${args.join(", ")})`;
    }
    case "sum": return `sum(${toPython(node.body, c)} for ${node.v} in range(${pyIndex(node.from)}, ${pyIndex(node.to)} + 1))`;
    case "ref": {
      const nm = pyName(node.name);
      if (node.idx === undefined) return c.series.has(node.name) ? `${nm}[0]` : nm;
      if (node.name === "CSV") return "0";                      // 저해지형의 해지급부 현가 — 이 앱은 0 으로 둔다
      return `${nm}[${pyIndex(node.idx)}]`;
    }
  }
}

const PEOPLE = ["Q", "l", "l′", "d"], PV = ["D", "D′", "H", "N", "N′"], BEN = ["S", "E", "C", "M"];
const RESERVE = ["V", "V^{10만}", "V^{표준}", "V^{결산}", "해약공제", "W^{표준}", "W", "납입누계", "환급률"];
const PREM = ["N*", "PVB", "PVB′", "P", "P_base", "G", "G₁", "G_10만"];
const RES_SC = ["P_β", "α^{표준}", "α^{공제}"];

const q = (s: string) => JSON.stringify(s);
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(v));

/** 계열 정의 한 줄 → 파이썬 줄들 (주석 = 산출방법서의 식) */
function seriesLines(col: CalcSheet["cols"][number], c: Ctx): string[] {
  const nm = pyName(col.sym);
  // 저해지형의 해지급부 현가 — 앱이 0 으로 두므로(표준형 보험료·준비금) 식을 옮기지 않는다
  if (col.sym === "CSV") return [`# ${col.formula}`, `${nm} = [0.0] * (n + 1)   # 이 앱은 0 으로 둔다 — 저해지 해지급부의 값은 자유설계보험이 낸다`];
  if (!col.eq) return [`${nm} = ${JSON.stringify(col.values)}   # ${col.formula}`];
  const expr = toPython(col.eq.expr, c);
  if (col.offset) {
    // 점화식: 첫 자리는 기준 값, 그 다음부터 앞자리로
    const init = col.init ?? col.values[0] ?? 0;
    return [`# ${col.formula}`, `${nm} = [0.0] * (n + 1)`, `${nm}[0] = ${fmt(init)}`, `for t in range(n):`, `    ${nm}[t + ${col.offset}] = ${expr}`];
  }
  return [`# ${col.formula}`, `${nm} = [0.0] * (n + 1)`, `for t in range(n + 1):`, `    ${nm}[t] = ${expr}`];
}

function scalarLines(sc: CalcSheet["scalars"][number], c: Ctx): string[] {
  const nm = pyName(sc.sym);
  if (!sc.eq) return [`${nm} = ${sc.value}   # ${sc.formula}`];
  return [`# ${sc.formula}`, `${nm} = ${toPython(sc.eq.expr, c)}`];
}

/** 식이 가리키는 이름들 */
function refsOf(node: Node, out = new Set<string>()): Set<string> {
  if (node.t === "ref") { out.add(node.name); if (node.idx) refsOf(node.idx, out); }
  else if (node.t === "bin") { refsOf(node.a, out); refsOf(node.b, out); }
  else if (node.t === "neg") refsOf(node.a, out);
  else if (node.t === "call") node.args.forEach((x) => refsOf(x, out));
  else if (node.t === "sum") { refsOf(node.from, out); refsOf(node.to, out); refsOf(node.body, out); }
  return out;
}
type Col = CalcSheet["cols"][number];
const refsOfCol = (col: Col) => (col.eq ? refsOf(col.eq.expr) : new Set<string>());
/** 앞의 계열을 쓰는 계열이 뒤에 오게 — 사용자가 더한 식(F · R …)도 쓰이기 전에 정의된다 */
function inOrder(cols: Col[]): Col[] {
  const out: Col[] = [], left = [...cols];
  while (left.length) {
    const i = left.findIndex((c) => [...refsOfCol(c)].every((r) => r === c.sym || !left.some((x) => x.sym === r)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/** 담보 하나의 셀들 */
function benefitCells(s: CalcSheet, bi: number): PyCell[] {
  const c: Ctx = { series: new Set(s.cols.map((x) => x.sym)), scalars: new Set(s.scalars.map((x) => x.sym)), known: new Set() };
  const pick = (syms: string[]) => syms.map((sym) => s.cols.find((x) => x.sym === sym)).filter((x): x is CalcSheet["cols"][number] => !!x);
  // 유지자 lx(k) 의 계열(l^{(k)} · Q^{(k)} · R^{(k)} · D^{(k)} · N^{(k)}) — 유지자 단계에서 lx · Dx · Nx 까지 낸다
  const SURV = s.cols.filter((x) => x.kind === "series" && /\^\{\(\d+\)\}$/.test(x.sym)).map((x) => x.sym);
  const PEOPLE_ = [...SURV, ...PEOPLE];
  const rest = s.cols.filter((x) => x.kind === "series" && ![...PEOPLE_, ...PV, ...BEN, ...RESERVE].includes(x.sym));
  // 유지자수·납입자수 단계가 쓰는 덧붙은 계열(납입자수의 F · 급부 발생률 R …)은 그 단계로 당겨 온다
  const early = new Set<string>();
  const pull = (col: Col) => { for (const r of refsOfCol(col)) { const x = rest.find((y) => y.sym === r); if (x && !early.has(r)) { early.add(r); pull(x); } } };
  pick(PEOPLE_).forEach(pull);
  // 적용해지율 w 는 위험률 표가 아니라 조건(basis.lapse)에서 온다 — 아래 유지자수 단계에서 값으로 둔다
  const rates = s.cols.filter((x) => x.kind === "rate" && x.sym !== "w");
  const input = (name: string) => s.inputs.find((x) => x.name === name);
  const tag = `담보 ${bi + 1}. ${s.name}`;
  const rateName = (sym: string) => s.cols.find((x) => x.sym === sym)?.label ?? sym;
  const cells: PyCell[] = [];
  cells.push({ title: `${tag} — 조건과 위험률 계열`, code: [
    `# ── ${tag} (유지자: ${s.group}) ──`,
    `# 담보 하나를 독립된 소형 상품으로 본다 — 보장기간 n 과 납입기간 m 은 이 담보의 것`,
    `n = ${s.n}          # 보장기간(년) = min(보험기간, ${input("n_term")?.note ?? ""})`,
    `m = ${s.m}          # 납입기간(년) = min(납입기간, n)`,
    `S_mult = ${s.multiple ?? "None"}   # 보장금액 배수 (가입금액 대비)`,
    `S_amt = ${s.multiple !== undefined ? "sum_assured * S_mult" : String(s.amount)}   # 보장금액(원)`,
    `alpha_P = ${input("alphaP")?.value ?? 0}   # α_P 적용값 — 보장기간이 20년보다 짧으면 × n/20`,
    ...(s.inputs.some((x) => x.label === "면책·삭감") ? [`# 면책·삭감: ${input("S_amt") ? s.inputs.find((x) => x.label === "면책·삭감")?.value : ""} — 보장금액의 배수 S 에 반영된다`] : []),
    "",
    `# 위험률 계열 — 표에서 이 담보의 기간만큼 잘라 온다 (자리 t = 0 … n, 나이 x + t)`,
    ...rates.map((r) => `${pyName(r.sym)} = [rates[${q(rateName(r.sym))}].get(x + t, 0.0) for t in range(n + 1)]   # ${r.sym}: ${r.label}`),
    ...(s.cols.some((x) => x.sym === "w") ? [] : []),
    "",
    `# 현가율 — 그 해 초(v^t)와 그 해 가운데(v^{t+½}, 급부는 연중앙에 생긴다고 본다)`,
    `vt  = [v ** t for t in range(n + 1)]`,
    `vth = [v ** (t + 0.5) for t in range(n + 1)]`,
    `print(f"${tag}: n={n} m={m} 보장금액={S_amt:,.0f}원")`,
  ].join("\n") });
  const w = s.cols.find((x) => x.sym === "w");
  const peopleCode = [
    `# ── 유지자 lx(k) — 기준 인원 100,000 에서 탈퇴 사유가 생긴 만큼 줄이고 현가 Dx · 누계 Nx 까지 낸다. 이 담보의 l · 지급자수 d 는 그 lx 에서 ──`,
    ...(w ? [`w = ${JSON.stringify(w.values)}   # 적용해지율 (납입기간 중)`] : []),
    ...inOrder([...rest.filter((x) => early.has(x.sym)), ...pick(PEOPLE_)]).flatMap((col) => [...seriesLines(col, c), ""]),
    `print("t, l, d (처음 5줄)")`,
    `for t in range(5): print(t, round(l[t], 2), round(d[t], 4))`,
  ];
  cells.push({ title: `${tag} — 유지자`, code: peopleCode.join("\n") });
  cells.push({ title: `${tag} — 현가·누계와 보험금의 현가`, code: [
    `# ── 현가 D·D′ 와 누계 N·N′ (계산기수), 보장금액의 배수 S · 급부 현가 C · 누계 M ──`,
    ...inOrder(pick([...PV, ...BEN, ...rest.filter((x) => !early.has(x.sym)).map((x) => x.sym)])).flatMap((col) => [...seriesLines(col, c), ""]),
    `print(f"D[0]={D[0]:,.4f}  N[0]={N[0]:,.2f}  M[0]={M[0]:,.4f}")`,
  ].join("\n") });
  cells.push({ title: `${tag} — 보험료`, code: [
    `# ── 납입기수 N* → 순보험료 P → 기준연납순보험료 → 영업보험료 G → 1원당 6자리 → 10만원당 → 담보 보험료 ──`,
    ...s.scalars.filter((x) => PREM.includes(x.sym)).flatMap((sc) => [...scalarLines(sc, c), ""]),
    `premium = math.floor(G_100k * S_amt / 1000000 + 1e-9) * 10   # 담보 보험료(원) = 10만원당 × (보장금액 ÷ 10만), 10원 미만 버림`,
    `results.append({"name": ${q(s.name)}, "unit": ${q(s.unit)}, "n": n, "m": m, "per100k": G_100k, "premium": premium})`,
    `print(f"N*={Nstar:,.2f}  PVB={PVB:,.4f}  P={P:.10f}  G={G:.10f}  G₁={G1:.6f}  10만원당={G_100k:,.0f}원  담보 보험료={premium:,.0f}원")`,
  ].join("\n") });
  const res = pick(RESERVE);
  if (res.length) cells.push({ title: `${tag} — 책임준비금·해지환급금`, code: [
    `# ── 준비금 산출용 순보험료 P_β → 연말 책임준비금 V → 해약공제 → 해지환급금 W → 환급률 ──`,
    ...s.scalars.filter((x) => RES_SC.includes(x.sym)).flatMap((sc) => [...scalarLines(sc, c), ""]),
    ...res.flatMap((col) => [...seriesLines(col, c), ""]),
    `print("t, V(10만원당), W(10만원당), 환급률")`,
    `for t in (1, 3, 5, 10, 20, 30):`,
    `    if t <= n: print(t, V_100k[t], round(W[t] * 100000), f"{refund_rate[t]:.1%}")`,
  ].join("\n") });
  return cells;
}

/** 지금 조건·계약의 계산을 파이썬 셀로. 첫 셀이 공통 입력과 위험률 표, 마지막 셀이 합계 */
export function calcPython(spec: MethodSpec, contract: CalcContract): PyCell[] {
  const calc = calcSheets(spec, contract);
  if (spec.savings) return savingsPython(spec, contract, calc.sheets);
  const units = sheetsByUnit(calc);
  const first = calc.sheets[0];
  const sex = contract.sex === "F" ? "F" : "M";
  const input = (name: string) => first?.inputs.find((x) => x.name === name);
  const usedRates = new Set(calc.sheets.flatMap((s) => s.cols.filter((x) => x.kind === "rate" && x.sym !== "w").map((x) => x.label)));
  const tables = spec.rates.filter((r) => usedRates.has(r.name)).map((r) => {
    const t = rateTable(r, sex);
    const pairs = t ? t.ages.map((a, i) => `${a}: ${t.values[i]}`).join(", ") : "";
    return `    ${q(r.name)}: {${pairs}},   # ${r.source ?? ""}`;
  });
  const cells: PyCell[] = [{ title: "계약·기초율", code: [
    `# ${spec.meta.productName || "상품"} — 산출방법서의 식을 그대로 파이썬으로 옮긴 일괄 산출`,
    `# 셀을 위에서부터 차례로 실행한다. 값은 계약·기초율과 위험률뿐이고 나머지는 모두 식이다 — 값을 바꾸고 다시 돌리면 보험료가 바뀐다.`,
    `import math`,
    `def div(a, b):  # 0 으로 나누면 0 (산출방법서 계산기와 같다 — V 의 D_{x+n} = 0, 환급률의 납입누계_0 = 0)`,
    `    return 0 if b == 0 else a / b`,
    `def rnd(x, d=0):  # 반올림 — .5 는 올린다(엑셀 ROUND 와 같다. 파이썬 round() 는 짝수로 가서 162.5 → 162 가 된다)`,
    `    p = 10 ** d`,
    `    return math.floor(x * p + 0.5) / p if d else float(math.floor(x + 0.5))`,
    ``,
    `x = ${contract.age}            # 가입나이`,
    `sex = ${q(sex === "F" ? "여" : "남")}`,
    `sum_assured = ${contract.sumAssured ?? 1e8}   # 보험가입금액(원) — 담보 보장금액 = 가입금액 × 배수`,
    `k = ${contract.freq}            # 납입주기별 계수 (연 납입횟수: 월납 12 · 3개월납 4 · 6개월납 2 · 연납 1)`,
    `i = ${input("i_rate")?.value ?? 0}        # 적용이율`,
    `v = 1 / (1 + i)   # 현가율`,
    ...(input("i_std") ? [`i_std = ${input("i_std")!.value}   # 표준이율 — 해약공제 기준 신계약비의 표준기초율 값에`] : []),
    `rho = ${spec.basis.lowRatio ?? 0}   # 저해지·무해지 — 납입기간 중 해지환급금 비율 (표준형 0)`,
    `# 사업비 (산출방법서형)`,
    ...(first?.inputs ?? []).filter((x) => x.name && /^(alphaS|betaS|betaG|betaPrime|gamma|alpha|beta)$/.test(x.name)).map((x) => `${pyName({ alphaS: "α_S", betaS: "β_S", betaG: "β_G", betaPrime: "β′", gamma: "γ", alpha: "α", beta: "β" }[x.name!] ?? x.name!)} = ${x.value}   # ${x.label}`),
    `results = []`,
    `print(f"계약: {sex} {x}세 · 가입금액 {sum_assured:,.0f}원 · k={k} · i={i}")`,
  ].join("\n") }, { title: "위험률 표", code: [
    `# 연령 → 연 발생률 (${sex === "F" ? "여" : "남"}자 표). 조건의 위험률 표(별첨)와 같다`,
    `rates = {`, ...tables, `}`,
    `print("위험률:", ", ".join(f"{k}({len(v)}행)" for k, v in rates.items()))`,
  ].join("\n") }];
  calc.sheets.forEach((s, bi) => { if (!s.error) cells.push(...benefitCells(s, bi)); });
  cells.push({ title: "합계", code: [
    `# ── 담보 보험료의 합 (계약 단위마다) ──`,
    `for unit in dict.fromkeys(r["unit"] for r in results):`,
    `    rows = [r for r in results if r["unit"] == unit]`,
    `    print(f"{unit}: 10만원당 {sum(r['per100k'] for r in rows):,.0f}원 · ${contract.freq === 12 ? "월" : "회당"} 보험료 {sum(r['premium'] for r in rows):,.0f}원  (" + ", ".join(f"{r['name']} {r['premium']:,.0f}" for r in rows) + ")")`,
    `total = sum(r["premium"] for r in results)`,
    `print(f"합계 {total:,.0f}원")`,
    `import json; print("RESULT", json.dumps(results, ensure_ascii=False))   # 기계가 읽는 줄 — 앱의 값과 맞대어 본다`,
    ...(units.length > 1 ? [`# 주계약과 특약을 더한 것이 이 계약의 보험료다`] : []),
  ].join("\n") });
  return cells;
}

/**
 * 적립형 — 공시이율 예시마다 한 셀: 보험료의 구성 → 적용이율 → 계약자적립액 → 환급금. 마지막 줄 RESULT 에 해마다 W(원)를 찍는다(앱과 맞대어 본다)
 */
function savingsPython(spec: MethodSpec, contract: CalcContract, sheets: CalcSheet[]): PyCell[] {
  const first = sheets[0];
  const input = (name: string) => first?.inputs.find((x) => x.name === name)?.value;
  const sex = contract.sex === "F" ? "F" : "M";
  const tables = spec.rates.map((r) => {
    const t = rateTable(r, sex);
    return `    ${q(r.name)}: {${t ? t.ages.map((a, i) => `${a}: ${t.values[i]}`).join(", ") : ""}},   # ${r.source ?? ""}`;
  });
  const cells: PyCell[] = [{ title: "계약·기초율", code: [
    `# ${spec.meta.productName || "상품"} — 적립형(공시이율형). 산출방법서의 식을 그대로 파이썬으로 옮긴 일괄 산출`,
    `# 값은 모두 월 기본보험료 1원당이다 — 원 단위는 맨 뒤에 기본보험료 G 를 곱한다.`,
    `import math`,
    `def div(a, b):  # 0 으로 나누면 0 (산출방법서 계산기와 같다 — 환급률의 납입누계_0 = 0)`,
    `    return 0 if b == 0 else a / b`,
    ``,
    `x = ${contract.age}            # 가입나이`,
    `sex = ${q(sex === "F" ? "여" : "남")}`,
    `G = ${input("base_premium") ?? 300000}   # 월 기본보험료(원)`,
    `n = ${first?.n ?? 10}            # 보험기간(년) — 전기납 월납`,
    `i = ${input("i_rate") ?? 0}        # 보장부분 확정이율 — 위험보험료 할인`,
    `alpha = ${input("alpha") ?? 0}   # α 계약체결비용 (기본보험료 대비, 매월)`,
    `alpha_p = ${input("alphaPrime") ?? 0}   # α′ 계약체결비용 (그 뒤)`,
    `beta = ${input("beta") ?? 0}   # β 계약관리비용`,
    `rates = {`, ...tables, `}`,
    `results = {}`,
  ].join("\n") }];
  for (const s of sheets) {
    if (s.error) continue;
    const c: Ctx = { series: new Set(s.cols.map((x) => x.sym)), scalars: new Set(), known: new Set() };
    const rates = s.cols.filter((x) => x.kind === "rate");
    cells.push({ title: s.name, code: [
      `# ── ${s.name} — 공시이율 j^{공시} 만 바꿔 같은 식으로 ──`,
      `j_pub = ${s.inputs.find((x) => x.name === "j_pub")?.value ?? 0}`,
      ...rates.map((r) => `${pyName(r.sym)} = [rates[${q(r.label)}].get(x + t, 0.0) for t in range(n + 1)]   # ${r.sym}: ${r.label}`),
      "",
      ...inOrder(s.cols.filter((x) => x.kind === "series")).flatMap((col) => [...seriesLines(col, c), ""]),
      `results[${q(s.id)}] = [round(W[t] * G) for t in range(n + 1)]`,
      `print(${q(s.name)}, "— t, 납입누계, 계약자적립액, 환급금, 환급률")`,
      `for t in range(1, n + 1): print(t, round(paid[t] * G), round(AV[t] * G), round(W[t] * G), f"{refund_rate[t]:.1%}")`,
    ].join("\n") });
  }
  cells.push({ title: "합계", code: [`import json; print("RESULT", json.dumps(results, ensure_ascii=False))   # 기계가 읽는 줄 — 앱의 값과 맞대어 본다`].join("\n") });
  return cells;
}

/** 셀들을 한 파일로 — 내려받기·바깥 파이썬으로 돌리기 */
export const pythonScript = (cells: PyCell[]) => cells.map((c) => `# %% ${c.title}\n${c.code}`).join("\n\n\n") + "\n";
