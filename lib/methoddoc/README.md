# methoddoc — 산출방법서 ↔ 입력 조건 변환기

**앱에 딸리지 않는 독립 모듈.** 다른 앱에 옮길 때는 이 폴더를 통째로 복사하고 어댑터만 새로 쓰면 된다.

> **원본은 `Life_ins_Doc_Convert_Studio/lib/methoddoc`** 이고 `flexible_insurance/lib/methoddoc` 은 복사본이다.
> 고칠 때는 원본을 고친 뒤 폴더째 복사하고 두 앱의 시험을 모두 돌린다. 마지막으로 맞춘 날: 2026-09-22 (파일 11개 모두 같음 — 표준 산출방법서 v2 후).

```
문서(.docx .hwp .hwpx .xlsx .txt .tex .md)   스캔 PDF · 그림
   ↓ extract.ts · tex.ts  파일 → 문단 + 표      ↓ vision.ts  쪽 그림 → (호출자의 ask) → 옮겨 적은 문단 + 표
   ↓ parse.ts             표 먼저 → 본문 규칙 → 표준 양식이면 [식]·※·절까지 → (선택) llm.ts
MethodSpec  ←─ adapter ──  앱의 입력 조건 (위험률 값 표는 RateRef.table)
   ↓ formulas.ts · render.ts · tex.ts · docx.ts
산출방법서 = 표준 산출방법서 v2 (화면 · Markdown · HTML · LaTeX · Word)
```

### 표준 산출방법서 v2

이 모듈이 내는 산출방법서의 모양이 곧 **표준 산출방법서**다(`render.ts` 의 `STANDARD_FORMAT`). 개요 표의 `양식 | 표준 산출방법서 v2` 행이 표시이고,
`parse.ts` 는 이 행을 보면 정해진 순서대로 더 읽는다(`readStandard`).

| 자리 | 읽는 것 |
|---|---|
| 개요 표 `항목 \| 내용` | 상품명 · 회사 · 종류 · 작성일 · 판 · 비고 |
| `위험률 \| 기호 \| 유형 \| 근거·출처 \| 표` | 기호 칸이 위험률 id — 담보가 가리키는 id 가 그대로 돌아온다 |
| `구분 \| 기호 \| 기준 \| 적용사업비율` | 칸대로 — `계약체결비용 (초년도)` 의 괄호가 phase |
| `담보 \| 이름` 세로 표 (단위 · 급부 유형 · 지급 사유 · 보장금액 …) | 담보 하나. v1 의 넓은 담보 표도 읽는다 |
| `[식] 제목` + 설명 줄(위)·식 줄(아래) + `※ 덧붙임` | 그 절(`N. 제목`)의 수식. 자동 식과 같으면 싣지 않고 고친 식·새 식만 `formulas` 로 |
| `N. 기호의 정의` | 읽지 않는다 — 조건에서 만든다(x·t·n·m·k·i·v·l·l′, 해지율이 있으면 w·ρ) |
| `N. 책임준비금 관련 사항` · `N. 해지환급금 관련 사항` | `reserve.notes` · `surrender.notes` · 해약공제 기간 |
| 그 밖의 `N. 제목` 절 | `sections` (원문 절 보존) |
| `※ 담보: 연령 구간 배수 …` / `생존급부 …` | 담보의 `steps` · `points` |
| 맨 앞 `작성 안내` 표 | 읽지 않는다 |

`[식]`·`※` 표시는 편집용 내보내기(Word·Markdown·LaTeX)에만 붙고 화면·HTML 에는 없다(`kind: "label"`).
Word·한글의 수식 편집기로 넣은 식(OMML · `hp:script`)과 글자 서식 첨자는 `extract.ts` 가 평문 표기(`l_{x+t}`)로 바꾼다.
`docx.ts` 는 식 줄을 독립 수식(`m:oMathPara`)으로, 글·표 속 기호(`α_S`)는 글자 첨자로 쓴다 — 한글이 글 속 수식(`m:oMath`)을 버리기 때문이다.
여러 글자 이름(PVB · base)은 일반 글자(`m:nor`)로 쓴다 — 한글이 수식 낱말(base 등)과 겹치면 네모로 그린다.
양식을 바꾸면 판을 올리고 parse 가 옛 판도 읽게 둔다 — v1 문서의 자동 식(옛 표기)은 `V1_AUTO` 로 건너뛰고 조건에서 새로 만든다.

