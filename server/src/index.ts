import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as dbmod from "./db.js";
import * as mem from "./memory.js";
import { streamChat, type OllamaOptions } from "./ollama.js";
import { transcribeAudio, synthesizeSpeech, MAX_AUDIO_BYTES } from "./voice.js";
import {
  streamOpenRouter,
  listOpenRouterModels,
  getOpenRouterKey,
} from "./openrouter.js";
import { ALLOWED_ORIGINS, isOriginAllowed, createRateLimiter } from "./security.js";
import { validateImages, ImageError, MAX_WS_PAYLOAD } from "./images.js";
import { toolNames } from "./tools/index.js";

// simple .env loader (project root)
try {
  for (const line of readFileSync(
    path.join(import.meta.dirname, "..", "..", ".env"),
    "utf8",
  ).split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  /* keine .env vorhanden */
}

const PORT = Number(process.env.PORT ?? 8788);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.MODEL ?? "qwen3.5:latest";

const DREAM_IDLE_MS = 180_000;
const DREAM_BATCH = 10;
const dreamTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activeDreams = new Set<string>();

function runDream(sessionId: string): Promise<mem.DreamResult | null> {
  if (activeDreams.has(sessionId)) return Promise.resolve(null);
  activeDreams.add(sessionId);
  clearTimeout(dreamTimers.get(sessionId));
  dreamTimers.delete(sessionId);
  return mem
    .dream(sessionId, { ollamaUrl: OLLAMA_URL, model: MODEL })
    .then((result) => {
      broadcast({ type: "memory-updated", sessionId, result });
      return result;
    })
    .catch((err) => {
      app.log.error({ err }, "Traumphase fehlgeschlagen");
      return null;
    })
    .finally(() => activeDreams.delete(sessionId));
}

function scheduleDream(sessionId: string) {
  clearTimeout(dreamTimers.get(sessionId));
  dreamTimers.set(
    sessionId,
    setTimeout(() => void runDream(sessionId), DREAM_IDLE_MS),
  );
}

const app = Fastify({ logger: true, bodyLimit: MAX_AUDIO_BYTES });

// origin:true würde jede fremde Origin reflektieren — damit könnte jede vom
// Nutzer geöffnete Webseite die komplette Chat-Historie auslesen.
await app.register(cors, { origin: [...ALLOWED_ORIGINS] });

// Zweite Verteidigungslinie: CORS schützt nur Browser-Clients, die den
// Response abwarten. Ein fremder Origin wird hier hart abgewiesen.
app.addHook("onRequest", async (req, reply) => {
  if (!isOriginAllowed(req.headers.origin)) {
    return reply.code(403).send({ error: "origin not allowed" });
  }
});

const sttLimiter = createRateLimiter(10, 60_000);
const ttsLimiter = createRateLimiter(30, 60_000);

app.addContentTypeParser(
  ["application/octet-stream", "audio/*", "video/*"],
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/tools", async () => ({ ok: true, tools: toolNames() }));

app.get("/api/model", async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: MODEL }),
    });
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };
    const data = (await res.json()) as {
      details?: { parameter_size?: string; quantization_level?: string };
      capabilities?: string[];
    };
    return {
      ok: true,
      model: MODEL,
      parameterSize: data.details?.parameter_size,
      quantization: data.details?.quantization_level,
      capabilities: data.capabilities ?? [],
    };
  } catch (err) {
    app.log.error({ err }, "Ollama /api/show fehlgeschlagen");
    return { ok: false, error: "Ollama nicht erreichbar" };
  }
});

// --- Sessions REST ---
app.get("/api/sessions", async () => dbmod.listSessions());
app.post("/api/sessions", async () => dbmod.createSession());
app.get("/api/sessions/:id/messages", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!dbmod.getSession(id)) return reply.code(404).send({ error: "not found" });
  return dbmod.listMessages(id);
});
app.delete("/api/sessions/:id", async (req) => {
  const { id } = req.params as { id: string };
  clearTimeout(dreamTimers.get(id));
  dreamTimers.delete(id);
  dbmod.deleteSession(id);
  mem.deleteSessionMemory(id);
  broadcast({ type: "session-deleted", id });
  return { ok: true };
});

// --- Gedächtnis ---
app.get("/api/sessions/:id/memory", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!dbmod.getSession(id)) return reply.code(404).send({ error: "not found" });
  return { state: mem.getMemoryState(id), anchors: mem.listAnchors(id) };
});

app.post("/api/sessions/:id/dream", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!dbmod.getSession(id)) return reply.code(404).send({ error: "not found" });
  const result = await mem.dream(id, { ollamaUrl: OLLAMA_URL, model: MODEL });
  broadcast({ type: "memory-updated", sessionId: id, result });
  return result;
});

app.post("/api/sessions/:id/memory/rebuild", async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!dbmod.getSession(id)) return reply.code(404).send({ error: "not found" });
  const result = mem.rebuildMemory(id);
  broadcast({ type: "memory-updated", sessionId: id, result });
  return { ok: true, ...result };
});

