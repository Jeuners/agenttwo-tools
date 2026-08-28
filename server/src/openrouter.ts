import { mimeFromBase64 } from "./images.js";
import type { ChatStats } from "./ollama.js";

export interface OpenRouterOptions {
  model: string;
  temperature: number;
  numPredict: number;
}

export interface StreamCallbacks {
  onThinking(text: string): void;
  onToken(text: string): void;
  onDone(): void;
  /** Messwerte, sobald die Antwort steht. Wird vor `done` abgewartet. */
  onStats?(stats: ChatStats): void | Promise<void>;
}

export function getOpenRouterKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY;
}

export async function listOpenRouterModels(): Promise<
  {
    id: string;
    name: string;
    contextLength: number;
    promptPrice: number;
    completionPrice: number;
  }[]
> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  const data = (await res.json()) as {
    data: {
      id: string;
      name: string;
      context_length: number;
      pricing: { prompt: string; completion?: string };
    }[];
  };
  // Preise kommen pro Token; die Anzeige rechnet in Preis je 1 Mio. Tokens.
  return data.data
    .map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      promptPrice: Number(m.pricing?.prompt ?? 0) * 1_000_000,
      completionPrice: Number(m.pricing?.completion ?? 0) * 1_000_000,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * OpenRouter folgt dem OpenAI-Schema: Bilder stecken als data-URL in einem
 * content-Array, nicht in einem eigenen images-Feld wie bei Ollama.
 */
function toOpenAIMessage(m: { role: string; content: string; images?: string[] }) {
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: "text", text: m.content }] : []),
      ...m.images.map((b64) => ({
        type: "image_url",
        image_url: { url: `data:${mimeFromBase64(b64)};base64,${b64}` },
      })),
    ],
  };
}

export async function streamOpenRouter(
  history: { role: string; content: string; images?: string[] }[],
  systemPrompt: string | undefined,
  opts: OpenRouterOptions,
  apiKey: string,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  // Vor dem fetch: TTFT soll die Wartezeit auf den Anbieter enthalten, nicht
  // erst ab dem Eintreffen der Antwort-Header zählen (so misst es auch Ollama).
  const startedAt = Date.now();

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
      // Ohne das kommt kein usage-Block und die Tokenzahlen blieben leer.
      stream_options: { include_usage: true },
      messages: [
        ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
        ...history.map(toOpenAIMessage),
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

  let firstTokenAt: number | null = null;
  const stats: ChatStats = {
    promptTokens: 0,
    responseTokens: 0,
    ttftMs: null,
    evalMs: 0,
    totalMs: 0,
    rounds: 1,
  };
  /**
   * OpenRouter meldet keine reine Generierungszeit. Als evalMs zählt deshalb
   * die Zeit ab dem ersten Token — das ist die Spanne, über die tok/s
   * überhaupt aussagekräftig ist.
   */
  function finish(): void | Promise<void> {
    stats.totalMs = Date.now() - startedAt;
    stats.ttftMs = firstTokenAt === null ? null : firstTokenAt - startedAt;
    stats.evalMs = firstTokenAt === null ? 0 : Date.now() - firstTokenAt;
    return cb.onStats?.(stats);
  }

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
        await finish();
        cb.onDone();
        return;
      }
      let chunk: {
        choices?: {
          delta?: { content?: string; reasoning?: string };
          finish_reason?: string | null;
        }[];
        error?: { message?: string };
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? "OpenRouter error");
      if (chunk.usage) {
        stats.promptTokens = chunk.usage.prompt_tokens ?? 0;
        stats.responseTokens = chunk.usage.completion_tokens ?? 0;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning || delta?.content) firstTokenAt ??= Date.now();
      if (delta?.reasoning) cb.onThinking(delta.reasoning);
      if (delta?.content) cb.onToken(delta.content);
      // Der usage-Block kommt erst nach dem finish_reason-Chunk. Nur wenn er
      // schon da ist, darf hier abgekürzt werden — sonst bis [DONE] weiterlesen
      // und die Tokenzahlen mitnehmen.
      if (chunk.choices?.[0]?.finish_reason && !delta?.content && stats.promptTokens) {
        await finish();
        cb.onDone();
        return;
      }
    }
  }
  await finish();
  cb.onDone();
}