가운데의 **MethodSpec**(`spec.ts`)이 유일한 계약이다. 양방향 모두 이 형식을 거친다.
`contract` 는 산출에 쓰는 시산 기준 한 점으로 **계산하는 앱이 채운다**(parse 는 읽지 않고, render 는 채워져 있을 때만 싣는다). `product`(선택)는 산출방법서 개요에 싣는 가입 조건(판매 범위 — 보험기간·납입기간·가입나이 표 등)이다.
`product` 는 원문 표기 그대로의 글자이며 산출에 쓰지 않는다.

## 파일

위험률 값 표는 `RateRef.table`(한 벌) 또는 `RateRef.tables {M, F}`(남·여 두 벌) — 계산하는 앱이 `rateTable(r, sex)` 로 고른다.

| 파일 | 하는 일 | 외부 의존 |
|---|---|---|
| `spec.ts` | MethodSpec 모델 · Evidence(출처·확신도) · `validateSpec` | **없음** (import 0개) |
| `render.ts` | MethodSpec → 블록 → 화면/Markdown/HTML | `spec.ts` 만 |
| `extract.ts` | 파일 → 문단·표. ZIP 은 `DecompressionStream`, HWP 는 OLE2 직접 파싱 | 없음(XLSX 는 주입) |
| `pdf.ts` | PDF → 문단·표(좌표로 표 복원). 동적 import 라 다른 화면 번들에 안 들어간다 | `pdfjs-dist` |
| `parse.ts` | 문단·표 → MethodSpec + Evidence. 동의어·단위 사전 포함 | `spec.ts` `extract.ts` |
| `llm.ts` | 규칙이 못 찾은 항목만 LLM 에 묻는 선택 경로. `ask` 를 안 넘기면 꺼짐 | 없음 |
| `formulas.ts` | MethodSpec → 산출식(유지자수·납입자수 `1 − Σd + Σdᵢdⱼ/2` · 계산기수 · 보험료 · 준비금 · 해지환급금) | `spec.ts` 만 |
| `tex.ts` | 평문 수식 → LaTeX(KaTeX 공용), 산출방법서 ↔ `.tex` | 이 폴더 안만 |
| `docx.ts` | 산출방법서 블록 → Word(.docx). 압축 없는 ZIP 을 직접 쓴다(`zipStore`) — 한글에서 열어 HWPX 로 저장된다 | 이 폴더 안만 |
| `vision.ts` | 스캔 PDF·그림 → 문단·표. 모델은 옮겨 적기만(`PAGE_SCHEMA` · `VISION_SYSTEM`), 조건은 `parse.ts` 가. 호출은 `VisionAsk` 로 주입 | 이 폴더 안만 |

## 다른 앱에 붙이는 법

1. `lib/methoddoc/` 복사.
2. 어댑터를 쓴다 (flexible_insurance 의 `lib/plan-doc.ts`·`lib/methoddoc-bridge.ts` 참고).
   - `appToSpec(state): MethodSpec` — 내보내기 (`planToSpec`)
   - `applySpecToApp(spec, accepted: Evidence[]): number` — 문서에서 읽은 값 들여오기. **검수에서 고른 것만** 반영한다 (`applySpecToPlan`)
   - `specToApp(spec): AppState` — 다른 앱이 낸 MethodSpec JSON(위험률 표·담보 포함)으로 설계 전체 만들기 (`planFromSpec`). `appToSpec` 과 왕복하면 결과가 같아야 한다
3. XLSX 를 읽으려면 `extractDoc(name, buf, sheetReader)` 에 시트 읽기 함수를 넘긴다.
4. LLM 을 쓰려면 `fillWithLlm(result, doc, ask)` 에 `ask` 를 넘긴다. 서버 라우트 예: `app/api/method-llm/route.ts`.

## 지원 형식과 한계

