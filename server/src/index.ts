import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as dbmod from "./db.js";
import * as mem from "./memory.js";
import { streamChat, type ChatStats, type OllamaOptions } from "./ollama.js";
import { transcribeAudio, synthesizeSpeech, MAX_AUDIO_BYTES } from "./voice.js";
import {
  streamOpenRouter,
  listOpenRouterModels,
  getOpenRouterKey,
} from "./openrouter.js";
import { ALLOWED_ORIGINS, isOriginAllowed, createRateLimiter } from "./security.js";
import { validateImages, ImageError, MAX_WS_PAYLOAD } from "./images.js";
import { prepareFiles, FileError, fileBlock } from "./files.js";
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

/**
 * Wie lange auf die Freigabe eines bestätigungspflichtigen Werkzeugs gewartet
 * wird. Danach gilt "abgelehnt" — eine Antwort soll nicht ewig hängen, nur
 * weil niemand am Rechner sitzt.
 */
const CONFIRM_TIMEOUT_MS = 120_000;
/** Chats pro Minute und Verbindung. Bremst Schleifen und OpenRouter-Kosten. */
const CHAT_LIMIT_PER_MIN = 30;

/**
 * Effektive Kontextlänge eines geladenen Ollama-Modells.
 *
 * Nicht dasselbe wie die im Modell deklarierte Länge: qwen3.5 meldet 262144,
 * geladen läuft es je nach Ollama-Default aber mit 4096. Für einen ehrlichen
 * Füllstand zählt nur, womit das Modell tatsächlich läuft — und das steht in
 * /api/ps. Kurz gecacht, weil sich das nur beim Nachladen ändert.
 */
const CONTEXT_TTL_MS = 30_000;
const contextCache = new Map<string, { value: number; at: number }>();

