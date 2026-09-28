// docs/rates/*.txt(사용자 제공 위험률) → lib/engine/data/rates-cancer.json, rates-cancer-hosp.json
import { readFileSync, writeFileSync } from "node:fs";

const lines = (p) => readFileSync(p, "utf8").split(/\r?\n/).slice(2).filter((l) => l.trim()).map((l) => l.trim().split(/\s+/));

// 암발생률 [경험생명표(가상)]: 연령 남 여. 남자 110·111세는 값이 없어 109세 값을 유지한다
const inc = lines("docs/rates/암발생률_2024-112호.txt");
const ages = inc.map((r) => Number(r[0]));
const M = [], F = [];
for (const r of inc) { M.push(r[1] === "-" ? M[M.length - 1] : Number(r[1])); F.push(Number(r[2])); }
const zeros = M.map(() => 0);
writeFileSync("lib/engine/data/rates-cancer.json", JSON.stringify({
  meta: { name: "경험생명표(가상) 암발생률", source: "경험생명표(가상)", ages: [ages[0], ages.at(-1)], terminal: { M: 100, F: 100 } },
  M: { q: M, f: zeros, qStd: M, fStd: zeros }, F: { q: F, f: zeros, qStd: F, fStd: zeros },
}));

// 암입원율: 연령 0세부터 행 순서(남 여). 1일 기준 입원율 → 연간 기대 입원일수 = 값 × 365
const hosp = lines("docs/rates/암입원율.txt");
writeFileSync("lib/engine/data/rates-cancer-hosp.json", JSON.stringify({
  meta: { name: "암입원율 (사용자 제공)", source: "docs/rates/암입원율.txt · 1일 기준 입원율, 연간 기대 입원일수 = 값 × 365", ages: [0, hosp.length - 1] },
  M: hosp.map((r) => Number(r[0])), F: hosp.map((r) => Number(r[1])),
}));
console.log("rates-cancer.json", M.length, "ages · rates-cancer-hosp.json", hosp.length, "ages");
