export interface Session {
  id: string;
  title: string;
  created_at: number;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  thinking: string | null;
  /** JSON-Array mit base64-Bilddaten, wie es der Server speichert. */
  images: string | null;
  created_at: number;
}

/** Werkzeugaufruf während einer Antwort. Nur zur Laufzeit, nicht gespeichert. */
export interface ToolEvent {
  name: string;
  args: string;
  ok?: boolean;
  durationMs?: number;
}

export interface ChatOptions {
  think: boolean;
  tools: boolean;
  temperature: number;
  numPredict: number;
  provider: "ollama" | "openrouter";
  openrouterModel: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
  promptPrice: number;
}

export interface ModelInfo {
  ok: boolean;
  model?: string;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  error?: string;
}