| 형식 | 상태 |
|---|---|
| DOCX | 문단 + 표 (가장 정확) + Word 수식(OMML)·서식 첨자 → 평문 표기 |
| HWP 5.x | 문단. 표는 아직 미지원, 수식 객체는 `[수식]` 자리표시자 |
| HWPX | 문단 + 표 + 한글 수식 편집기 식(`hp:script` → 평문 표기) |
| XLSX·CSV·TXT | 표·줄 |
| Markdown | 줄 + 파이프 표(`\| a \| b \|`). 이 모듈이 낸 산출방법서를 그대로 되읽을 수 있다 |
| PDF (글자 레이어 있음) | 문단 + 표. 표는 글자 좌표로 되살린다(병합 셀이 많으면 줄로만). 브라우저는 `public/pdf.worker.min.mjs` 필요 |
| 스캔 PDF·그림 | `extract` 는 `ExtractError.why = "scanned"`. 호출자가 쪽 그림을 만들어 `vision.ts` 의 `transcribe(images, ask)` 로 옮겨 적으면 같은 규칙으로 읽힌다 |
| 구형 HWP·DRM 파일 | **읽지 못함** — `ExtractError.why` 로 이유를 알려준다 |

- **수식은 표준 양식에서만 읽는다.** 일반 산출방법서의 수식(HWP 수식객체·이미지)은 뽑지 않고 앱 쪽 정의를 쓴다. 표준 산출방법서의 `[식]` 은 읽는다.
- **자동 적용하지 않는다.** 모든 값은 Evidence(원문·출처·확신도)를 달고 나오며, 사람이 고른 것만 반영한다.
- 확신도: `high` 표에서 직접 · `medium` 본문 규칙 · `low` AI 추정(기본 미적용).

## 표기 차이를 흡수하는 장치

실제 산출방법서 9건(DOCX·HWP·PDF 7)을 물려 보며 아래를 넣었다. 새 문서가 안 읽히면 먼저 여기를 의심한다.

| 장치 | 무엇을 해결하나 |
|---|---|
| `squeeze()` | PDF 가 글자 사이에 넣는 공백 — "표 준 이 율", "유 지 비" |
| `PCT` = `[%％﹪]` | HWP→PDF 의 전각 퍼센트 — "연 4.5％ 복리" |
| `scanLines()` 제목 잇기 | 제목과 값이 다른 줄/다른 행 — "2. 예정이율에 관한 사항" ⏎ "연복리 3.5%" |
| `pickRate()` | 문장 속 비율 — "초년도 보험가입금액의 2.50 / 1,000" |
| `SYMBOL_CELL` | 기호가 제 칸에 있는 표 — `구분 \| 기호 \| 기준 \| 비율` |
| `GREEK` | 첫 칸이 기호뿐인 표 — `α1 \| 일시납영업보험료의 3.50%` |
| `continuation()` | 낱말 가운데서 줄이 바뀐 위험률 이름 — "…·골" ⏎ "다공증 수술률" |
| `NAME_LIKE` | 본문 한 줄이 "… 보험" 으로 끝나 상품명으로 오인되는 것 |
| `not` 규칙 | "표준이율의 125%", "평균공시이율 + 1%", "납입기간 5년이하 경우" |

## 사전 늘리기

회사마다 표기가 다르다. `parse.ts` 의 `FIELD_RULES`(본문 규칙)·`EXPENSE_SYMBOL`(사업비 표)·`ROLE_WORDS`(위험률 유형)에 낱말을 추가하면 된다. 새 표기를 만나면 테스트(`tests/methoddoc/parse.test.ts`)에 실제 문서를 물려 회귀로 고정한다.

## 검증

| 테스트 | 무엇을 고정하나 |
|---|---|
| `tests/methoddoc/parse.test.ts` | 실제 산출방법서 2건(DRM 없는 DOCX·HWP) — 사업비 5항목·이율·해지율·위험률 계열 |
| `tests/methoddoc/pdf-real.test.ts` | 실제 PDF 7건(생보·손보·공제) — 상품명·이율·사업비·위험률 + 오인식 방지 |
| `tests/ui/roundtrip.test.ts` | 양방향 왕복 — 문서→조건→보험료, 조건+결과→문서→되읽기(보험료·준비금·환급금 일치) |

문서가 없는 환경에서는 해당 describe 만 건너뛴다.
