import { calcSheets, evalIndex, roundDigits, sheetsByUnit, type CalcContract, type CalcSheet, type Node } from "./calc";
import type { MethodSpec } from "./spec";
import { cellRef, colLetter, sheetName, writeXlsx, type XCell, type XName, type XSheet } from "./xlsx";

/**
 * 보험료 계산 → 엑셀 수식이 든 .xlsx.
 *
 * **계약 단위(주계약·특약)마다 한 장**이다. 그 단위의 담보가 모두 한 장에 나란히 들어간다 —
 * 왼쪽 A·B 에 공통 계약·기초율, D 부터 한 해 한 줄의 표(t · 연령 · 위험률 · 현가율 · 담보마다 Q·l·l′·d·D·D′·N·N′·S·C·M·V·W …),
 * 맨 오른쪽에 담보별 결과(n · m · 배수 · N* · PVB · P · G · 10만원당 · 담보 보험료 · P_β · 해약공제 신계약비)와 합계.
 *
 * **값으로 두는 것은 계약·기초율과 위험률뿐**이고, 현가율부터 유지자수·납입자수·지급자수·기수·보험료·준비금·환급금까지는
 * 모두 **엑셀 수식**으로 넣는다 — 파일만 열어도 산출 과정을 따라가고 값을 바꿔 다시 계산해 볼 수 있다.
 *
 * 수식은 산출방법서의 식(읽어 둔 것)을 그대로 옮긴 것이다:
 *   l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )   →   =(L3*(1-K3))
 *   N_{x+t}   = Σ_{u≥t} D_{x+u}             →   =SUM(O4:O75)
 *   P         = PVB / N*                    →   =($AK$9/$AK$8)
 * 그래서 앱이 낸 값과 엑셀이 다시 계산한 값이 같아야 한다(tests/calc-xlsx.test.ts 가 확인한다).
 */

/** 표의 첫 열(t) 이 놓이는 자리 — A·B 는 왼쪽의 계약·기초율 */
const T_COL = 3;          // D
const TITLE_ROW = 1;      // 담보 이름(구역 제목)
const HEAD_ROW = 2;       // 열 제목
const DATA_ROW = 3;       // 자료 첫 줄(엑셀 줄 번호)

interface Ctx {
  /** 계열 이름 → 표의 열 번호 (이 담보의 구역 + 공통 위험률·현가율 열) */
  col: Record<string, number>;
  /** 스칼라 이름 → 엑셀에서 쓸 이름(x_age …) 또는 칸($AK$5) */
  sym: Record<string, string>;
  n: number;
  m: number;
  /** 지금 세우는 줄의 t */
  t: number;
}

const OPS: Record<string, string> = { "+": "+", "−": "-", "×": "*", "/": "/", "=": "=", "≤": "<=", "≥": ">=", "<": "<", ">": ">" };
const FUNCS: Record<string, string> = { min: "MIN", max: "MAX" };

const at = (c: Ctx, sym: string, t: number) => cellRef(c.col[sym], DATA_ROW + t);
/** v^t · v^{t+½} 는 현가율 열을 가리킨다 — 그 열이 없으면 이름 v_disc 로 거듭제곱 */
const discountCol = (e: Node) =>
  e.t === "ref" && e.name === "t" ? "v^t"
    : e.t === "bin" && e.op === "+" && e.a.t === "ref" && e.a.name === "t" && e.b.t === "num" && e.b.v === 0.5 ? "v^{t+½}" : null;

/** 곱셈만으로 이어진 항들 */
function factors(node: Node): Node[] {
  return node.t === "bin" && node.op === "×" ? [...factors(node.a), ...factors(node.b)] : [node];
}

