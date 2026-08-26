export interface OpenRouterOptions {
  model: string;
  temperature: number;
  numPredict: number;
}

export interface StreamCallbacks {
  onThinking(text: string): void;
  onToken(text: string): void;
  onDone(): void;
}

export function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

export async function listOpenRouterModels(): Promise<
  { id: string; name: string; contextLength: number; promptPrice: number }[]
> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = (await res.json()) as {
    data: {
      id: string;
      name: string;
      context_length: number;
      pricing: { prompt: string };
    }[];
  };
  return data.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      promptPrice: Number(m.pricing?.prompt ?? 0) * 1_000_000,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function streamOpenRouter(
  history: { role: string; content: string }[],
  systemPrompt: string | undefined,
  opts: OpenRouterOptions,
  apiKey: string,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:5174",
      "X-Title": "agenttwo-tools",
    },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...history,
      ],
      temperature: opts.temperature,
      max_tokens: opts.numPredict,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nlIndex: number;
    while ((nlIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nlIndex).trim();
      buffer = buffer.slice(nlIndex + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        cb.onDone();
        return;
      }
      let chunk: {
        choices?: {
          delta?: { content?: string; reasoning?: string };
          finish_reason?: string | null;
        }[];
        error?: { message?: string };
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? "OpenRouter error");
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning) cb.onThinking(delta.reasoning);
      if (delta?.content) cb.onToken(delta.content);
      if (chunk.choices?.[0]?.finish_reason && !delta?.content) {
        cb.onDone();
        return;
      }
    }
  }
  cb.onDone();
}