app.patch("/api/anchors/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { pinned } = (req.body ?? {}) as { pinned?: boolean };
  if (!Number.isInteger(id) || typeof pinned !== "boolean") {
    return reply.code(400).send({ error: "id/pinned fehlt" });
  }
  if (!mem.setAnchorPinned(id, pinned)) {
    return reply.code(404).send({ error: "not found" });
  }
  return { ok: true };
});

app.delete("/api/anchors/:id", async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!Number.isInteger(id)) return reply.code(400).send({ error: "id ungültig" });
  if (!mem.deleteAnchor(id)) return reply.code(404).send({ error: "not found" });
  return { ok: true };
});

// --- Voice ---
app.post("/api/stt", async (req, reply) => {
  if (!sttLimiter(req.ip)) {
    return reply.code(429).send({ ok: false, error: "Zu viele Anfragen" });
  }
  const audio = req.body as Buffer;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return reply.code(400).send({ ok: false, error: "Kein Audio empfangen" });
  }
  try {
    const text = await transcribeAudio(audio);
    return { ok: true, text };
  } catch (err) {
    // Details nur ins Server-Log: whisper/ffmpeg-Fehler enthalten lokale Pfade.
    app.log.error({ err }, "STT fehlgeschlagen");
    return reply
      .code(500)
      .send({ ok: false, error: "Transkription fehlgeschlagen (Details im Server-Log)" });
  }
});

const TTS_MAX_CHARS = 8000;

app.post("/api/tts", async (req, reply) => {
  if (!ttsLimiter(req.ip)) {
    return reply.code(429).send({ error: "Zu viele Anfragen" });
  }
  const { text } = (req.body ?? {}) as { text?: string };
  if (!text || !text.trim()) {
    return reply.code(400).send({ error: "text fehlt" });
  }
  if (text.length > TTS_MAX_CHARS) {
    return reply.code(413).send({ error: `Text länger als ${TTS_MAX_CHARS} Zeichen` });
  }
  try {
    const wav = await synthesizeSpeech(text);
    reply.header("Content-Type", "audio/wav").send(wav);
  } catch (err) {
    app.log.error({ err }, "TTS fehlgeschlagen");
    return reply
      .code(500)
      .send({ error: "Sprachausgabe fehlgeschlagen (Details im Server-Log)" });
  }
});

// --- OpenRouter models ---
app.get("/api/openrouter/models", async () => {
  if (!getOpenRouterKey()) {
    return { ok: false, error: "OPENROUTER_API_KEY nicht gesetzt (.env fehlt)" };
  }
  try {
    return { ok: true, models: await listOpenRouterModels() };
  } catch (err) {
    app.log.error({ err }, "OpenRouter-Modellliste fehlgeschlagen");
    return { ok: false, error: "Modellliste nicht abrufbar" };
  }
});

// --- WebSocket ---
interface ChatOptionsPayload {
  think: boolean;
  temperature: number;
  numPredict: number;
  provider?: string;
  openrouterModel?: string;
  tools?: boolean;
  memorySteps?: number;
  memoryAnchors?: boolean;
  dreamAuto?: boolean;
}

function parseOptions(raw: unknown): OllamaOptions & {
  provider: "ollama" | "openrouter";
  openrouterModel: string;
  memorySteps: number;
  memoryAnchors: boolean;
  dreamAuto: boolean;
} {
  const o = (raw ?? {}) as Partial<ChatOptionsPayload>;
  return {
    model: MODEL,
    think: o.think !== false,
    tools: o.tools !== false,
    temperature: clamp(Number(o.temperature ?? 0.7), 0, 2),
    numPredict: Math.min(Math.max(Number(o.numPredict ?? 2048), 64), 16384),
    provider: o.provider === "openrouter" ? "openrouter" : "ollama",
    openrouterModel:
      typeof o.openrouterModel === "string" &&
      /^[\w./:-]{3,120}$/.test(o.openrouterModel)
        ? o.openrouterModel
        : "anthropic/claude-sonnet-4.5",
    memorySteps: Math.min(Math.max(Math.round(Number(o.memorySteps ?? 10)), 2), 100),
    memoryAnchors: o.memoryAnchors !== false,
    dreamAuto: o.dreamAuto !== false,
  };
}

function clamp(v: number, min: number, max: number) {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

function broadcast(data: unknown) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
  }
}

