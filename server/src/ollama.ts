export interface OllamaOptions {
  model: string;
  think: boolean;
  temperature: number;
  numPredict: number;
}

export interface StreamCallbacks {
  onThinking(text: string): void;
  onToken(text: string): void;
  onDone(): void;
}

/** Muss zum OLLAMA_URL in index.ts passen — vorher war der Host hier hartkodiert. */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

interface ChatChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

export async function streamChat(
  history: { role: string; content: string }[],
  systemPrompt: string | undefined,
  opts: OllamaOptions,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...history,
    ],
    stream: true,
    think: opts.think,
    options: {
      temperature: opts.temperature,
      num_predict: opts.numPredict,
    },
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama HTTP ${res.status}: ${text}`);
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
      if (!line) continue;

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(line) as ChatChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.message?.thinking) cb.onThinking(chunk.message.thinking);
      if (chunk.message?.content) cb.onToken(chunk.message.content);
      if (chunk.done) {
        cb.onDone();
        return;
      }
    }
  }
  cb.onDone();
}
