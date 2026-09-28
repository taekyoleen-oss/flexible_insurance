// 1회 실행: Python_Web_like_Excel 워크북(pygrid JSON)에서 위험률표를 추출한다.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SRC = "../Python_Web_like_Excel/data/sample-workbooks/";

function sheetRows(wb, name) {
  const s = wb.sheets.find((x) => x.name === name);
  if (!s) throw new Error(`sheet ${name} not found`);
  const rows = [];
  for (const [k, c] of Object.entries(s.cells)) {
    const [r, col] = k.split(":").map(Number);
    (rows[r] ??= [])[col] = c.v;
  }
  return rows.filter(Boolean);
}
function col(rows, name) {
  const j = rows[0].indexOf(name);
  if (j < 0) throw new Error(`column ${name} not found`);
  return rows.slice(1).map((r) => Number(r[j] ?? 0));
}
function assertTerminal(t, name) {
  if (t.M.q[110] !== 1 || t.F.q[112] !== 1) throw new Error(`${name}: terminal q != 1`);
  const ages = t.M.q.length;
  for (const sx of ["M", "F"]) for (const k of ["q", "f", "qStd", "fStd"]) if (t[sx][k].length !== ages) throw new Error(`${name}: ragged ${sx}.${k}`);
}

// 암발생률·암입원율은 사용자 제공 자료(docs/rates)에서 scripts/build-cancer-rates.mjs 로 만든다

// 제7회 경험생명표 — 경영인정기보험 무배당 1504 산출과정표 위험률 시트
{
  const wb = JSON.parse(readFileSync(SRC + "premium-term.pygrid.json", "utf8"));
  const rows = sheetRows(wb, "위험률");
  const ages = col(rows, "나이");
  const set = (sx) => ({
    q: col(rows, `경험사망률_${sx}`), f: col(rows, `발생률_${sx}`),
    qStd: col(rows, `표준사망률_${sx}`), fStd: col(rows, `표준발생률_${sx}`),
  });
  const out = {
    meta: { name: "제7회 경험생명표", source: "경영인정기보험 무배당 1504 산출과정표 (Python_Web_like_Excel premium-term.pygrid.json)", ages: [ages[0], ages.at(-1)], terminal: { M: 110, F: 112 } },
    M: set("남"), F: set("여"),
  };
  assertTerminal(out, "kli7");
  mkdirSync("lib/engine/data", { recursive: true });
  writeFileSync("lib/engine/data/rates-kli7.json", JSON.stringify(out));
  console.log("rates-kli7.json", out.M.q.length, "ages");
}

// 경험생명표(가상) — 테스트 픽스처 전용(가정 세트로 등록하지 않음)
{
  const wb = JSON.parse(readFileSync(SRC + "whole-life-multi.pygrid.json", "utf8"));
  const rows = sheetRows(wb, "위험률");
  const ages = col(rows, "나이");
  const set = (sx) => { const q = col(rows, `사망률_${sx}`), f = col(rows, `장해50_${sx}`); return { q, f, qStd: q, fStd: f }; };
  const out = { meta: { name: "경험생명표(가상) (테스트 전용)", source: "whole-life-multi.pygrid.json", ages: [ages[0], ages.at(-1)], terminal: { M: 110, F: 112 } }, M: set("남"), F: set("여") };
  assertTerminal(out, "summit");
  mkdirSync("tests/fixtures", { recursive: true });
  writeFileSync("tests/fixtures/rates-summit.json", JSON.stringify(out));
  console.log("rates-summit.json", out.M.q.length, "ages");
}