wss.on("connection", (socket: WebSocket, _req: IncomingMessage) => {
  let activeAbort: AbortController | null = null;

  socket.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
      return;
    }

    if (msg.type === "abort") {
      activeAbort?.abort();
      return;
    }

    if (msg.type !== "chat") return;

    const sessionId = String(msg.sessionId ?? "");
    const content = String(msg.content ?? "").trim();

    let images: string[];
    try {
      images = validateImages(msg.images).map((i) => i.base64);
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: err instanceof ImageError ? err.message : "Bild abgelehnt",
        }),
      );
      return;
    }

    // Ein Bild allein ist eine gültige Anfrage — Text darf dann fehlen.
    if (!sessionId || (!content && images.length === 0)) {
      socket.send(JSON.stringify({ type: "error", error: "sessionId/content fehlt" }));
      return;
    }

    let session = dbmod.getSession(sessionId);
    if (!session) session = dbmod.createSession();
    dbmod.renameSessionIfDefault(session.id, content || "Bild");

    const userMsg = dbmod.insertMessage(session.id, "user", content, null, images);
    mem.appendEvent(session.id, "message", {
      role: "user",
      content,
      images: images.length,
    });
    socket.send(JSON.stringify({ type: "user-message", message: userMsg }));
    broadcast({ type: "sessions-changed" });

    const opts = parseOptions(msg.options);
    opts.sessionId = session.id;
    const history = dbmod
      .listMessages(session.id)
      .slice(-opts.memorySteps)
      .map((m) => {
        const imgs = dbmod.parseImages(m);
        return imgs.length
          ? { role: m.role, content: m.content, images: imgs }
          : { role: m.role, content: m.content };
      });

    const userSystem =
      typeof msg.systemPrompt === "string" && msg.systemPrompt.trim()
        ? (msg.systemPrompt as string)
        : undefined;
    const anchorBlock = opts.memoryAnchors
      ? mem.anchorContextBlock(session.id)
      : null;
    const system = [userSystem, anchorBlock].filter(Boolean).join("\n\n") || undefined;

    const assistantRow = dbmod.insertMessage(session.id, "assistant", "");
    socket.send(JSON.stringify({ type: "assistant-start", message: assistantRow }));

    activeAbort = new AbortController();
    let full = "";
    let thinking = "";
    const callbacks = {
      onThinking(text: string) {
        thinking += text;
        socket.send(
          JSON.stringify({ type: "thinking", text, messageId: assistantRow.id }),
        );
      },
      onToken(text: string) {
        full += text;
        socket.send(
          JSON.stringify({ type: "token", text, messageId: assistantRow.id }),
        );
      },
      onDone() {},
      onToolCall(name: string, args: Record<string, unknown>) {
        mem.appendEvent(session.id, "tool_call", {
          name,
          args: JSON.parse(JSON.stringify(args, (_k, v) =>
            typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "…" : v,
          )),
        });
        socket.send(
          JSON.stringify({
            type: "tool-call",
            messageId: assistantRow.id,
            name,
            // Argumente gekürzt: ein Dateiinhalt als Argument würde den
            // Client sonst mit Daten fluten.
            args: JSON.stringify(args).slice(0, 300),
          }),
        );
      },
      onToolResult(name: string, ok: boolean, durationMs: number) {
        socket.send(
          JSON.stringify({ type: "tool-result", messageId: assistantRow.id, name, ok, durationMs }),
        );
      },
    };

    try {
      if (opts.provider === "openrouter") {
        const apiKey = getOpenRouterKey();
        if (!apiKey) throw new Error("OPENROUTER_API_KEY nicht gesetzt (.env fehlt)");
        await streamOpenRouter(
          history,
          system,
          {
            model: opts.openrouterModel,
            temperature: opts.temperature,
            numPredict: opts.numPredict,
          },
          apiKey,
          callbacks,
          activeAbort.signal,
        );
      } else {
        await streamChat(history, system, opts, callbacks, activeAbort.signal);
      }
      dbmod.updateAssistantMessage(assistantRow.id, full.trim(), thinking.trim() || null);
      mem.appendEvent(session.id, "message", {
        role: "assistant",
        content: full.trim().slice(0, 4000),
      });
      socket.send(
        JSON.stringify({
          type: "done",
          messageId: assistantRow.id,
          aborted: activeAbort.signal.aborted,
        }),
      );
      broadcast({ type: "sessions-changed" });
      if (opts.dreamAuto) {
        const st = mem.getMemoryState(session.id);
        if (st.last_seq - st.last_dream_seq >= DREAM_BATCH) {
          void runDream(session.id);
        } else {
          scheduleDream(session.id);
        }
      }
    } catch (err) {
      const aborted =
        activeAbort.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      dbmod.updateAssistantMessage(assistantRow.id, full.trim(), thinking.trim() || null);
      if (aborted) {
        socket.send(JSON.stringify({ type: "done", messageId: assistantRow.id, aborted: true }));
      } else {
        socket.send(
          JSON.stringify({
            type: "error",
            messageId: assistantRow.id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } finally {
      activeAbort = null;
    }
  });
});

const server = app.server;
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");

  // WebSockets unterliegen nicht der Same-Origin-Policy: ohne diese Prüfung
  // könnte jede fremde Seite eine Verbindung aufbauen, Chats senden, Antworten
  // mitlesen und Kosten auf dem OpenRouter-Key erzeugen (CSWSH).
  if (!isOriginAllowed(req.headers.origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

app.listen({ port: PORT, host: "127.0.0.1" }, () => {
  console.log(`[agenttwo-tools] Server läuft auf http://127.0.0.1:${PORT}`);
});
