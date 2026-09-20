# methoddoc — 산출방법서 ↔ 입력 조건 변환기

**앱에 딸리지 않는 독립 모듈.** 다른 앱에 옮길 때는 이 폴더를 통째로 복사하고 어댑터만 새로 쓰면 된다.

```
문서(.docx .hwp .hwpx .xlsx .txt)
   ↓ extract.ts          파일 → 문단 + 표
   ↓ parse.ts            표 먼저 → 본문 규칙 → (선택) llm.ts
MethodSpec  ←─ adapter ──  앱의 입력 조건
   ↓ render.ts
산출방법서 (화면 · Markdown · HTML)
```

가운데의 **MethodSpec**(`spec.ts`)이 유일한 계약이다. 양방향 모두 이 형식을 거친다.

## 파일

| 파일 | 하는 일 | 외부 의존 |
|---|---|---|
| `spec.ts` | MethodSpec 모델 · Evidence(출처·확신도) · `validateSpec` | **없음** (import 0개) |
| `render.ts` | MethodSpec → 블록 → 화면/Markdown/HTML | `spec.ts` 만 |
| `extract.ts` | 파일 → 문단·표. ZIP 은 `DecompressionStream`, HWP 는 OLE2 직접 파싱 | 없음(XLSX 는 주입) |
| `parse.ts` | 문단·표 → MethodSpec + Evidence. 동의어·단위 사전 포함 | `spec.ts` `extract.ts` |
| `llm.ts` | 규칙이 못 찾은 항목만 LLM 에 묻는 선택 경로. `ask` 를 안 넘기면 꺼짐 | 없음 |

## 다른 앱에 붙이는 법

1. `lib/methoddoc/` 복사.
2. 어댑터 두 개를 쓴다 (이 저장소의 `lib/plan-doc.ts`·`lib/methoddoc-bridge.ts` 참고).
   - `appToSpec(state): MethodSpec` — 내보내기
   - `applySpecToApp(spec, accepted: Evidence[]): number` — 들여오기. **검수에서 고른 것만** 반영한다.
3. XLSX 를 읽으려면 `extractDoc(name, buf, sheetReader)` 에 시트 읽기 함수를 넘긴다.
4. LLM 을 쓰려면 `fillWithLlm(result, doc, ask)` 에 `ask` 를 넘긴다. 서버 라우트 예: `app/api/method-llm/route.ts`.

## 지원 형식과 한계

| 형식 | 상태 |
|---|---|
| DOCX | 문단 + 표 (가장 정확) |
| HWP 5.x | 문단. 표는 아직 미지원, 수식 객체는 `[수식]` 자리표시자 |
| HWPX | 문단 + 표 |
| XLSX·CSV·TXT | 표·줄 |
| PDF·구형 HWP·DRM 파일 | **읽지 못함** — `ExtractError.why` 로 이유를 알려준다 |

- **수식은 뽑지 않는다.** 산출방법서의 수식은 HWP 수식객체·이미지다. 기호·산식은 앱 쪽 정의를 쓴다.
- **자동 적용하지 않는다.** 모든 값은 Evidence(원문·출처·확신도)를 달고 나오며, 사람이 고른 것만 반영한다.
- 확신도: `high` 표에서 직접 · `medium` 본문 규칙 · `low` AI 추정(기본 미적용).

## 사전 늘리기

회사마다 표기가 다르다. `parse.ts` 의 `FIELD_RULES`(본문 규칙)·`EXPENSE_SYMBOL`(사업비 표)·`ROLE_WORDS`(위험률 유형)에 낱말을 추가하면 된다. 새 표기를 만나면 테스트(`tests/methoddoc/parse.test.ts`)에 실제 문서를 물려 회귀로 고정한다.

## 검증

`tests/methoddoc/parse.test.ts` 는 실제 산출방법서 2건(DRM 없는 DOCX·HWP)을 읽어 사업비 5항목·이율·해지율·위험률 계열을 확인한다. 문서가 없는 환경에서는 그 describe 만 건너뛴다.
