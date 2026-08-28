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
  /** JSON-Array mit Text-Datei-Anhängen ({name, content}), wie es der Server speichert. */
  files: string | null;
  created_at: number;
}

export interface ChatFile {
  name: string;
  content: string;
  encoding?: string;
}

/** Werkzeugaufruf während einer Antwort. Nur zur Laufzeit, nicht gespeichert. */
export interface ToolEvent {
  name: string;
  args: string;
  ok?: boolean;
  durationMs?: number;
}

export interface ChatOptions {
  model: string;
  think: boolean;
  tools: boolean;
  temperature: number;
  numPredict: number;
  provider: "ollama" | "openrouter";
  openrouterModel: string;
  memorySteps: number;
  memoryAnchors: boolean;
  dreamAuto: boolean;
}

export interface OllamaModel {
  name: string;
  sizeGB?: number;
  parameterSize?: string;
  quantization?: string;
}

export interface Anchor {
  id: number;
  session_id: string;
  text: string;
  kind: string;
  importance: number;
  hits: number;
  pinned: number;
  origin: string;
  last_seq: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryState {
  last_seq: number;
  last_dream_seq: number;
  dream_count: number;
}

export interface DreamResult {
  ok: boolean;
  events: number;
  inserted: number;
  merged: number;
  pruned: number;
  source: string;
  error?: string;
}

export interface MemoryInfo {
  state: MemoryState;
  anchors: Anchor[];
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
