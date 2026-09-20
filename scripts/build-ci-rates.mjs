// docs/rates/뇌출혈_급성심근경색증_발생률.xlsx (사용자 제공) → lib/engine/data/rates-ci.json
// 시트 한 장에 두 표가 나란히 있다: A~C = 연령·뇌출혈(남·여), E~G = 연령·급성심근경색증(남·여)
import { readFileSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";

const SRC = "docs/rates/뇌출혈_급성심근경색증_발생률.xlsx";
const wb = XLSX.read(new Uint8Array(readFileSync(SRC)), { type: "array" });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });

/** 연령 열·남·여 열 위치로 한 표를 뽑는다. 연령은 0부터 이어져야 한다 */
function pick(ageCol, mCol, fCol, label) {
  const M = [], F = [];
  for (const r of rows) {
    const a = r[ageCol], m = r[mCol];
    if (typeof a !== "number" || typeof m !== "number") continue;
    if (a !== M.length) throw new Error(`${label}: 연령이 이어지지 않습니다 (${a} 자리에 ${M.length} 기대)`);
    M.push(m);
    F.push(typeof r[fCol] === "number" ? r[fCol] : 0);
  }
  if (!M.length) throw new Error(`${label}: 값을 찾지 못했습니다`);
  return { M, F };
}

const stroke = pick(0, 1, 2, "뇌출혈");
const ami = pick(4, 5, 6, "급성심근경색증");

writeFileSync("lib/engine/data/rates-ci.json", JSON.stringify({
  meta: {
    name: "무배당 예정 뇌출혈·급성심근경색증 발생률 (사용자 제공)",
    source: `${SRC} · 시트 한 장에 두 표(연령 0부터, 남·여). 표 끝 이후 나이는 마지막 값을 이어 쓴다`,
    ages: { stroke: [0, stroke.M.length - 1], ami: [0, ami.M.length - 1] },
  },
  stroke, ami,
}));
console.log(`rates-ci.json — 뇌출혈 ${stroke.M.length}세, 급성심근경색증 ${ami.M.length}세`);
