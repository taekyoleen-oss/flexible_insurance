import { colLetter } from "./sheet-formula";
import type { RateColumn, RateSheet } from "./plan-rates";

/**
 * 수식 추천. 지금 고른 칸(열·행)과 시트에 있는 다른 열을 보고 바로 쓸 수 있는 수식을 만들어 준다.
 * Python_Web_like_Excel의 스니펫 제안과 같은 역할 — 사용자는 고르기만 하면 되고, 필요하면 고쳐 쓴다.
 */
export interface Snippet {
  id: string;
  label: string;          // 버튼에 보이는 이름
  formula: string;        // 바로 넣을 수식(현재 칸 기준)
  why: string;            // 무엇에 쓰는지
  fill?: boolean;         // 아래로 채우기를 같이 권하는지
}

export interface SnippetCtx {
  sheet: RateSheet;
  col: RateColumn;
  colIdx: number;         // columns 배열 안 위치(0-based) — A열 다음이라 시트 열은 colIdx+1
  row: number;            // 0-based 행
}

const fmt = (x: number) => String(Math.round(x * 1e10) / 1e10);

/** 현재 칸 기준 추천 목록. 위에 있을수록 자주 쓰는 것 */
export function snippetsFor(ctx: SnippetCtx): Snippet[] {
  const { sheet, col, colIdx, row } = ctx;
  const R = row + 1;                       // 화면에 보이는 행 번호(1-based)
  const self = colLetter(colIdx + 1);
  const age = `A${R}`;
  const others = sheet.columns.map((c, i) => ({ c, L: colLetter(i + 1) })).filter((x) => x.c.id !== col.id);
  const death = others.find((x) => x.c.kind === "death");
  const inc = others.find((x) => x.c.kind === "incidence");
  const rec = others.find((x) => x.c.kind === "recurring");
  const first = others[0];
  const cur = Number(col.cells[row] ?? 0) || 0;
  const out: Snippet[] = [];

  if (row > 0) out.push({
    id: "carry", label: "앞 행 값 이어받기", formula: `=${self}${R - 1}`, fill: true,
    why: "바로 위 행과 같은 값을 씁니다. 아래로 채우면 끝까지 같은 값이 이어집니다 — 상수 구간을 만들 때",
  });
  out.push({
    id: "const", label: "상수로 고정", formula: `=${fmt(cur || 0.001)}`, fill: true,
    why: "이 칸부터 같은 숫자를 씁니다. 아래로 채우면 전 구간 상수",
  });
  if (first) out.push({
    id: "copy", label: `${first.c.name} 그대로`, formula: `=${first.L}${R}`, fill: true,
    why: "다른 열의 같은 행 값을 그대로 가져옵니다",
  });
  if (first) out.push({
    id: "factor", label: `${first.c.name} × 계수`, formula: `=${first.L}${R}*0.65`, fill: true,
    why: "회사 요율이 없을 때 기존 위험률에 계수를 곱해 임시로 씁니다",
  });
  if (death && inc) out.push({
    id: "sumTwo", label: `${death.c.name} + ${inc.c.name}`, formula: `=${death.L}${R}+${inc.L}${R}`, fill: true,
    why: "탈퇴율 = 사망률 + 발생률. 진단형 담보의 탈퇴 열을 한 열로 만들 때",
  });
  if (death) out.push({
    id: "waiver", label: "납입면제율 = 사망률 × 계수", formula: `=${death.L}${R}*0.5`, fill: true,
    why: "장해 발생률 표가 없을 때 사망률에 계수를 곱해 납입면제율을 만듭니다. 열 유형을 '기타', 납입면제 체크를 켜세요",
  });
  out.push({
    id: "payOnly", label: "납입기간까지만 (이후 0)", formula: `=IF(${age}<${sheet.ages[0] + 20},${first ? `${first.L}${R}` : fmt(cur || 0.001)},0)`, fill: true,
    why: "납입면제처럼 납입기간에만 있는 위험률. 나이 기준을 가입나이+납입기간으로 바꿔 쓰세요",
  });
  if (rec ?? true) out.push({
    id: "days", label: "1일 기준 → 연간 기대일수 (×365)", formula: `=${(rec ?? first)?.L ?? self}${R}*365`, fill: true,
    why: "입원율(1일 기준)을 일당형 담보가 쓰는 연간 기대 지급일수로 바꿉니다",
  });
  out.push({
    id: "cap", label: "상한 씌우기", formula: `=MIN(${first ? `${first.L}${R}` : self + (R - 1 || R)},30)`, fill: true,
    why: "연간 지급일수처럼 상한이 있는 값에 씁니다",
  });
  out.push({
    id: "ageband", label: "나이 구간별 값", formula: `=IF(${age}<50,0.0005,IF(${age}<70,0.0015,0.004))`, fill: true,
    why: "구간별 평탄 요율. 구간 나이와 값을 고쳐 쓰세요",
  });
  out.push({
    id: "slope", label: "나이에 비례해 증가", formula: `=MAX(0,0.00002*(${age}-30))`, fill: true,
    why: "표가 없을 때 쓰는 단순 선형 모형. 30세부터 나이 1세당 0.00002씩",
  });
  if (row > 0) out.push({
    id: "grow", label: "앞 행 × 증가율", formula: `=${self}${R - 1}*1.08`, fill: true,
    why: "앞 행에서 매년 8%씩 늘립니다. 기하적으로 증가하는 발생률의 간이 모형",
  });
  out.push({
    id: "roundTo", label: "자리 맞추기 (소수 6자리)", formula: `=ROUND(${first ? `${first.L}${R}` : fmt(cur || 0.001)},6)`, fill: true,
    why: "요율표 자리수에 맞춰 반올림합니다",
  });
  return out;
}

/** 새 열을 만들 때 고르는 출발점. 프리셋(기존 표) 외에 수식으로 시작하는 선택지 */
export interface ColumnRecipe { id: string; label: string; kind: RateColumn["kind"]; waiver: boolean; hint: string; cell: (ctx: { sheet: RateSheet; row: number; ages: number[] }) => string }

export const COLUMN_RECIPES: ColumnRecipe[] = [
  { id: "blank", label: "빈 열 (직접 입력)", kind: "other", waiver: false, hint: "0으로 채우고 값이나 수식을 넣습니다", cell: () => "0" },
  { id: "constant", label: "상수 열", kind: "other", waiver: false, hint: "첫 행에 값을 넣고 아래로 이어받게 합니다",
    cell: ({ row }) => (row === 0 ? "0.001" : `=${colLetter(1)}${row}`) },
  { id: "waiverFactor", label: "납입면제율 = 사망률 × 0.5", kind: "other", waiver: true, hint: "사망 열(B)에 계수를 곱해 만듭니다. 만든 뒤 계수를 고치세요",
    cell: ({ row }) => `=B${row + 1}*0.5` },
  { id: "sumExit", label: "탈퇴율 = 사망률 + 발생률", kind: "other", waiver: false, hint: "B열 + C열. 열 위치에 맞게 고쳐 쓰세요",
    cell: ({ row }) => `=B${row + 1}+C${row + 1}` },
  { id: "ageBand", label: "나이 구간별 요율", kind: "incidence", waiver: false, hint: "50세 미만·70세 미만·그 이상 3구간",
    cell: ({ row }) => `=IF(A${row + 1}<50,0.0005,IF(A${row + 1}<70,0.0015,0.004))` },
  { id: "slope", label: "나이 비례 요율", kind: "incidence", waiver: false, hint: "30세부터 나이 1세당 0.00002",
    cell: ({ row }) => `=MAX(0,0.00002*(A${row + 1}-30))` },
];