/** 식(읽어 둔 것) → 엑셀 수식. 못 옮기면 null */
export function toExcel(node: Node, c: Ctx): string | null {
  const idx = (e: Node) => evalIndex(e, { t: c.t, u: c.t, n: c.n, m: c.m });
  switch (node.t) {
    case "num": return String(node.v);
    case "neg": { const a = toExcel(node.a, c); return a && `-${a}`; }
    case "bin": {
      if (node.op === "^") {
        const d = node.a.t === "ref" && node.a.name === "v" && !node.a.idx ? discountCol(node.b) : null;
        if (d && c.col[d] !== undefined) return at(c, d, c.t);
      }
      const a = toExcel(node.a, c), b = toExcel(node.b, c);
      if (a === null || b === null) return null;
      if (node.op === "^") return `(${a})^(${b})`;
      // 계열 칸으로 나눌 때 0 이면 0 — 앱의 계산(0 으로 나누면 0)과 같게(V 의 D_{x+n} = 0 · 환급률의 납입누계_0 = 0)
      if (node.op === "/" && node.b.t === "ref" && node.b.idx) return `IF(${b}=0,0,${a}/${b})`;
      return `(${a}${OPS[node.op] ?? "+"}${b})`;
    }
    case "call": {
      const args = node.args.map((x) => toExcel(x, c));
      if (args.some((x) => x === null)) return null;
      if (node.f === "if") return `IF(${args[0]},${args[1]},${args[2] ?? 0})`;
      if (node.f.startsWith("round")) return `ROUND(${args[0]},${roundDigits(node.f)})`;
      return `${FUNCS[node.f] ?? node.f.toUpperCase()}(${args.join(",")})`;
    }
    case "sum": {
      const from = Math.round(idx(node.from)), to = Math.round(idx(node.to));
      if (to < from) return "0";
      // 몸통이 자리(u)로만 도는 계열들의 곱이면 SUM · SUMPRODUCT 로
      const fs = factors(node.body);
      const ranges = fs.map((f) => {
        if (f.t !== "ref" || !f.idx || c.col[f.name] === undefined) return null;
        const a = evalIndex(f.idx, { t: from, u: from, n: c.n, m: c.m });
        const b = evalIndex(f.idx, { t: from + 1, u: from + 1, n: c.n, m: c.m });
        if (a !== from || b !== from + 1) return null;                       // u 가 그대로 자리인 것만
        return `${colLetter(c.col[f.name])}${DATA_ROW + from}:${colLetter(c.col[f.name])}${DATA_ROW + to}`;
      });
      if (ranges.every((r) => r !== null)) return ranges.length === 1 ? `SUM(${ranges[0]})` : `SUMPRODUCT(${ranges.join(",")})`;
      return null;
    }
    case "ref": {
      if (node.idx === undefined) {
        if (node.name === "t") return at(c, "t", c.t);
        if (c.sym[node.name]) return c.sym[node.name];
        if (c.col[node.name] !== undefined) return at(c, node.name, c.t);
        return null;
      }
      if (node.name === "CSV") return "0";                     // 저해지형의 해지급부 현가 — 이 앱은 0 으로 둔다(calc.ts 와 같다)
      const i = Math.round(idx(node.idx));
      if (c.col[node.name] === undefined) return null;
      return at(c, node.name, i);
    }
  }
}

/** 담보별 결과 칸의 줄 차례 — 이름 열 + 담보마다 값 열 + 합계 */
const ALL_ROWS: { key: string; label: string; fmt: number }[] = [
  { key: "n", label: "보장기간 n (년)", fmt: 1 }, { key: "m", label: "납입기간 m (년)", fmt: 1 },
  { key: "S_mult", label: "보장금액 배수", fmt: 2 }, { key: "S_amt", label: "보장금액 (원) = 가입금액 × 배수", fmt: 4 }, { key: "α_P", label: "α_P (적용값 — n < 20 이면 × n/20)", fmt: 3 },
  { key: "α^{표준}", label: "α^표준 (표준이율로 같은 식을 계산한 신계약비 — 앱이 계산한 값)", fmt: 3 },
  { key: "N*", label: "N* 연납 환산 납입기수", fmt: 2 }, { key: "PVB", label: "PVB 보험금의 현가", fmt: 3 }, { key: "PVB′", label: "PVB′ 해지급부를 더한 현가", fmt: 3 },
  { key: "P", label: "P 순보험료 (1원당)", fmt: 3 }, { key: "P_base", label: "P_base 기준연납순보험료", fmt: 3 }, { key: "G", label: "G 영업보험료 (1원당)", fmt: 3 },
  { key: "G₁", label: "G₁ 1원당 보험료 (소수 6자리)", fmt: 3 }, { key: "G_10만", label: "10만원당 보험료 (원)", fmt: 4 }, { key: "prem", label: "담보 보험료 (원) = 10만원당 × 보장금액/10만, 10원 미만 버림", fmt: 4 },
  { key: "P_β", label: "P_β 준비금 산출용 순보험료", fmt: 3 }, { key: "α^{공제}", label: "α^공제 해약공제 기준 신계약비", fmt: 3 },
  { key: "P^{위험}", label: "P^위험 위험보험료 (기본보험료 1원당, 월) — 적립형", fmt: 3 },
];
/** 적립형의 결과 칸 — 기간 · 보장부분 순보험료(N* · PVB · P) · 위험보험료 */
const SAVINGS_ROWS = ["n", "m", "N*", "PVB", "P", "P^{위험}"];
const INPUT_NAME: Record<string, string> = { alphaS: "α_S", alphaP: "α_P", betaS: "β_S", betaG: "β_G", betaPrime: "β′", gamma: "γ", alpha: "α", beta: "β", i_std: "i_std", alphaPrime: "α′", j_pub: "j^{공시}", base_premium: "기본보험료", S_won: "보장금액" };

