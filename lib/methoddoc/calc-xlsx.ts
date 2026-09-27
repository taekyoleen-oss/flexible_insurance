import { calcSheets, evalIndex, type CalcContract, type CalcSheet, type Node } from "./calc";
import type { MethodSpec } from "./spec";
import { cellRef, colLetter, sheetName, writeXlsx, type XCell, type XName, type XSheet } from "./xlsx";

/**
 * 보험료 계산 → 엑셀 수식이 든 .xlsx.
 *
 * **값으로 두는 것은 계약·기초율과 위험률뿐**이고, 현가율부터 유지자수·납입자수·지급자수·기수·보험료까지는
 * 모두 **엑셀 수식**으로 넣는다 — 파일만 열어도 산출 과정을 따라가고 값을 바꿔 다시 계산해 볼 수 있다.
 *
 * 수식은 산출방법서의 식(읽어 둔 것)을 그대로 옮긴 것이다:
 *   l_{x+t+1} = l_{x+t} × ( 1 − Q_{x+t} )   →   =J5*(1-I5)
 *   N_{x+t}   = Σ_{u≥t} D_{x+u}             →   =SUM(M6:M77)
 *   P         = PVB / N*                    →   =B21/B20
 * 그래서 앱이 낸 값과 엑셀이 다시 계산한 값이 같아야 한다(tests/calc-xlsx.test.ts 가 확인한다).
 */

/** 표의 첫 열(t) 이 놓이는 자리 — A·B 는 왼쪽의 계약·기초율 */
const T_COL = 3;          // D
const HEAD_ROW = 1;
const DATA_ROW = 2;       // 자료 첫 줄(엑셀 줄 번호)

interface Ctx {
  /** 계열 이름 → 표의 열 번호 */
  col: Record<string, number>;
  /** 스칼라 이름 → 엑셀에서 쓸 이름(x_age …) 또는 칸($B$20) */
  sym: Record<string, string>;
  n: number;
  m: number;
  /** 지금 세우는 줄의 t */
  t: number;
}

const OPS: Record<string, string> = { "+": "+", "−": "-", "×": "*", "/": "/", "=": "=", "≤": "<=", "≥": ">=", "<": "<", ">": ">" };
const FUNCS: Record<string, string> = { min: "MIN", max: "MAX", round: "ROUND", "round₅": "ROUND" };

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
function toExcel(node: Node, c: Ctx): string | null {
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
      return node.op === "^" ? `(${a})^(${b})` : `(${a}${OPS[node.op] ?? "+"}${b})`;
    }
    case "call": {
      const args = node.args.map((x) => toExcel(x, c));
      if (args.some((x) => x === null)) return null;
      if (node.f === "if") return `IF(${args[0]},${args[1]},${args[2] ?? 0})`;
      if (node.f === "round₅") return `ROUND(${args[0]},5)`;
      if (node.f === "round") return `ROUND(${args[0]},0)`;
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
      const i = Math.round(idx(node.idx));
      if (c.col[node.name] === undefined) return null;
      return at(c, node.name, i);
    }
  }
}

/**
 * 담보 한 장 — 왼쪽 A·B 에 계약·기초율, D 부터 한 해 한 줄의 표, 그 아래 보험료.
 * 이름(x_age · n_term · S_amt …)은 **그 장에서만** 쓴다 — 담보마다 기간·보장금액이 다르기 때문이다.
 */
