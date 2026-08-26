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
  created_at: number;
}

export interface ChatOptions {
  think: boolean;
  temperature: number;
  numPredict: number;
}

type Handler = (data: Record<string, unknown>) => void;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: string[] = [];
  private closedByUser = false;
  onStatus?: (status: "connecting" | "open" | "closed") => void;

  connect() {
    this.closedByUser = false;
    this.onStatus?.("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      this.onStatus?.("open");
      for (const item of this.queue) ws.send(item);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string);
        for (const h of this.handlers) h(data);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      this.onStatus?.("closed");
      if (!this.closedByUser) setTimeout(() => this.connect(), 1500);
    };
    this.ws = ws;
  }

  send(data: unknown) {
    const payload = JSON.stringify(data);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    else this.queue.push(payload);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  subscribe(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
}
