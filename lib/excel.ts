import * as XLSX from "xlsx";
import { commutation, premium, reserves, riderCommutation, riderPremium, type EngineResult } from "@/lib/engine";
import { reserveRows } from "./reserve-table";
import { riderPremiums } from "./riders";
import { assumptionOf, BENEFIT_LABEL, celebrations, deathSegments, effective, PRODUCT_LABEL, tableOf, type DesignState } from "./state";

/**
 * 계리 검산용 워크북. 원본 산출과정표(기수표·P·V·W 시트)의 흐름을 그대로 Excel 수식으로 옮긴다.
 * 입력·가정 시트의 값과 위험률(q·f), 설계 배수만 상수이고, 계산기수·보험료·준비금·환급금·특약은 모두 수식이다.
 * 수식 셀에는 엔진이 계산한 값을 캐시로 함께 넣어(Excel은 열 때 다시 계산) 검산 값과 나란히 볼 수 있다.
 */
export const SHEETS = ["입력·가정", "위험률·계산기수", "표준기초 계산기수", "보험료 산출", "준비금·환급금", "설계 스케줄"] as const;

type Cell = string | number | boolean | null | { t: "n"; f: string; v?: number };
type Row = Cell[];
const fc = (f: string, v?: number): Cell => ({ t: "n", f, v });
const q = (name: string) => `'${name}'`;

function sheet(rows: Row[], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  return ws;
}

/** 입력·가정 시트: 수식이 참조하는 상수는 모두 여기 B열에 둔다. 반환값은 키 → 절대참조 */
function paramSheet(s: DesignState, r: EngineResult) {
  const a = assumptionOf(s), p = s.profile, e = a.expenses;
  const P = q(SHEETS[0]);
  const rows: Row[] = [["항목", "값", "비고"], ["작성 시각", new Date().toLocaleString("ko-KR"), `${PRODUCT_LABEL[p.product]} 앱 검산 파일 · 계산기수·보험료·준비금·환급금은 이 시트 값을 참조하는 수식`]];
  const ref: Record<string, string> = {};
  const add = (key: string, label: string, value: Cell, note = "") => { rows.push([label, value, note]); ref[key] = `${P}!$B$${rows.length}`; };
  add("sex", "성별", p.sex === "M" ? "남" : "여");
  add("age", "가입연령 x", p.age);
  add("omega", "최종연령 ω", r.omega, p.product === "cancer" ? "암보험: 100세 만기" : "종신");
  add("n", "보장기간 n", r.n, "= ω − x");
  add("S0", "기준보험금 S0 (원)", s.S0);
  add("m", "납입기간 m", s.payYears);
  add("mm", "납입 횟수/년 mm", 12);
  add("units", "단위 수 (S0 ÷ 100,000)", fc(`${ref.S0}/100000`, r.units), "10만원당 보험료에 곱한다");
  add("waiver", "납입면제 (1 = 적용)", s.waiver ? 1 : 0, "적용 시 계산기수의 f 열에 납입면제 발생률");
  add("low", "저해지 (1 = 적용)", s.lowSurrender ? 1 : 0);
  add("lowRatio", "저해지 환급 비율", a.lowSurrender.ratio, "납입기간 중 해약환급금 = 표준 × 비율");
  add("lowDisc", "저해지 보험료 인하율", a.lowSurrender.premiumDiscount);
  add("wait", "면책계수 (첫해 급부 배율)", a.waitFactor ?? 1, p.product === "cancer" ? "암 90일 면책" : "");
  add("interest", "예정이율 i", a.interest, `가정 세트 ${a.id} (${a.version})`);
  add("interestStd", "표준이율", a.standardInterest, "표준책임준비금·해약공제 기준");
  add("v", "v = 1/(1+i)", fc(`1/(1+${ref.interest})`, 1 / (1 + a.interest)));
  add("vStd", "v_std", fc(`1/(1+${ref.interestStd})`, 1 / (1 + a.standardInterest)));
  add("n20", "min(n, 20)", fc(`MIN(${ref.n},20)`, Math.min(r.n, 20)), "기준연납순보험료 분모 기간");
  if (e.model === "method") {
    add("model", "사업비 모형", "산출방법서형");
    add("alphaS", "α_S 신계약비 정액", e.alphaS, "기준보험금 비례");
    add("alphaP0", "α_P 신계약비율 (원)", e.alphaP, "기준연납순보험료 비례");
    add("alphaP", "α_P 적용 = α_P × min(n,20)/20", fc(`${ref.alphaP0}*${ref.n20}/20`, (e.alphaP * Math.min(r.n, 20)) / 20));
    add("betaS", "β_S 유지비 정액 (연)", e.betaS, "1회 납입당 β_S/mm");
    add("betaG", "β_G 유지비율", e.betaG, "영업보험료 비례");
    add("betaPrime", "β′ 납입 후 유지비", e.betaPrime);
    add("gamma", "γ 수금비율", e.gamma);
  } else {
    add("model", "사업비 모형", "3이원 단순형");
    add("alpha", "α 신계약비", e.alpha); add("beta", "β 유지비", e.beta); add("gamma", "γ 수금비", e.gamma);
  }
  rows.push([]);
  rows.push(["위험률", p.product === "cancer" ? "암발생률(생명장기제2024-112호) 단일탈퇴 · 사망 시 책임준비금 지급" : "제7회 경험생명표 (kli7) · 납입면제 이중탈퇴"]);
  rows.push(["프리셋", s.presetId], ["변경점", s.anchors.join(", ") || "없음"]);
  rows.push([], ["설계 제약", ""], ...Object.entries(s.settings.envelope).map(([k, v]) => [k, v] as Row));
  rows.push([], [`${BENEFIT_LABEL[p.product]} 구간 카드`, "배수", "연령"], ...deathSegments(s.blocks).map((b) => [`${b.fromAge}~${b.toAge}세`, b.multiple] as Row));
  rows.push(["축하금", "배수", "연령"], ...celebrations(s.blocks).map((c) => [`${c.fromAge}세`, c.multiple] as Row));
  return { ws: sheet(rows, [34, 22, 60]), ref };
}

