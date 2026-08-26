import {
  MAX_TOOL_ROUNDS,
  runTool,
  toolDefinitions,
  type ToolCall,
} from "./tools/index.js";

export interface OllamaOptions {
  model: string;
  think: boolean;
  temperature: number;
  numPredict: number;
  /** Werkzeuge mitschicken. Aus, wenn der Nutzer sie abgeschaltet hat. */
  tools?: boolean;
}

export interface StreamCallbacks {
  onThinking(text: string): void;
  onToken(text: string): void;
  onDone(): void;
  /** Modell möchte ein Werkzeug benutzen. */
  onToolCall?(name: string, args: Record<string, unknown>): void;
  /** Werkzeug ist fertig. */
  onToolResult?(name: string, ok: boolean, durationMs: number): void;
}

/** Muss zum OLLAMA_URL in index.ts passen — vorher war der Host hier hartkodiert. */
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

interface ChatChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: RawToolCall[];
  };
  done?: boolean;
  error?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  /** base64 ohne data:-Präfix; Ollama erwartet genau dieses Format. */
  images?: string[];
}

/** Nachricht im Ollama-Format, inklusive der Zwischenschritte einer Werkzeugrunde. */
interface WireMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: RawToolCall[];
  tool_name?: string;
}

function toWire(m: ChatMessage): WireMessage {
  return m.images?.length
    ? { role: m.role, content: m.content, images: m.images }
    : { role: m.role, content: m.content };
}

/** Ollama liefert arguments meist als Objekt, gelegentlich als JSON-String. */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* unbrauchbare Argumente -> leeres Objekt, das Werkzeug meldet den Fehler */
    }
  }
  return {};
}

/** Eine Streaming-Runde. Gibt die gesammelten Werkzeugaufrufe zurück. */
async function streamOnce(
  messages: WireMessage[],
  opts: OllamaOptions,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<{ toolCalls: ToolCall[]; content: string }> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: true,
    think: opts.think,
    options: {
      temperature: opts.temperature,
      num_predict: opts.numPredict,
    },
  };
  if (opts.tools !== false) body.tools = toolDefinitions();

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
  const toolCalls: ToolCall[] = [];
  let content = "";

  for (;;) {
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
      if (chunk.message?.content) {
        content += chunk.message.content;
        cb.onToken(chunk.message.content);
      }
      for (const call of chunk.message?.tool_calls ?? []) {
        const name = call.function?.name;
        if (name) {
          toolCalls.push({ id: call.id, name, arguments: parseArgs(call.function?.arguments) });
        }
      }
      if (chunk.done) return { toolCalls, content };
    }
  }
  return { toolCalls, content };
}

/**
 * Streamt eine Antwort und führt dabei Werkzeuge aus.
 *
 * Ablauf je Runde: streamen, bis Ollama fertig ist. Kamen dabei Werkzeugaufrufe
 * zurück, werden sie ausgeführt, ihre Ergebnisse an den Verlauf angehängt und
 * eine weitere Runde gestartet — bis das Modell ohne Werkzeugwunsch antwortet
 * oder MAX_TOOL_ROUNDS erreicht ist.
 */
export async function streamChat(
  history: ChatMessage[],
  systemPrompt: string | undefined,
  opts: OllamaOptions,
  cb: StreamCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const messages: WireMessage[] = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    ...history.map(toWire),
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS;
    // In der letzten Runde ohne Werkzeuge fragen, damit eine Antwort entsteht
    // statt eines weiteren Aufrufwunsches.
    const roundOpts = lastRound ? { ...opts, tools: false } : opts;

    const { toolCalls, content } = await streamOnce(messages, roundOpts, cb, signal);

    if (toolCalls.length === 0) {
      cb.onDone();
      return;
    }

    messages.push({
      role: "assistant",
      content,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        function: { name: c.name, arguments: c.arguments },
      })),
    });

    for (const call of toolCalls) {
      cb.onToolCall?.(call.name, call.arguments);
      const result = await runTool(call, signal);
      cb.onToolResult?.(result.name, result.ok, result.durationMs);
      messages.push({ role: "tool", tool_name: result.name, content: result.content });
    }
  }

  cb.onDone();
}