function benefitSheet(s: CalcSheet, at0: number, names: XName[]): XSheet {
  const name = sheetName(s.name, "담보");
  const rows: XCell[][] = [];
  const put = (r: number, col: number, v: XCell) => { (rows[r] ??= [])[col] = v; };

  // ── 왼쪽: 계약·기초율 (값). 엑셀에서 쓸 이름도 함께 등록한다
  put(0, 0, "계약 · 기초율");
  let r = 1;
  const inputRow: Record<string, number> = {};
  for (const it of s.inputs) {
    put(r, 0, it.label + (it.note ? ` (${it.note})` : ""));
    if (it.formula) put(r, 1, { f: "1/(1+i_rate)", fmt: 3 });
    else put(r, 1, typeof it.value === "number" ? { v: it.value, fmt: it.digits === 0 ? 4 : 3 } : it.value);
    if (it.name) { names.push({ name: it.name, sheet: name, ref: `$B$${r + 1}`, local: at0 }); inputRow[it.name] = r + 1; }
    r++;
  }

  // ── 오른쪽: 표 머리 (t · 연령 · 위험률 · 현가율 · 계산기수 …)
  const col: Record<string, number> = { t: T_COL, 연령: T_COL + 1 };
  put(HEAD_ROW - 1, T_COL, "t (경과)");
  put(HEAD_ROW - 1, T_COL + 1, "연령 x+t");
  s.cols.forEach((c, i) => {
    col[c.sym] = T_COL + 2 + i;
    put(HEAD_ROW - 1, T_COL + 2 + i, `${c.sym} ${c.label}`);
  });

  // ── 보험료 블록 (왼쪽 아래) — 자리를 먼저 잡아 두어야 P 가 PVB·N* 를 가리킬 수 있다
  const sumTop = r + 1;
  const sym: Record<string, string> = { v: "v_disc", i: "i_rate", n: "n_term", m: "m_pay", k: "k_freq", x: "x_age", ρ: "0" };
  for (const k of Object.keys(inputRow)) sym[({ alphaS: "α_S", alphaP: "α_P", betaS: "β_S", betaG: "β_G", betaPrime: "β′", gamma: "γ", alpha: "α", beta: "β" } as Record<string, string>)[k] ?? k] = k;
  s.scalars.forEach((x, i) => { sym[x.sym] = `$B$${sumTop + 2 + i}`; });

  const ctx: Ctx = { col, sym, n: s.n, m: s.m, t: 0 };

  // ── 표 몸통: 위험률만 값, 나머지는 수식
  for (let t = 0; t <= s.n; t++) {
    const row = DATA_ROW - 1 + t;
    put(row, T_COL, { v: t, fmt: 1 });
    put(row, T_COL + 1, { f: `x_age+${cellRef(T_COL, DATA_ROW + t)}`, fmt: 1 });
    for (const c of s.cols) {
      const cell = col[c.sym];
      if (c.kind === "rate") { put(row, cell, { v: c.values[t] ?? 0, fmt: 3 }); continue; }
      if (c.kind === "discount") {
        put(row, cell, { f: `v_disc^(${cellRef(T_COL, DATA_ROW + t)}${c.sym.includes("½") ? "+0.5" : ""})`, fmt: 3 });
        continue;
      }
      if (!c.eq) { put(row, cell, { v: c.values[t] ?? 0, fmt: 3 }); continue; }
      if (t < c.offset) { put(row, cell, { v: c.init ?? c.values[t] ?? 0, fmt: 2 }); continue; }   // 점화식의 첫 줄(기준 인원)
      const f = toExcel(c.eq.expr, { ...ctx, t: t - c.offset });
      put(row, cell, f ? { f, fmt: 2 } : { v: c.values[t] ?? 0, fmt: 3 });
    }
  }

  // ── 보험료 — 표 아래가 아니라 왼쪽 아래(A·B)에 두어 한눈에 본다
  put(sumTop, 0, "보험료");
  s.scalars.forEach((x, i) => {
    put(sumTop + 1 + i, 0, `${x.sym} ${x.label}`);
    const f = x.eq ? toExcel(x.eq.expr, { ...ctx, t: 0 }) : null;
    put(sumTop + 1 + i, 1, f ? { f, fmt: 3 } : { v: x.value, fmt: 3 });
  });
  const last = sumTop + 1 + s.scalars.length;                   // 0부터 센 줄 → 엑셀 줄은 +1
  put(last, 0, "10만원당 보험료 (원)");
  put(last, 1, { f: `ROUND(${sym.G ?? `$B$${last}`}*100000,0)`, fmt: 4 });
  put(last + 1, 0, "담보 보험료 (원)");
  put(last + 1, 1, { f: `$B$${last + 1}*(S_amt/100000)`, fmt: 4 });
  // 첫 장(합계)이 가리킬 이름 — 이것만 통합 문서 전체에서 쓴다
  names.push({ name: `per100k_${at0}`, sheet: name, ref: `$B$${last + 1}` });
  names.push({ name: `prem_${at0}`, sheet: name, ref: `$B$${last + 2}` });

  const widths = [26, 18, 3, 7, 8, ...s.cols.map(() => 14)];
  return { name, rows: rows.map((x) => x ?? []), widths, freeze: { rows: 1, cols: T_COL + 2 } };
}

/**
 * 지금 조건·계약으로 만든 계산 과정을 엑셀 파일로.
 * 첫 장은 담보별 보험료 합계, 그 뒤로 담보마다 한 장.
 */
export function calcWorkbook(spec: MethodSpec, contract: CalcContract): Uint8Array {
  const calc = calcSheets(spec, contract);
  const names: XName[] = [];
  const good = calc.sheets.filter((s) => !s.error);
  const sheets = good.map((s, i) => benefitSheet(s, i + 1, names));      // 0번 장은 합계
  const rows: XCell[][] = [
    [spec.meta.productName || "상품", "보험료 계산 — 위험률과 계약·기초율만 값이고 나머지는 엑셀 수식입니다"],
    [],
    ["계약", `${contract.age}세 ${contract.sex === "F" ? "여" : "남"} · ${contract.payYears}년납 · ${contract.freq === 12 ? "월납" : contract.freq === 1 ? "연납" : `연 ${contract.freq}회`}`],
    [],
    ["담보", "보장기간", "납입기간", "보장금액", "10만원당", "담보 보험료"],
  ];
  for (const s of calc.sheets) {
    if (s.error) { rows.push([s.name, s.error]); continue; }
    const at0 = good.indexOf(s) + 1;
    rows.push([s.name, { v: s.n, fmt: 1 }, { v: s.m, fmt: 1 }, { v: s.amount ?? 0, fmt: 4 },
      { f: `per100k_${at0}`, fmt: 4 }, { f: `prem_${at0}`, fmt: 4 }]);
  }
  const first = 6, last = 5 + calc.sheets.length;                        // 담보 줄(엑셀 줄 번호)
  rows.push([]);
  rows.push(["합계", "", "", "", { f: `SUM(E${first}:E${last})`, fmt: 4 }, { f: `SUM(F${first}:F${last})`, fmt: 4 }]);
  return writeXlsx([{ name: "보험료", rows, widths: [26, 10, 10, 16, 12, 16] }, ...sheets], names);
}
