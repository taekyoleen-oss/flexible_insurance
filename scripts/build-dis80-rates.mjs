// 80% 이상 장해율 → lib/engine/data/rates-dis80.json
// 출처: MG 더블종신공제Ⅱ 위험률 시트(써미트 2014-59호, 2014.06.27)의
//       "무배당 예정 80%이상 재해장해발생율" + "무배당 예정 80%이상 질병장해발생율"
// 종신보험의 "사망 또는 80% 이상 장해" 급부에 쓴다. 원본 워크북은 회사 자료라 저장소에 넣지 않고 값만 옮긴다.
// 실행: node scripts/build-dis80-rates.mjs
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const XLSX = createRequire(import.meta.url)("xlsx");
const ROOT = "C:/Users/tklee/OneDrive - 코리안리재보험/0. 보험료 산출 방법서";
// OneDrive 한글 이름은 NFD 로 저장된다 — 훑어서 정규화해 찾는다
const pick = (dir, re) => {
  const f = readdirSync(dir).find((x) => re.test(x.normalize("NFC")));
  if (!f) throw new Error(`${dir} 에서 ${re} 를 찾지 못했습니다`);
  return join(dir, f);
};
const low = pick(ROOT, /^저해지상품$/);
const mg = pick(low, /MG 더블종신공제/);
const FILE = pick(mg, /더블수술특약엑셀\.xlsx$/);

const wb = XLSX.readFile(FILE);
const rows = XLSX.utils.sheet_to_json(wb.Sheets["위험률"], { header: 1, raw: true, defval: "" });
const head = rows[2].map((c) => String(c).replace(/\s+/g, ""));
const colOf = (re) => {
  const i = head.findIndex((c) => re.test(c));
  if (i < 0) throw new Error(`머리글 ${re} 를 찾지 못했습니다`);
  return i;
};
const cDeath = colOf(/생존사망률/), cAcc = colOf(/80%이상재해장해/), cDis = colOf(/80%이상질병장해/), cAll = colOf(/^qx\(=/);

const acc = { M: [], F: [] }, dis = { M: [], F: [] }, total = { M: [], F: [] };
for (const r of rows.slice(4)) {
  const age = r[cAcc];
  if (typeof age !== "number") break;
  if (age !== acc.M.length) throw new Error(`연령이 이어지지 않습니다: ${age}`);
  for (const [s, k] of [["M", 1], ["F", 2]]) {
    // 사망률이 1 이 되는 나이(남 110세)부터는 장해율 칸이 비어 있다 — 직전 값을 이어 쓴다(어차피 탈퇴율은 1 로 막힌다)
    const hold = (v, arr) => (v === "" || v === undefined ? (arr.at(-1) ?? 0) : Number(v));
    const a = hold(r[cAcc + k], acc[s]), d = hold(r[cDis + k], dis[s]);
    acc[s].push(a); dis[s].push(d);
    total[s].push(Math.round((a + d) * 1e9) / 1e9);
    // 워크북의 결합 탈퇴율 qx = 사망 + 재해80% + 질병80% 와 맞는지 검산 (사망률이 1 인 나이는 원본이 1 로 막아 뺀다)
    const all = r[cAll + k], death = Number(r[cDeath + k]);
    if (all !== "" && death < 1 && Math.abs(death + a + d - Number(all)) > 1e-9) throw new Error(`${age}세 ${s}: 사망+80%장해 합이 원본 qx 와 다릅니다`);
  }
}

const out = {
  meta: {
    name: "무배당 예정 80% 이상 장해율 (재해 + 질병)",
    source: "써미트 2014-59호(2014.06.27) — MG 더블종신공제Ⅱ 위험률 시트의 80%이상 재해장해발생율 + 80%이상 질병장해발생율",
    ages: [0, acc.M.length - 1],
  },
  M: total.M, F: total.F,
  accident: acc, disease: dis,
};
writeFileSync("lib/engine/data/rates-dis80.json", JSON.stringify(out) + "\n", "utf8");
console.log(`rates-dis80.json — 0~${acc.M.length - 1}세`, { 40: [total.M[40], total.F[40]], 60: [total.M[60], total.F[60]] });
