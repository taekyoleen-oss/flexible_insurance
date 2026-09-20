import { describe, expect, it } from "vitest";
import { colIndex, colLetter, evaluateSheet, isFormula, refsOf, shiftRows } from "@/lib/sheet-formula";

/** 행 배열을 시트로 — grid[r][c], c = 0 은 A열(연령) */
const sheet = (grid: string[][]) => evaluateSheet({
  rows: grid.length, cols: Math.max(...grid.map((r) => r.length)),
  raw: (r, c) => grid[r]?.[c] ?? "",
});
const v = (grid: string[][]) => sheet(grid).values;
const e = (grid: string[][]) => sheet(grid).errors;

describe("열 문자", () => {
  it("A/Z/AA 왕복", () => {
    for (const i of [0, 1, 25, 26, 27, 51, 52, 701]) expect(colIndex(colLetter(i))).toBe(i);
    expect(colLetter(0)).toBe("A"); expect(colLetter(25)).toBe("Z"); expect(colLetter(26)).toBe("AA");
  });
});

describe("수식", () => {
  it("숫자 칸은 그대로, 빈 칸은 0", () => {
    expect(v([["40", "0.001", ""]])).toEqual([[40, 0.001, 0]]);
  });
  it("사칙연산·괄호·단항 마이너스", () => {
    expect(v([["40", "=(1+2)*3-4/2"]])[0][1]).toBe(7);
    expect(v([["40", "=-3+10"]])[0][1]).toBe(7);
  });
  it("A1 참조 — 같은 행 다른 열, 위 행", () => {
    const g = [["40", "0.001", "=B1*2"], ["41", "=B1", "=C1+B2"]];
    expect(v(g)[0][2]).toBe(0.002);
    expect(v(g)[1][1]).toBe(0.001);
    expect(v(g)[1][2]).toBeCloseTo(0.003, 12);
  });
  it("A열(연령)을 쓸 수 있다", () => {
    expect(v([["40", "=A1*2"]])[0][1]).toBe(80);
  });
  it("MIN·MAX·ABS·ROUND·SUM", () => {
    expect(v([["1", "=MIN(3,1,2)", "=MAX(3,1,2)", "=ABS(-5)", "=ROUND(1.23456,3)"]])[0].slice(1)).toEqual([1, 3, 5, 1.235]);
    expect(v([["1", "1"], ["2", "2"], ["3", "=SUM(B1:B2)"]])[2][1]).toBe(3);
  });
  it("IF와 비교 — 고른 가지만 계산한다(안 고른 쪽의 0 나눗셈은 무시)", () => {
    expect(v([["40", "=IF(A1<65,0.001,0)"]])[0][1]).toBe(0.001);
    expect(v([["70", "=IF(A1<65,0.001,0)"]])[0][1]).toBe(0);
    expect(v([["70", "0", "=IF(A1<65,1/B1,9)"]])[0][2]).toBe(9);
    expect(e([["70", "0", "=IF(A1<65,1/B1,9)"]])[0][2]).toBe(null);
  });
  it("0 나눗셈·모르는 함수·표 밖 참조·순환은 오류 코드로 남고 나머지는 계속 계산된다", () => {
    const g = [["40", "=1/0", "=FOO(1)", "=Z9", "=E1", "0.5"]];
    // E1(=E1 자기 참조)은 순환
    expect(e(g)[0].slice(1, 5)).toEqual(["#DIV/0!", "#NAME?", "#REF!", "#CIRC!"]);
    expect(v(g)[0][5]).toBe(0.5);
  });
  it("서로를 가리키면 둘 다 순환", () => {
    expect(e([["1", "=C1", "=B1"]])[0].slice(1)).toEqual(["#CIRC!", "#CIRC!"]);
  });
  it("문법 오류", () => {
    expect(e([["1", "=1+"]])[0][1]).toBe("#SYNTAX!");
    expect(e([["1", "=1 2"]])[0][1]).toBe("#SYNTAX!");
  });
});

describe("아래로 채우기(상대 행 참조 밀기)", () => {
  it("=B2 를 한 칸 내리면 =B3", () => {
    expect(shiftRows("=B2", 1)).toBe("=B3");
    expect(shiftRows("=B2+C2*2", 3)).toBe("=B5+C5*2");
  });
  it("$가 붙은 행은 고정", () => expect(shiftRows("=B$2+C2", 5)).toBe("=B$2+C7"));
  it("수식이 아니면 그대로", () => expect(shiftRows("0.001", 3)).toBe("0.001"));
  it("1행보다 위로는 안 간다", () => expect(shiftRows("=B2", -5)).toBe("=B1"));
  it("채운 결과가 앞 값 이어받기가 된다 (reducer와 같은 방식: 원본 행에서 i−row 만큼 민다)", () => {
    const src = 1, base = "=B1";                       // 2행에 "위 행 참조"를 넣고 아래로 채운다
    const col = ["0.004", base, ...Array.from({ length: 3 }, (_, i) => shiftRows(base, i + 1))];
    expect(col).toEqual(["0.004", "=B1", "=B2", "=B3", "=B4"]);
    void src;
    const grid = col.map((c, i) => [String(40 + i), c]);
    expect(v(grid).map((r) => r[1])).toEqual([0.004, 0.004, 0.004, 0.004, 0.004]);
  });
});

describe("보조", () => {
  it("isFormula", () => {
    expect(isFormula("=1")).toBe(true);
    expect(isFormula("=")).toBe(false);
    expect(isFormula("0.1")).toBe(false);
  });
  it("refsOf", () => expect(refsOf("=B2+AA10")).toEqual([{ r: 1, c: 1 }, { r: 9, c: 26 }]));
});