/**
 * 계산기수 시트(원본 `기수표`): t, 연령, q, f 는 값, lx·l′x·Dx·D′x·Cx·Nx·N′x 는 수식.
 * lx_{t+1} = lx_t(1−q), l′x_{t+1} = l′x_t(1−q−f+q·f/2), Dx = lx·v^t, Cx = lx·q·v^{t+½}, Nx = Σ_{u≥t} Dx
 */
function commutationSheet(age: number, n: number, interest: number, qv: number[], fv: number[], vRef: string) {
  const k = commutation({ interest, q: qv, f: fv }, age, n);
  const header = ["t", "연령", "q", "f", "lx", "l'x", "Dx", "D'x", "Cx", "Nx", "N'x"];
  const rows: Row[] = [header];
  const last = n + 2;   // 마지막 데이터 행 번호(t = n)
  for (let t = 0; t <= n; t++) {
    const row = t + 2, prev = row - 1;
    rows.push([
      t, age + t, qv[age + t] ?? 0, fv[age + t] ?? 0,
      t === 0 ? 100000 : fc(`E${prev}*(1-C${prev})`, k.lx[t]),
      t === 0 ? 100000 : fc(`F${prev}*(1-C${prev}-D${prev}+C${prev}*D${prev}/2)`, k.lxp[t]),
      fc(`E${row}*${vRef}^A${row}`, k.Dx[t]),
      fc(`F${row}*${vRef}^A${row}`, k.Dpx[t]),
      fc(`E${row}*C${row}*${vRef}^(A${row}+0.5)`, k.Cx[t]),
      fc(`SUM(G${row}:G${last})`, k.Nx[t]),
      fc(`SUM(H${row}:H${last})`, k.Npx[t]),
    ]);
  }
  return { ws: sheet(rows, header.map(() => 14)), k };
}