async function effectiveContextLength(model: string): Promise<number | undefined> {
  const hit = contextCache.get(model);
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.value;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`);
    if (!res.ok) return hit?.value;
    const data = (await res.json()) as {
      models?: { name?: string; model?: string; context_length?: number }[];
    };
    const entry = (data.models ?? []).find(
      (m) => m.name === model || m.model === model,
    );
    if (!entry?.context_length) return hit?.value;
    contextCache.set(model, { value: entry.context_length, at: Date.now() });
    return entry.context_length;
  } catch {
    return hit?.value;
  }
}

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
const dreamLimiter = createRateLimiter(4, 60_000);

app.addContentTypeParser(
  ["application/octet-stream", "audio/*", "video/*"],
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/tools", async () => ({ ok: true, tools: toolNames() }));

app.get("/api/model", async (req, reply) => {
  const q = (req.query as { name?: string }).name;
  const name = q && /^[\w.:-]{2,80}$/.test(q) ? q : MODEL;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return reply.code(404).send({ ok: false, error: `Ollama HTTP ${res.status}` });
    const data = (await res.json()) as {
      details?: { parameter_size?: string; quantization_level?: string };
      capabilities?: string[];
    };
    return {
      ok: true,
      model: name,
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
  return { state: mem.getMemoryState(id), anchors: mem.listAnchorsAll() };
});

app.post("/api/sessions/:id/dream", async (req, reply) => {
  if (!dreamLimiter(req.ip)) {
    return reply.code(429).send({ error: "Zu viele Anfragen" });
  }
  const { id } = req.params as { id: string };
  if (!dbmod.getSession(id)) return reply.code(404).send({ error: "not found" });
  const result = await mem.dream(id, { ollamaUrl: OLLAMA_URL, model: MODEL });
  broadcast({ type: "memory-updated", sessionId: id, result });
  return result;
});

app.post("/api/sessions/:id/memory/rebuild", async (req, reply) => {
  if (!dreamLimiter(req.ip)) {
    return reply.code(429).send({ error: "Zu viele Anfragen" });
  }
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

// --- Ollama models ---
app.get("/api/ollama/models", async () => {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) return { ok: false, error: `Ollama HTTP ${res.status}` };
    const data = (await res.json()) as {
      models?: { name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }[];
    };
    return {
      ok: true,
      models: (data.models ?? []).map((m) => ({
        name: m.name,
        sizeGB: m.size ? Math.round(m.size / 1e8) / 10 : undefined,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
      })),
    };
  } catch (err) {
    app.log.error({ err }, "Ollama-Modellliste fehlgeschlagen");
    return { ok: false, error: "Ollama nicht erreichbar" };
  }
});

// --- Gebautes Frontend ---
//
// Nur wenn web/dist existiert: im Entwicklungsbetrieb liefert der
// Vite-Server das Frontend aus, dann soll hier nichts danebenstehen.
// Registrierung nach den API-Routen, damit /api und /ws Vorrang behalten.
const WEB_DIST = path.join(import.meta.dirname, "..", "..", "web", "dist");
const hasBuild = existsSync(path.join(WEB_DIST, "index.html"));

if (hasBuild) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) => {
    // API-Fehler bleiben JSON; alles andere bekommt die App.
    if (req.url.startsWith("/api")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
}

// --- WebSocket ---
interface ChatOptionsPayload {
  think: boolean;
  temperature: number;
  numPredict: number;
  provider?: string;
  openrouterModel?: string;
  tools?: boolean;
  model?: string;
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
    model:
      typeof o.model === "string" && /^[\w.:-]{2,80}$/.test(o.model)
        ? o.model
        : MODEL,
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
  // Mehrere Antworten können parallel laufen (zweite Nachricht bei laufendem
  // Stream). Ein einzelnes Feld würde beim Abbruch nur die letzte erwischen.
  const activeAborts = new Set<AbortController>();
  const pendingConfirms = new Map<string, { name: string; decide(ok: boolean): void }>();
  /** Werkzeuge, die der Nutzer für diese Verbindung generell freigegeben hat. */
  const alwaysAllowed = new Set<string>();
  const chatLimiter = createRateLimiter(CHAT_LIMIT_PER_MIN, 60_000);

  function denyAllConfirms() {
    for (const entry of [...pendingConfirms.values()]) entry.decide(false);
  }

  /**
   * Fragt den Nutzer, bevor ein Werkzeug mit Außenwirkung läuft. Bricht die
   * Verbindung weg oder bleibt die Antwort aus, gilt das als Ablehnung.
   */
  function confirmTool(
    messageId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (alwaysAllowed.has(name)) return Promise.resolve(true);
    if (socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);

    const id = randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => decide(false), CONFIRM_TIMEOUT_MS);
      function decide(approved: boolean) {
        clearTimeout(timer);
        pendingConfirms.delete(id);
        resolve(approved);
      }
      pendingConfirms.set(id, { name, decide });
      socket.send(
        JSON.stringify({
          type: "tool-confirm",
          id,
          messageId,
          name,
          // Ungekürzt: der Nutzer muss genau sehen, was rausgeht — bei
          // read_webpage ist die vollständige URL der eigentliche Punkt.
          args: JSON.stringify(args),
        }),
      );
    });
  }

  socket.on("close", denyAllConfirms);

  socket.on("message", async (raw: Buffer) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "invalid json" }));
      return;
    }

    if (msg.type === "tool-confirm-reply") {
      const entry = pendingConfirms.get(String(msg.id ?? ""));
      if (!entry) return;
      // Der Werkzeugname kommt aus dem Server-Zustand, nicht aus der Antwort:
      // sonst könnte eine Freigabe für ein Werkzeug ein anderes freischalten.
      if (msg.decision === "always") alwaysAllowed.add(entry.name);
      entry.decide(msg.decision === "allow" || msg.decision === "always");
      return;
    }

    if (msg.type === "abort") {
      for (const controller of activeAborts) controller.abort();
      denyAllConfirms();
      return;
    }

    if (msg.type !== "chat") return;

    if (!chatLimiter("chat")) {
      socket.send(
        JSON.stringify({ type: "error", error: "Zu viele Anfragen — kurz warten." }),
      );
      return;
    }

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

    let chatFiles: { name: string; content: string }[];
    try {
      chatFiles = await prepareFiles(msg.files);
    } catch (err) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: err instanceof FileError ? err.message : "Datei abgelehnt",
        }),
      );
      return;
    }

    // Ein Bild oder eine Datei allein ist eine gültige Anfrage — Text darf dann fehlen.
    if (!sessionId || (!content && images.length === 0 && chatFiles.length === 0)) {
      socket.send(JSON.stringify({ type: "error", error: "sessionId/content fehlt" }));
      return;
    }

    let session = dbmod.getSession(sessionId);
    if (!session) session = dbmod.createSession();
    dbmod.renameSessionIfDefault(
      session.id,
      content || chatFiles.map((f) => f.name).join(", ") || "Bild",
    );

    const userMsg = dbmod.insertMessage(session.id, "user", content, null, images, chatFiles);
    mem.appendEvent(session.id, "message", {
      role: "user",
      content,
      images: images.length,
      files: chatFiles.map((f) => ({ name: f.name, chars: f.content.length })),
    });
    socket.send(JSON.stringify({ type: "user-message", message: userMsg }));
    broadcast({ type: "sessions-changed" });

    const opts = parseOptions(msg.options);
    opts.sessionId = session.id;
    const history = dbmod.listMessages(session.id).slice(-opts.memorySteps).map((m) => {
      const imgs = dbmod.parseImages(m);
      let text = m.content;
      const msgFiles = dbmod.parseFiles(m);
      if (msgFiles.length) {
        text = (text ? text + "\n\n" : "") + msgFiles.map((f) => fileBlock(f.name, f.content)).join("\n\n");
      }
      const base: { role: string; content: string; images?: string[] } = {
        role: m.role,
        content: text,
      };
      return imgs.length ? { ...base, images: imgs } : base;
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

    const abort = new AbortController();
    activeAborts.add(abort);
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
      onToolConfirm(name: string, args: Record<string, unknown>) {
        return confirmTool(assistantRow.id, name, args);
      },
      async onStats(stats: ChatStats) {
        // Nur bei Ollama kennt der Server das echte Fenster; bei OpenRouter
        // steht die Kontextlänge in der Modellliste, die der Client schon hat.
        const contextLength =
          opts.provider === "ollama"
            ? await effectiveContextLength(opts.model)
            : undefined;
        socket.send(
          JSON.stringify({
            type: "stats",
            messageId: assistantRow.id,
            model: opts.provider === "ollama" ? opts.model : opts.openrouterModel,
            provider: opts.provider,
            contextLength,
            ...stats,
          }),
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
          abort.signal,
        );
      } else {
        await streamChat(history, system, opts, callbacks, abort.signal);
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
          aborted: abort.signal.aborted,
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
        abort.signal.aborted ||
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
      activeAborts.delete(abort);
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
  console.log(
    hasBuild
      ? "[agenttwo-tools] Frontend aus web/dist wird mit ausgeliefert"
      : "[agenttwo-tools] Kein web/dist — Frontend über 'npm run dev:web' (:5174)",
  );
});
