"use client";
import { useRouter } from "next/navigation";
import { useDesign } from "@/components/design-provider";
import { LibraryPanel } from "@/components/library-panel";
import { Button, Card } from "@/components/ui";
import { won } from "@/lib/format";
import { buildSample, SAMPLES } from "@/lib/samples";
import { effective, PRODUCT_LABEL } from "@/lib/state";

export default function Home() {
  const { state, dispatch, loaded, result } = useDesign();
  const router = useRouter();
  const hasSaved = loaded && state.updatedAt > 0;
  return (
    <div className="space-y-10">
      <section className="max-w-2xl">
        <h1 className="font-display text-3xl text-navy">보험금을 인생 곡선에 맞춰 직접 설계합니다</h1>
        <p className="mt-2 text-navy/70">지금까지는 보험사가 정한 보험금 구조에 계약자가 보험료를 맞췄습니다. 이 상품은 반대로, 계약자가 자녀 독립·부채 상환·은퇴·상속 시점에 맞춰 연령별 보험금을 직접 정하고 보험료·준비금·해약환급금을 바로 확인합니다. 프리셋은 근거 있는 출발점이고, 최종 모양은 계약자가 그립니다.</p>
        {hasSaved && <div className="mt-5"><Button primary onClick={() => router.push("/design")}>이어서 설계 ({PRODUCT_LABEL[state.profile.product]} · {state.profile.age}세 {state.profile.sex === "M" ? "남" : "여"} · 월 {won(effective(result, state.payYears).monthly)})</Button></div>}
      </section>
      <section>
        <h2 className="mb-3 font-display text-xl text-navy">상품을 고르고 새 설계를 시작합니다</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {([
            ["whole", "종신보험", "사망보험금을 연령별로 설계합니다. 종신 보장, 제7회 경험생명표·납입면제 이중탈퇴, 저해지환급형(납입기간 중 환급금 70%·해지율 3%) 선택.", "기준 사망보험금 1억"],
            ["cancer", "암보험", "암진단보험금을 연령별로 설계합니다. 100세 만기, 암발생률 기준 산출, 사망 시에는 책임준비금을 지급합니다(90일 면책은 첫해 급부 3/4로 반영). 무해지환급형(납입기간 중 환급금 없음·해지율 3%) 선택.", "기준 암진단보험금 1억"],
          ] as const).map(([id, name, desc, base]) => (
            <Card key={id} className="flex flex-col" title={<span className="flex items-center justify-between gap-2">{name}<span className="rounded bg-navy/5 px-2 py-0.5 font-sans text-xs font-normal text-navy/70">{base}</span></span>}>
              <p className="text-sm text-navy/70">{desc}</p>
              <p className="mb-3 mt-1 text-xs text-navy/50">프리셋·그래프 편집·추가 조건·검증·산출은 두 상품이 같습니다.</p>
              <Button primary className="mt-auto self-start" onClick={() => { if (hasSaved && !confirm("현재 설계를 지우고 새로 시작합니다. 보관함에 저장하지 않은 설계는 사라집니다.")) return; dispatch({ type: "reset", product: id }); router.push("/design"); }}>{name} 설계 시작</Button>
            </Card>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-3 font-display text-xl text-navy">일반 상품 산출</h2>
        <Card className="max-w-3xl" title="상품 만들기">
          <p className="text-sm text-navy/70">
            설계형이 아닌 보통 상품은 여기서 만듭니다. 담보마다 위험률(연령별 급부 발생률·탈퇴율)을 넣고 보험기간·납입기간·보장금액·납입면제·사업비를 정하면
            산출방법서와 같은 순서로 보험료·책임준비금·해약환급금이 나오고, 연령 구간별 배수로 보험금을 증액·감액할 수 있습니다.
          </p>
          <p className="mb-3 mt-1 text-xs text-navy/50">
            위험률은 셀 직접 입력 · Excel 붙여넣기 · CSV/XLSX 업로드 · 기존 표(제7회 경험생명표·암발생률·암입원율) 불러오기로 넣습니다.
            2대질병 진단, 정기·종신 사망, 암 진단 + 입원일당, 만기환급형, 무해지환급형 예시를 바로 열 수 있습니다.
          </p>
          <Button primary className="self-start" onClick={() => router.push("/builder")}>상품 만들기 열기</Button>
        </Card>
      </section>
      <section className="max-w-3xl"><LibraryPanel /></section>
      <section>
        <h2 className="mb-3 font-display text-xl text-navy">샘플 설계</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {SAMPLES.map((s) => (
            <Card key={s.id} className="flex flex-col" title={s.label}>
              <p className="mb-3 text-sm text-navy/70">{s.description}</p>
              <Button className="mt-auto self-start" onClick={() => { dispatch({ type: "load", state: buildSample(s) }); router.push("/design"); }}>열기</Button>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