export function buildWorkbook(s: DesignState, r: EngineResult): XLSX.WorkBook {
  const a = assumptionOf(s), p = s.profile, rs = tableOf(p)[p.sex], e = a.expenses;
  const eff = effective(r, s.payYears);
  const wb = XLSX.utils.book_new();
  const zero = new Array<number>(rs.q.length).fill(0);
  const n = r.n, m = s.payYears;

  // 1. 입력·가정
  const { ws: wsIn, ref } = paramSheet(s, r);
  XLSX.utils.book_append_sheet(wb, wsIn, SHEETS[0]);

  // 2·3. 계산기수(적용·표준)
  const K = q(SHEETS[1]), KS = q(SHEETS[2]), SCH = q(SHEETS[5]), PR = q(SHEETS[3]);
  const k1 = commutationSheet(p.age, n, a.interest, rs.q, s.waiver ? rs.f : zero, ref.v);
  XLSX.utils.book_append_sheet(wb, k1.ws, SHEETS[1]);
  const k2 = commutationSheet(p.age, n, a.standardInterest, rs.qStd, s.waiver ? rs.fStd : zero, ref.vStd);
  XLSX.utils.book_append_sheet(wb, k2.ws, SHEETS[2]);

  // 행 번호: 계산기수·스케줄 시트는 2행부터 t=0
  const first = 2, lastS = first + n - 1, lastC = first + n, mRow = first + m, n20Row = first + Math.min(n, 20), nRow = first + n;

  // 4. 보험료 산출 — 원본 P 시트. 모든 항목이 수식(엔진 값은 C열)
  // 표준기초 값과 1단위 준비금은 compute()가 밖으로 내지 않으므로 같은 엔진 함수로 다시 구한다(캐시 값)
  const cWait = { age: p.age, termYears: n, payYears: m, freq: 12, S: r.S.map((v, t) => (t === 0 ? v * (a.waitFactor ?? 1) : v)), C: r.C };
  const eS = e.model === "method" && n < 20 ? { ...e, alphaP: (e.alphaP * n) / 20 } : e;
  const pApp = premium(k1.k, cWait, eS), pStd = premium(k2.k, cWait, eS);
  const V = reserves(k1.k, cWait, eS, pApp), Vs = reserves(k2.k, cWait, eS, pStd);
  const stdPvb = pStd.pvb, stdBase = pStd.base, stdN = pStd.nStar, stdPBeta = pStd.pBeta;
  const pvbF = (KK: string) => `SUMPRODUCT(${SCH}!E${first}:E${lastS},${KK}!I${first}:I${lastS})+SUMPRODUCT(${SCH}!D${first}:D${lastC},${KK}!G${first}:G${lastC})`;
  const nStarF = (KK: string) => `${ref.mm}*((${KK}!K${first}-${KK}!K${mRow})-(${ref.mm}-1)/(2*${ref.mm})*(${KK}!H${first}-${KK}!H${mRow}))`;
  const baseF = (KK: string) => `B2/(${KK}!K${first}-${KK}!K${n20Row})`;
  const pu = r.perUnit;
  const rows: Row[] = [["항목", "Excel 수식 (검산)", "엔진 값", "설명"]];
  const put = (label: string, f: string, v: number, note = "") => rows.push([label, fc(f, v), v, note]);
  // 2~
  put("급부 현가 PVB", pvbF(K), pu.pvb, "Σ S_t(산출)·Cx + Σ C_t·Dx  (설계 스케줄 E·D열 × 계산기수 I·G열)");               // B2
  put("월납 보정 납입기수 N*", nStarF(K), pu.nStar, "mm[(N′0 − N′m) − (mm−1)/(2mm)(D′0 − D′m)]");                    // B3
  put("순보험료 P (1단위·월)", "B2/B3", pu.net, "PVB / N*");                                                           // B4
  put("기준연납순보험료", baseF(K), pu.base, "PVB / (N′0 − N′min(n,20))");                                             // B5
  if (e.model === "method") {
    put("신계약비 α (1단위)", `${ref.alphaS}+${ref.alphaP}*ROUND(B5,5)`, pu.alpha, "α_S + α_P·round5(기준연납)");        // B6
    put("부가 α (1회 납입)", `(${ref.alphaS}+${ref.alphaP}*B5)*${K}!H${first}/B3`, pu.loading.alpha, "(α_S + α_P·기준연납)·D′0 / N*");   // B7
    put("부가 β_S", `${ref.betaS}/${ref.mm}`, pu.loading.betaS, "β_S / mm");                                            // B8
    put("부가 β′", `${ref.betaPrime}*(${K}!J${mRow}-${K}!J${nRow})/B3`, pu.loading.betaPrime, "β′(N_m − N_n) / N*");      // B9
    put("영업보험료 G (1단위·월)", `(B4+B7+B8+B9)/(1-${ref.betaG}-${ref.gamma})`, pu.gross, "(P + α + β_S + β′) / (1 − β_G − γ)");   // B10
    put("β′ 포함 연납순보험료 P_β", `(B2+${ref.betaPrime}*(${K}!J${mRow}-${K}!J${nRow}))/(${K}!K${first}-${K}!K${mRow})`, pu.pBeta, "준비금용");   // B11
  } else {
    put("신계약비 α (1단위)", `${ref.alpha}`, pu.alpha, "3이원 α");
    put("부가 α (1회 납입)", `${ref.alpha}*${K}!H${first}/B3`, pu.loading.alpha, "α·D′0 / N*");
    put("부가 β", `${ref.beta}*(${K}!J${first}-${K}!J${nRow})/B3`, pu.loading.betaS, "β(N_0 − N_n) / N*");
    put("(사용 안 함)", "0", 0);
    put("영업보험료 G (1단위·월)", `(B4+B7+B8)/(1-${ref.gamma})`, pu.gross, "(P + α + β) / (1 − γ)");
    put("연납순보험료 P_β", `B2/(${K}!K${first}-${K}!K${mRow})`, pu.pBeta, "준비금용");
  }
  rows.push([]);                                                                                                        // 12
  rows.push(["표준기초 (표준이율·표준위험률)", "", "", "해약공제·표준준비금용"]);                                          // 13
  put("PVB (표준)", pvbF(KS), stdPvb);                                                                                   // B14
  put("N* (표준)", nStarF(KS), stdN);                                                                                    // B15
  put("기준연납순보험료 (표준)", `B14/(${KS}!K${first}-${KS}!K${n20Row})`, stdBase);                                       // B16
  if (e.model === "method") {
    put("신계약비 α (표준)", `${ref.alphaS}+${ref.alphaP}*ROUND(B16,5)`, pu.alphaStd);                                     // B17
    put("P_β (표준)", `(B14+${ref.betaPrime}*(${KS}!J${mRow}-${KS}!J${nRow}))/(${KS}!K${first}-${KS}!K${mRow})`, stdPBeta);   // B18
  } else {
    put("신계약비 α (표준)", `${ref.alpha}`, pu.alphaStd);
    put("P_β (표준)", `B14/(${KS}!K${first}-${KS}!K${mRow})`, stdPBeta);
  }
  rows.push([]);                                                                                                        // 19
  rows.push(["10만원당 (원, 반올림)", "", "", "엔진과 같이 ROUND(×100,000)"]);                                             // 20
  put("순보험료", "ROUND(B4*100000,0)", r.per100k.net);                                                                   // B21
  put("기준연납순보험료", "ROUND(B5*100000,0)", r.per100k.base);                                                          // B22
  put("영업보험료", "ROUND(B10*100000,0)", r.per100k.gross);                                                              // B23
  put("신계약비 산출", "ROUND(B6*100000,0)", r.per100k.alpha);                                                            // B24
  put("신계약비 표준", "ROUND(B17*100000,0)", r.per100k.alphaStd);                                                        // B25
  put("해약공제 기준 신계약비", "MIN(B24,B25)", r.per100k.newBiz, "min(산출, 표준)");                                       // B26
  put("저해지 영업보험료 (10만원당)", `IF(${ref.low}=1,ROUND(B23*(1-${ref.lowDisc}),0),B23)`, eff.gross100k, "저해지면 (1 − 인하율)");   // B27
  rows.push([]);                                                                                                        // 28
  rows.push(["가입금액 기준 (원)", "", "", "10만원당 × 단위 수"]);                                                          // 29
  put("월 순보험료", `B21*${ref.units}`, r.monthly.net);                                                                  // B30
  put("월 영업보험료 (표준형)", `B23*${ref.units}`, r.monthly.gross);                                                       // B31
  put("월 영업보험료 (고객 납입)", `B27*${ref.units}`, eff.monthly);                                                       // B32
  put("총 납입보험료", `B32*${ref.mm}*${ref.m}`, eff.totalPaid);                                                          // B33
  rows.push([]);                                                                                                        // 34
  rows.push(["부가보험료 분해 (1회 납입, 원)", "", "", "1단위당 부가 × S0"]);                                               // 35
  put("α", `B7*${ref.S0}`, r.loading.alpha);                                                                             // B36
  put("β_S", `B8*${ref.S0}`, r.loading.betaS);                                                                            // B37
  put("β′", `B9*${ref.S0}`, r.loading.betaPrime);                                                                         // B38
  put("β_G", e.model === "method" ? `${ref.betaG}*B10*${ref.S0}` : "0", r.loading.betaG);                                  // B39
  put("γ", `${ref.gamma}*B10*${ref.S0}`, r.loading.gamma);                                                                // B40
  XLSX.utils.book_append_sheet(wb, sheet(rows, [34, 26, 22, 56]), SHEETS[3]);

  // 5. 준비금·환급금 — 원본 V·W 시트. 행마다 수식
  const rr = reserveRows(s, r);
  const hdr = ["경과년 t", "연령", BENEFIT_LABEL[p.product], "축하금", "V_t (1단위, 적용)", "V_t (1단위, 표준)", "적용준비금(10만원당)", "표준준비금(10만원당)", "적용준비금(원)", "표준준비금(원)", "해약공제(원)", "해약환급금(표준형)", "해약환급금(고객)", "납입누계", "환급률", "사업비(연)", "엔진 적용준비금(10만)", "엔진 해약환급금(고객)"];
  const resRows: Row[] = [hdr];
  const bpRef = e.model === "method" ? ref.betaPrime : "0";
  const k7 = Math.min(m, 7);
  for (let t = 0; t <= n; t++) {
    const row = t + 2, tRow = first + t;
    const Vf = (KK: string, pbeta: string) => {
      const death = t < n ? `SUMPRODUCT(${SCH}!E${tRow}:E${lastS},${KK}!I${tRow}:I${lastS})` : "0";
      const surv = t + 1 <= n ? `SUMPRODUCT(${SCH}!D${tRow + 1}:D${lastC},${KK}!G${tRow + 1}:G${lastC})` : "0";
      const maint = `${bpRef}*(INDEX(${KK}!J:J,MAX(${tRow},${mRow}))-${KK}!J${nRow})`;
      const income = t <= m ? `${pbeta}*(${KK}!K${tRow}-${KK}!K${mRow})` : "0";
      return `IF(${KK}!G${tRow}<=0,0,(${death}+${surv}+${maint}-${income})/${KK}!G${tRow})`;
    };
    resRows.push([
      t, p.age + t,
      fc(`${SCH}!F${Math.min(tRow, lastS)}`, rr[t].benefit), fc(`${SCH}!G${tRow}`, rr[t].celebration),
      fc(Vf(K, `${PR}!B11`), V[t]), fc(Vf(KS, `${PR}!B18`), Vs[t]),
      fc(`ROUND(E${row}*100000,0)`, r.reserve100k[t]), fc(`ROUND(F${row}*100000,0)`, r.reserveStd100k[t]),
      fc(`G${row}*${ref.units}`, rr[t].reserve), fc(`H${row}*${ref.units}`, rr[t].reserveStd),
      fc(`${PR}!B26*${ref.units}*MAX(${k7}-A${row},0)/${k7}`, r.surrender.deduction[t]),
      fc(`ROUND(MAX(I${row}-K${row},0),0)`, r.surrender.cash[t]),
      fc(`IF(AND(${ref.low}=1,A${row}<${ref.m}),ROUND(L${row}*${ref.lowRatio},0),L${row})`, eff.cash[t]),
      fc(`MIN(A${row},${ref.m})*${ref.mm}*${PR}!B32`, eff.paid[t]),
      fc(`IF(N${row}>0,M${row}/N${row},0)`, eff.rate[t]),
      t < n ? fc(t < m ? `${ref.mm}*(${PR}!B37+${PR}!B39+${PR}!B40)${t === 0 ? `+${PR}!B6*${ref.S0}` : ""}` : `${bpRef}*${ref.S0}`, r.expenseFlow[t]) : null,
      r.reserve100k[t], eff.cash[t],
    ]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(resRows, hdr.map(() => 16)), SHEETS[4]);

  // 6. 설계 스케줄: S_t·C_t 는 설계값(상수), 산출용 S_t 는 면책 반영 수식, 금액은 S0 참조 수식
  const schRows: Row[] = [["t", "연령", "S_t (배수)", "C_t (축하금 배수)", "S_t (산출, 첫해 면책 반영)", `${BENEFIT_LABEL[p.product]}(원)`, "축하금(원)"]];
  for (let t = 0; t <= n; t++) {
    const row = t + 2;
    schRows.push([t, p.age + t, t < n ? r.S[t] : null, r.C[t] ?? 0,
      t < n ? fc(t === 0 ? `C${row}*${ref.wait}` : `C${row}`, t === 0 ? r.S[0] * (a.waitFactor ?? 1) : r.S[t]) : null,
      t < n ? fc(`C${row}*${ref.S0}`, r.S[t] * s.S0) : null, fc(`D${row}*${ref.S0}`, (r.C[t] ?? 0) * s.S0)]);
  }
  XLSX.utils.book_append_sheet(wb, sheet(schRows, [6, 8, 14, 16, 22, 18, 14]), SHEETS[5]);

  // 7. 특약(부가된 것만): 특약별 계산기수·보험료 수식
  for (const rd of riderPremiums(s).filter((x) => x.on)) {
    const name = `특약·${rd.label}`.slice(0, 31);
    const nr = rd.termYears;
    const k = riderCommutation({ interest: a.interest, exit: rd.exit, event: rd.event }, p.age, nr);
    const pr = riderPremium(k, p.age, rd.payYears, 12, e, rd.wait);
    const head: Row[] = [
      ["항목", "값", "비고"],
      ["특약", rd.label, `${rd.kind === "daily" ? "1일당" : "정액"} · 보험기간 ${nr}년(100세) · 납입 ${rd.payYears}년`],
      ["보장금액 (원)", rd.amount, rd.kind === "daily" ? "1일당" : ""],
      ["면책계수 (첫해)", rd.wait],
      ["위험률", rd.note],
      ["급부 현가 PVB", fc(`SUM(G12:G${12 + nr - 1})-(1-B4)*G12`, pr.pvb), "Σ_{t<n} Cx − (1 − 면책)·Cx0"],
      ["N*", fc(`${ref.mm}*((H12-H${12 + rd.payYears})-(${ref.mm}-1)/(2*${ref.mm})*(F12-F${12 + rd.payYears}))`, pr.nStar), "납입 집단 = 급부 집단 (N′ = N, D′ = D)"],
      ["순보험료 P", fc("B6/B7", pr.net)],
      ["영업보험료 G (1단위·월)", fc(e.model === "method"
        ? `(B8+(${ref.alphaS}+${ref.alphaP0}*MIN(${nr},20)/20*B6/(H12-H${12 + Math.min(nr, 20)}))*F12/B7+${ref.betaS}/${ref.mm}+${ref.betaPrime}*(H${12 + rd.payYears}-H${12 + nr})/B7)/(1-${ref.betaG}-${ref.gamma})`
        : `(B8+${ref.alpha}*F12/B7+${ref.beta}*(H12-H${12 + nr})/B7)/(1-${ref.gamma})`, pr.gross), "주계약과 같은 사업비 구조 (α_P 는 n<20이면 n/20 배)"],
      ["월 보험료 (원)", fc(`ROUND(B9*100000,0)*B3/100000`, rd.monthly), "10만원당 반올림 × 단위"],
      ["t", "연령", "탈퇴율 exit", "발생률 event", "lx", "Dx", "Cx", "Nx"],
    ];
    const body: Row[] = [];
    const lastR = 12 + nr;
    for (let t = 0; t <= nr; t++) {
      const row = 12 + t, prev = row - 1;
      body.push([t, p.age + t, rd.exit[p.age + t] ?? 0, rd.event[p.age + t] ?? 0,
        t === 0 ? 100000 : fc(`E${prev}*MAX(0,1-C${prev})`, k.lx[t]),
        fc(`E${row}*${ref.v}^A${row}`, k.Dx[t]), fc(`E${row}*D${row}*${ref.v}^(A${row}+0.5)`, k.Cx[t]), fc(`SUM(F${row}:F${lastR})`, k.Nx[t])]);
    }
    XLSX.utils.book_append_sheet(wb, sheet([...head, ...body], [22, 16, 14, 14, 14, 14, 14, 14]), name);
  }
  return wb;
}

/** 브라우저에서 .xlsx 다운로드 */
export function downloadWorkbook(s: DesignState, r: EngineResult, filename: string): void {
  XLSX.writeFile(buildWorkbook(s, r), filename, { compression: true });
}
