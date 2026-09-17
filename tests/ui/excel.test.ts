import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildWorkbook, SHEETS } from "@/lib/excel";
import { evaluate, initialState, reducer } from "@/lib/state";

describe("Excel 검산 워크북", () => {
  const s = reducer(reducer(initialState(), { type: "level", age: 50, multiple: 1.5 }), { type: "addCelebration", age: 65 });
  const r = evaluate(s);
  const wb = buildWorkbook(s, r);
  const cell = (sheet: string, addr: string) => wb.Sheets[sheet][addr] as XLSX.CellObject | undefined;
  it("시트 6개, 계산기수 행 수 = n+1, 설계 스케줄 배수가 엔진과 같다", () => {
    expect(wb.SheetNames).toEqual([...SHEETS]);
    const k = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets[SHEETS[1]]);
    expect(k).toHaveLength(r.n + 1);
    expect(k[0].lx).toBe(100000);
    const sch = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets[SHEETS[5]]);
    expect(sch[10]["S_t (배수)"]).toBe(1.5);
    expect(sch[25]["C_t (축하금 배수)"]).toBe(0.15);
  });
  it("보험료 시트: 엔진 값과 검산 수식이 함께 들어 있다", () => {
    expect(cell(SHEETS[3], "B2")?.v).toBeCloseTo(r.perUnit.pvb, 9);
    expect(cell(SHEETS[3], "B2")?.f).toMatch(/^SUMPRODUCT\(/);
    expect(cell(SHEETS[3], "B3")?.f).toMatch(/^'입력·가정'!\$B\$\d+\*\(\(/);
    expect(cell(SHEETS[3], "B4")?.f).toBe("B2/B3");
    expect(cell(SHEETS[3], "B10")?.v).toBeCloseTo(r.perUnit.gross, 9);
    expect(cell(SHEETS[3], "B23")?.v).toBe(r.per100k.gross);
    expect(cell(SHEETS[3], "B32")?.v).toBe(r.monthly.gross);
  });
  it("계산기수·준비금 시트는 값이 아니라 수식이다 (캐시 값은 엔진과 같다)", () => {
    expect(cell(SHEETS[1], "E3")?.f).toBe("E2*(1-C2)");
    expect(cell(SHEETS[1], "F3")?.f).toBe("F2*(1-C2-D2+C2*D2/2)");
    expect(cell(SHEETS[1], "G2")?.f).toMatch(/^E2\*'입력·가정'!\$B\$\d+\^A2$/);
    expect(cell(SHEETS[1], "I2")?.f).toMatch(/^E2\*C2\*/);
    expect(cell(SHEETS[1], "J2")?.f).toBe(`SUM(G2:G${r.n + 2})`);
    expect(cell(SHEETS[1], "J2")?.v).toBeCloseTo(cell(SHEETS[1], "J3")!.v as number + (cell(SHEETS[1], "G2")!.v as number), 6);
    expect(cell(SHEETS[4], "E22")?.f).toMatch(/^IF\('위험률·계산기수'!G22<=0,0,\(SUMPRODUCT\(/);
    expect(cell(SHEETS[4], "G22")?.f).toBe("ROUND(E22*100000,0)");
    expect(Math.round((cell(SHEETS[4], "E22")!.v as number) * 1e5)).toBe(r.reserve100k[20]);
    expect(cell(SHEETS[4], "L22")?.f).toBe("ROUND(MAX(I22-K22,0),0)");
  });
  it("검산 수식을 JS로 재현하면 엔진 값과 같다 (SUMPRODUCT S·Cx + C·Dx)", () => {
    const k = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets[SHEETS[1]]);
    const sch = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets[SHEETS[5]]);
    let pvb = 0;
    for (let t = 0; t < r.n; t++) pvb += sch[t]["S_t (배수)"] * k[t].Cx;
    for (let t = 0; t <= r.n; t++) pvb += (sch[t]["C_t (축하금 배수)"] ?? 0) * k[t].Dx;
    expect(pvb).toBeCloseTo(r.perUnit.pvb, 6);
    const m = s.payYears;
    const nStar = 12 * ((k[0]["N'x"] - k[m]["N'x"]) - (11 / 24) * (k[0]["D'x"] - k[m]["D'x"]));
    expect(nStar).toBeCloseTo(r.perUnit.nStar, 6);
    expect(pvb / nStar).toBeCloseTo(r.perUnit.net, 12);
  });
  it("준비금 시트: 20년 행이 엔진 값과 같다", () => {
    const res = XLSX.utils.sheet_to_json<Record<string, number>>(wb.Sheets[SHEETS[4]]);
    expect(res[20]["해약환급금(표준형)"]).toBe(r.surrender.cash[20]);
    expect(res[20]["적용준비금(10만원당)"]).toBe(r.reserve100k[20]);
  });
  it("워크북을 바이너리로 쓸 수 있다", () => {
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(buf.length).toBeGreaterThan(10000);
  });
});