/**
 * 계약 단위 한 장 — 왼쪽 A·B 에 공통 계약·기초율(값), D 부터 표(위험률·현가율은 공통, 담보마다 구역), 맨 오른쪽에 결과.
 * 이름(x_age · k_freq · sum_assured …)은 **그 장에서만** 쓴다 — 단위마다 다를 수 있기 때문이다. 담보마다 다른 값(n · m · 배수)은 결과 칸을 가리킨다.
 */
function unitSheet(unit: string, sheets: CalcSheet[], at0: number, names: XName[]): XSheet {
  const name = sheetName(unit, "주계약");
  const rows: XCell[][] = [];
  const put = (r: number, col: number, v: XCell) => { (rows[r] ??= [])[col] = v; };
  const maxN = Math.max(...sheets.map((s) => s.n));
  // 적립형 — 예시마다 구역(공시이율 · 평균공시이율 · 최저보증이율), 결과 칸은 기간만(보험료 줄이 없다)
  const sav = !!sheets[0].savings;
  const RESULT_ROWS = sav ? ALL_ROWS.filter((x) => SAVINGS_ROWS.includes(x.key)) : ALL_ROWS.filter((x) => x.key !== "P^{위험}");

  // ── 왼쪽: 공통 계약·기초율 (값). 엑셀에서 쓸 이름도 함께 등록한다
  put(0, 0, `계약 · 기초율 — ${unit}`);
  let r = 1;
  const seen = new Set<string>();
  for (const it of sheets[0].inputs) {
    if (it.perBenefit || (it.name && seen.has(it.name))) continue;
    if (it.name) seen.add(it.name);
    put(r, 0, it.label + (it.note ? ` (${it.note})` : ""));
    if (it.formula) put(r, 1, { f: "1/(1+i_rate)", fmt: 3 });
    else put(r, 1, typeof it.value === "number" ? { v: it.value, fmt: it.digits === 0 ? 4 : 3 } : it.value);
    if (it.name) names.push({ name: it.name, sheet: name, ref: `$B$${r + 1}`, local: at0 });
    r++;
  }
  const rhoRow = r + 1;
  put(r, 0, "ρ 납입기간 중 해지환급금 비율 (저해지 — 표준형 0)");
  put(r, 1, { v: 0, fmt: 2 });
  names.push({ name: "rho", sheet: name, ref: `$B$${rhoRow}`, local: at0 });
  r += 2;
  put(r, 0, "값은 계약·기초율과 위험률뿐 — 현가율부터는 모두 수식입니다. 담보마다 다른 값(기간·배수)은 맨 오른쪽 결과 칸에 있습니다.");

  // ── 표 머리: t · 연령 · (공통) 위험률 · 현가율
  const col: Record<string, number> = { t: T_COL, 연령: T_COL + 1 };
  put(HEAD_ROW - 1, T_COL, "t (경과)");
  put(HEAD_ROW - 1, T_COL + 1, "연령 x+t");
  let next = T_COL + 2;
  // 위험률은 이름으로 공통 열 — 담보마다 기호(q · r · f)가 다르지만 같은 위험률이면 한 열
  const rateCol = new Map<string, number>();
  put(TITLE_ROW - 1, next, "위험률 (표에서 온 값)");
  for (const s of sheets) for (const c of s.cols) {
    if (c.kind !== "rate") continue;
    const key = c.sym === "w" ? "w" : c.label;
    if (rateCol.has(key)) continue;
    rateCol.set(key, next);
    put(HEAD_ROW - 1, next, c.sym === "w" ? "w 적용해지율" : c.label);
    for (let t = 0; t <= maxN; t++) put(DATA_ROW - 1 + t, next, { v: c.values[t] ?? 0, fmt: 3 });
    next++;
  }
  put(TITLE_ROW - 1, next, "현가율 (이율에서)");
  for (const sym of ["v^t", "v^{t+½}"]) {
    col[sym] = next;
    put(HEAD_ROW - 1, next, `${sym} 현가율`);
    for (let t = 0; t <= maxN; t++) put(DATA_ROW - 1 + t, next, { f: `v_disc^(${cellRef(T_COL, DATA_ROW + t)}${sym.includes("½") ? "+0.5" : ""})`, fmt: 3 });
    next++;
  }
  for (let t = 0; t <= maxN; t++) {
    put(DATA_ROW - 1 + t, T_COL, { v: t, fmt: 1 });
    put(DATA_ROW - 1 + t, T_COL + 1, { f: `x_age+${cellRef(T_COL, DATA_ROW + t)}`, fmt: 1 });
  }

  // ── 담보 구역 — 담보마다 Q · l · l′ · d · D · … · V · W. 결과 칸의 자리를 먼저 잡아야 식이 그 칸을 가리킬 수 있다
  const series = sheets.map((s) => s.cols.filter((c) => c.kind === "series"));
  const resultCol = next + series.reduce((a, cs) => a + cs.length + 1, 0);      // 구역마다 빈 열 하나
  const valueCol = (bi: number) => resultCol + 1 + bi;
  const rowOf = (key: string) => DATA_ROW + RESULT_ROWS.findIndex((x) => x.key === key);
  const ref = (bi: number, key: string) => `$${colLetter(valueCol(bi))}$${rowOf(key)}`;

  sheets.forEach((s, bi) => {
    const mine: Record<string, number> = { ...col };
    for (const c of s.cols) if (c.kind === "rate") mine[c.sym] = rateCol.get(c.sym === "w" ? "w" : c.label)!;
    put(TITLE_ROW - 1, next, sav ? `예시 ${bi + 1}: ${s.name}` : `담보 ${bi + 1}: ${s.name} (대상자수 ${s.group})`);
    for (const c of series[bi]) { mine[c.sym] = next; put(HEAD_ROW - 1, next, `${c.sym} ${c.label}`); next++; }
    next++;                                                                   // 구역 사이 빈 열
    const sym: Record<string, string> = { v: "v_disc", i: "i_rate", k: "k_freq", x: "x_age", ρ: "rho", n: ref(bi, "n"), m: ref(bi, "m"), "α_P": ref(bi, "α_P") };
    for (const it of s.inputs) if (it.name && !it.perBenefit && it.name !== "v_disc") sym[INPUT_NAME[it.name] ?? it.name] = it.name;
    // 적립형의 공시이율은 예시마다 다르다 — 그 값을 그대로
    if (sav) sym["j^{공시}"] = String(s.inputs.find((it) => it.name === "j_pub")?.value ?? 0);
    for (const x of RESULT_ROWS) if (!sym[x.key] && !["S_mult", "S_amt", "prem"].includes(x.key)) sym[x.key] = ref(bi, x.key);
    const ctx: Ctx = { col: mine, sym, n: s.n, m: s.m, t: 0 };
    // 표 몸통: 위험률만 값, 나머지는 수식
    for (let t = 0; t <= s.n; t++) {
      const row = DATA_ROW - 1 + t;
      for (const c of series[bi]) {
        const cell = mine[c.sym];
        if (!c.eq) { put(row, cell, { v: c.values[t] ?? 0, fmt: 3 }); continue; }
        if (t < c.offset) { put(row, cell, { v: c.init ?? c.values[t] ?? 0, fmt: 2 }); continue; }   // 점화식의 첫 줄(기준 인원)
        const f = toExcel(c.eq.expr, { ...ctx, t: t - c.offset });
        put(row, cell, f ? { f, fmt: c.sym.includes("10만") ? 4 : 2 } : { v: c.values[t] ?? 0, fmt: 3 });
      }
    }
    // 결과 칸 — 그 담보의 값 열
    const vc = valueCol(bi);
    put(HEAD_ROW - 1, vc, s.name);
    const scalar = (key: string) => s.scalars.find((x) => x.sym === key);
    for (const x of RESULT_ROWS) {
      const rr = rowOf(x.key) - 1;
      if (x.key === "n") put(rr, vc, { v: s.n, fmt: 1 });
      else if (x.key === "m") put(rr, vc, { v: s.m, fmt: 1 });
      else if (x.key === "S_mult") put(rr, vc, s.multiple !== undefined ? { v: s.multiple, fmt: 2 } : "—");
      else if (x.key === "S_amt") put(rr, vc, s.multiple !== undefined && !s.base ? { f: `sum_assured*${ref(bi, "S_mult")}`, fmt: 4 } : { v: s.amount, fmt: 4 });   // 보험료의 배수 — 정액 보장의 보험료에서 나온 값
      else if (x.key === "α_P") put(rr, vc, { v: s.inputs.find((it) => it.name === "alphaP")?.value as number ?? 0, fmt: 3 });
      else if (x.key === "α^{표준}") put(rr, vc, { v: scalar("α^{표준}")?.value ?? 0, fmt: 3 });
      else if (x.key === "prem") put(rr, vc, { f: `ROUNDDOWN(${ref(bi, "G_10만")}*${ref(bi, "S_amt")}/100000,-1)`, fmt: 4 });   // 10원 미만 버림
      else {
        const sc = scalar(x.key);
        if (!sc) { put(rr, vc, "—"); continue; }
        const f = sc.eq ? toExcel(sc.eq.expr, { ...ctx, t: 0 }) : null;
        put(rr, vc, f ? { f, fmt: x.fmt } : { v: sc.value, fmt: x.fmt });
      }
    }
  });

  // ── 결과 칸 — 이름 열과 합계
  put(TITLE_ROW - 1, resultCol, "보험료 계산 · 결과 (담보마다)");
  RESULT_ROWS.forEach((x, i) => put(DATA_ROW - 1 + i, resultCol, x.label));
  const sumCol = valueCol(sheets.length);
  put(HEAD_ROW - 1, sumCol, "합계");
  if (!sav) for (const key of ["G_10만", "prem"]) {
    const rr = rowOf(key) - 1;
    put(rr, sumCol, { f: `SUM(${cellRef(valueCol(0), rowOf(key))}:${cellRef(valueCol(sheets.length - 1), rowOf(key))})`, fmt: 4 });
  }
  if (!sav) {
    names.push({ name: `per100k_${at0}`, sheet: name, ref: `$${colLetter(sumCol)}$${rowOf("G_10만")}` });
    names.push({ name: `prem_${at0}`, sheet: name, ref: `$${colLetter(sumCol)}$${rowOf("prem")}` });
  }
  const gap = DATA_ROW - 1 + RESULT_ROWS.length + 1;
  put(gap, resultCol, sav ? "적립형 — 값은 모두 월 기본보험료 1원당입니다(원 = 값 × base_premium). 예시마다 공시이율 j_pub 만 다릅니다. N* · PVB · P 는 보장(보장금액 1원당)의 것이고 위험보험료 = 배수 × P 입니다." : "담보 보험료의 합이 이 단위의 보험료입니다. 10만원당 보험료는 담보마다 원 단위로 반올림하고, 담보 보험료는 10원 미만을 버린 뒤 더합니다.");

  const widths = [30, 16, 3, 7, 8, ...Array.from({ length: next - T_COL - 2 }, () => 13), 44, ...sheets.map(() => 16), 14];
  return { name, rows: rows.map((x) => x ?? []), widths, freeze: { rows: HEAD_ROW, cols: T_COL + 2 } };
}

/**
 * 지금 조건·계약으로 만든 계산 과정을 엑셀 파일로 — 계약 단위마다 한 장(주계약 · 특약1 …). 담보가 여럿이면 한 장에 나란히.
 */
export function calcWorkbook(spec: MethodSpec, contract: CalcContract): Uint8Array {
  const calc = calcSheets(spec, contract);
  const names: XName[] = [];
  const units = sheetsByUnit(calc).map((u) => ({ ...u, sheets: u.sheets.filter((s) => !s.error) })).filter((u) => u.sheets.length);
  const sheets = units.map((u, i) => unitSheet(u.unit, u.sheets, i, names));
  if (!sheets.length) return writeXlsx([{ name: "보험료", rows: [[spec.meta.productName || "상품", "계산할 담보가 없습니다"]] }]);
  return writeXlsx(sheets, names);
}
