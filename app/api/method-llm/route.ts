import { buildPrompt, type LlmRequest } from "@/lib/methoddoc/llm";

/**
 * 산출방법서 읽기 LLM 보조. ANTHROPIC_API_KEY 가 있을 때만 동작하고,
 * 없으면 501 과 안내를 돌려준다 — 규칙 기반 추출은 이 라우트 없이도 그대로 돌아간다.
 * 발췌 몇 문단만 올려 보내고, 모델은 JSON 한 덩어리만 답하게 한다.
 */
export const runtime = "nodejs";

const MODEL = process.env.METHOD_LLM_MODEL ?? "claude-sonnet-5";

export async function GET() {
  return Response.json({ available: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
}

export async function POST(req: Request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json({
      error: "AI 보조가 설정되지 않았습니다. .env.local 에 ANTHROPIC_API_KEY 를 넣고 다시 시작하세요.",
      hint: "설정하지 않아도 규칙 기반 추출은 그대로 동작합니다.",
    }, { status: 501 });
  }
  let body: LlmRequest;
  try {
    body = (await req.json()) as LlmRequest;
    if (!Array.isArray(body.fields) || !Array.isArray(body.excerpts)) throw new Error("fields·excerpts 가 필요합니다");
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "잘못된 요청" }, { status: 400 });
  }
  // 올려 보내는 양에 상한을 둔다(비용·지연)
  const excerpts = body.excerpts.slice(0, 40).map((x) => ({ where: String(x.where).slice(0, 40), text: String(x.text).slice(0, 1200) }));
  const prompt = buildPrompt({ fields: body.fields.slice(0, 20), excerpts });

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return Response.json({ error: `모델 호출 실패 (${res.status})`, detail: (await res.text()).slice(0, 300) }, { status: 502 });
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    return Response.json({ answers: JSON.parse(json) as Record<string, unknown>, model: MODEL });
  } catch (e) {
    return Response.json({ error: `응답을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
}
