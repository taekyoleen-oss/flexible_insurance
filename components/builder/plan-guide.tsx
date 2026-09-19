"use client";
import { usePlan } from "./plan-provider";
import { Button, Card } from "@/components/ui";
import { pct, won } from "@/lib/format";
import { kindMeta, PLAN_RECIPES } from "@/lib/plan-state";
import { rateCoverage } from "@/lib/plan-rates";

const Mark = ({ ok }: { ok: boolean }) => <span className={ok ? "text-sky" : "text-[#a34a1e]"}>{ok ? "✓" : "!"}</span>;

/** 보험료를 만들려면 무엇을 넣어야 하는지 + 그 입력으로 만들 수 있는 보장 */
export function PlanGuide() {
  const { state: s, dispatch, result: r } = usePlan();

  const checks: { ok: boolean; label: string; detail: string }[] = [
    { ok: s.coverages.every((c) => c.grid.ages.length > 0 && c.grid.exit.some((x) => x > 0)),
      label: "위험률 (담보마다)", detail: "연령별 급부 발생률과 탈퇴율. 직접 입력·Excel 붙여넣기·CSV/XLSX 업로드·기존 표 불러오기 중 아무거나" },
    { ok: s.coverages.every((c) => rateCoverage(c.grid, s.age, Math.min(c.endAge, s.age + r.n - 1)).ok),
      label: "위험률 연령 범위", detail: `가입나이 ${s.age}세부터 각 담보 만기까지 덮어야 합니다. 모자라면 가장 가까운 연령 값을 이어 씁니다` },
    { ok: s.coverages.every((c) => c.amount > 0), label: "보장금액", detail: "담보마다. 일당형은 1일당 금액" },
    { ok: r.n > 0 && s.payYears > 0, label: "보험기간 · 납입기간 · 납입주기", detail: `현재 ${r.n}년 보장 · ${r.payYears}년납 · 연 ${s.freq}회` },
    { ok: s.interest > 0, label: "예정이율 · 표준이율", detail: `${pct(s.interest, 2)} / ${pct(s.standardInterest, 2)}` },
    { ok: true, label: "사업비", detail: s.expenses.model === "method" ? "산출방법서형 α_S·α_P·β_S·β_G·β′·γ" : "3이원 단순형 α·β·γ" },
    { ok: true, label: "선택: 납입면제 · 면책기간 · 저해지/무해지", detail: `납입면제 ${s.waiver ? "적용" : "미적용"} · 저해지 ${s.low.on ? `${Math.round(s.low.ratio * 100)}%, 해지율 ${pct(s.low.lapseRate)}` : "미적용"}` },
    { ok: true, label: "선택: 보험금 증액·감액", detail: "연령 구간별 배수. 구간이 없으면 전 기간 동일" },
  ];

  return (
    <Card title="입력 항목과 만들 수 있는 보장">
      <p className="text-xs text-navy/60">
        보험료는 위험률과 계약 조건만 있으면 나옵니다. 산출 순서는 산출방법서와 같습니다 —
        계산기수 → 급부 현가 → 순보험료 → 영업보험료 → 책임준비금 → 해약환급금.
      </p>

      <h3 className="mt-3 text-sm font-medium text-navy">넣어야 하는 값</h3>
      <ul className="mt-1 space-y-1 text-xs">
        {checks.map((c) => (
          <li key={c.label} className="flex gap-2">
            <Mark ok={c.ok} />
            <span><b className="font-medium text-navy/80">{c.label}</b> <span className="text-navy/55">— {c.detail}</span></span>
          </li>
        ))}
      </ul>

      <h3 className="mt-4 text-sm font-medium text-navy">급부 유형으로 만들 수 있는 보장</h3>
      <ul className="mt-1 space-y-1 text-xs text-navy/60">
        {(["incidence", "death", "daily", "survival"] as const).map((k) => {
          const m = kindMeta(k);
          return <li key={k}><b className="font-medium text-navy/80">{m.label}</b> ({m.unit}) — {m.hint}</li>;
        })}
      </ul>
      <p className="mt-1 text-xs text-navy/50">
        담보를 여러 개 얹으면 주계약 + 특약 구조가 됩니다. 담보마다 보장기간·면책·증액 구간을 따로 정할 수 있습니다.
      </p>

      <h3 className="mt-4 text-sm font-medium text-navy">예시로 시작</h3>
      <p className="mt-1 text-xs text-navy/50">누르면 지금 입력을 지우고 그 형태로 채웁니다. 가입나이·성별은 그대로 둡니다.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {PLAN_RECIPES.map((rec) => (
          <Button key={rec.id} title={`필요한 위험률: ${rec.need}`}
            onClick={() => { if (confirm(`"${rec.label}" 예시로 바꿀까요? 지금 입력한 내용은 사라집니다.`)) dispatch({ type: "load", state: rec.build(s.sex, s.age) }); }}>
            {rec.label}
          </Button>
        ))}
      </div>

      <h3 className="mt-4 text-sm font-medium text-navy">지금 구성</h3>
      <p className="mt-1 text-xs text-navy/60">
        {s.coverages.map((c) => `${c.label}(${kindMeta(c.kind).label} ${won(c.amount)}${c.kind === "daily" ? "/일" : ""}, ~${c.endAge}세)`).join(" + ")}
        {" · "}{r.n}년 보장 · {r.payYears}년납 → {s.freq === 12 ? "월" : "회"} {won(r.effective.monthlyGross)}
      </p>
    </Card>
  );
}
