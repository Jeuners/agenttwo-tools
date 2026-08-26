import Fastify from "fastify";
import cors from "@fastify/cors";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as dbmod from "./db.js";
import { streamChat, type OllamaOptions } from "./ollama.js";
import { transcribeAudio, synthesizeSpeech, MAX_AUDIO_BYTES } from "./voice.js";
import {
  streamOpenRouter,
  listOpenRouterModels,
  getOpenRouterKey,
} from "./openrouter.js";
import { ALLOWED_ORIGINS, isOriginAllowed, createRateLimiter } from "./security.js";
import { validateImages, ImageError, MAX_WS_PAYLOAD } from "./images.js";

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

app.get("/api/model", async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: process.env.MODEL ?? "qwen3.5:latest" }),
    });
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };
    const data = (await res.json()) as {
      details?: { parameter_size?: string; quantization_level?: string };
      capabilities?: string[];
    };
    return {
      ok: true,
      model: process.env.MODEL ?? "qwen3.5:latest",
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
  dbmod.deleteSession(id);
  broadcast({ type: "session-deleted", id });
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
}

function parseOptions(raw: unknown): OllamaOptions & {
  provider: "ollama" | "openrouter";
  openrouterModel: string;
} {
  const o = (raw ?? {}) as Partial<ChatOptionsPayload>;
  return {
    model: process.env.MODEL ?? "qwen3.5:latest",
    think: o.think !== false,
    temperature: clamp(Number(o.temperature ?? 0.7), 0, 2),
    numPredict: Math.min(Math.max(Number(o.numPredict ?? 2048), 64), 16384),
    provider: o.provider === "openrouter" ? "openrouter" : "ollama",
    openrouterModel:
      typeof o.openrouterModel === "string" &&
      /^[\w./:-]{3,120}$/.test(o.openrouterModel)
        ? o.openrouterModel
        : "anthropic/claude-sonnet-4.5",
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
    socket.send(JSON.stringify({ type: "user-message", message: userMsg }));
    broadcast({ type: "sessions-changed" });

    const opts = parseOptions(msg.options);
    const history = dbmod
      .listMessages(session.id)
      .slice(-24)
      .map((m) => {
        const imgs = dbmod.parseImages(m);
        return imgs.length
          ? { role: m.role, content: m.content, images: imgs }
          : { role: m.role, content: m.content };
      });

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
    };

    try {
      if (opts.provider === "openrouter") {
        const apiKey = getOpenRouterKey();
        if (!apiKey) throw new Error("OPENROUTER_API_KEY nicht gesetzt (.env fehlt)");
        await streamOpenRouter(
          history,
          typeof msg.systemPrompt === "string" && msg.systemPrompt.trim()
            ? (msg.systemPrompt as string)
            : undefined,
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
        await streamChat(
          history,
          typeof msg.systemPrompt === "string" && msg.systemPrompt.trim()
            ? (msg.systemPrompt as string)
            : undefined,
          opts,
          callbacks,
          activeAbort.signal,
        );
      }
      dbmod.updateAssistantMessage(assistantRow.id, full.trim(), thinking.trim() || null);
      socket.send(
        JSON.stringify({
          type: "done",
          messageId: assistantRow.id,
          aborted: activeAbort.signal.aborted,
        }),
      );
      broadcast({ type: "sessions-changed" });
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
