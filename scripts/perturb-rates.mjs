// lib/engine/data/rates-*.json 의 위험률 값을 조금씩 바꾼다(2026-10-06, 사용자 요청) —
// 두 저장소가 공개라 어느 회사의 실제 위험률과도 같지 않게, 연령마다 다른 배율(대략 ±5% 안쪽, 연령을 따라 부드럽게 변함)을 곱한다.
// 0 은 0, 1(표 끝 나이의 사망률)은 1 그대로, 1 을 넘지 않게 막고 유효숫자 4자리로 둔다. 앞 나이와 같은 값(표 끝 뒤를 이어 쓴 꼬리)은 같은 값으로 둔다.
// 표마다(파일 · 경로) 배율의 물결이 다르다. 한 번만 적용한다(meta.perturbed 가 있으면 그 파일은 건너뛴다).
//   node scripts/perturb-rates.mjs   → 그다음 Studio 에서 node scripts/make-base-rates.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

const dir = new URL("../lib/engine/data/", import.meta.url);
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 10000) / 10000 * Math.PI * 2; };
const factor = (age, h) => 1 + 0.032 * Math.sin(0.41 * age + h) + 0.018 * Math.sin(0.13 * age + 2 * h + 1);
const nudge = (v, age, h) => {
  if (!v || v >= 1) return v;
  const x = Math.min(1, v * factor(age, h));
  return Number(x.toPrecision(4));
};

for (const f of readdirSync(dir).filter((x) => /^rates-.*\.json$/.test(x))) {
  const url = new URL(f, dir);
  const j = JSON.parse(readFileSync(url, "utf8"));
  if (j.meta?.perturbed) { console.log(`${f}: 이미 바꿈 — 건너뜀`); continue; }
  let n = 0;
  const walk = (o, path) => {
    if (Array.isArray(o)) {
      if (typeof o[0] === "number" && !path.startsWith("meta")) { const h = hash(`${f}:${path}`); n++; const out = []; o.forEach((v, age) => out.push(age && v === o[age - 1] ? out[age - 1] : nudge(v, age, h))); return out; }
      return o.map((x, i) => walk(x, `${path}[${i}]`));
    }
    if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v, path ? `${path}.${k}` : k)]));
    return o;
  };
  const out = walk(j, "");
  // 80% 이상 장해율 = 재해 + 질병 — 따로 흔든 두 표의 합으로 다시 맞춘다(두 앱이 합계 열과 두 열을 섞어 쓴다)
  if (f === "rates-dis80.json") for (const s of ["M", "F"]) out[s] = out.accident[s].map((a, i) => Number((a + out.disease[s][i]).toFixed(10)));
  // 이름·근거도 가상으로 — 받은 자료의 이름(무배당 예정 … · 사용자 제공)을 남기지 않는다
  const NAMES = {
    "rates-ci.json": { name: "경험생명표(가상) 뇌출혈·급성심근경색증 발생률", source: "가상 값 — 한 표에 두 위험률(연령 0부터, 남·여). 표 끝 이후 나이는 마지막 값을 이어 쓴다" },
    "rates-cancer-hosp.json": { name: "경험생명표(가상) 암입원율", source: "가상 값 — 1일 기준 입원율, 연간 기대 입원일수 = 값 × 365" },
  };
  out.meta = { ...out.meta, ...(NAMES[f] ?? {}), perturbed: "2026-10-06 — 연령마다 약 ±5% 배율을 곱한 가상 값(실제 위험률과 다르다)" };
  writeFileSync(url, JSON.stringify(out));
  console.log(`${f}: 표 ${n}개 바꿈`);
}
