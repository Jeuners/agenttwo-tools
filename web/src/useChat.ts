import { useCallback, useEffect, useRef, useState } from "react";
import { ChatSocket } from "./socket";
import type {
  ChatOptions,
  Message,
  Session,
  ToolConfirmRequest,
  ToolDecision,
  ToolEvent,
} from "./types";

export type ConnStatus = "connecting" | "open" | "closed";
export interface ModelInfo {
  ok: boolean;
  model?: string;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  error?: string;
}

const OPTIONS_KEY = "oxagenttwo.options";
const SESSION_KEY = "oxagenttwo.session";
const SYSTEM_KEY = "oxagenttwo.systemPrompt";

function loadOptions(): ChatOptions {
  const defaults: ChatOptions = {
    model: "qwen3.5:latest",
    think: true,
    tools: true,
    temperature: 0.7,
    numPredict: 2048,
    provider: "ollama",
    openrouterModel: "anthropic/claude-sonnet-4.5",
    memorySteps: 10,
    memoryAnchors: true,
    dreamAuto: true,
  };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaults;
}

export function useChat() {
  const socketRef = useRef<ChatSocket | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem(SESSION_KEY),
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [toolEvents, setToolEvents] = useState<Record<string, ToolEvent[]>>({});
  // Der Server fragt Werkzeuge einzeln und nacheinander an; die Queue ist die
  // Absicherung für den Fall, dass doch zwei Antworten parallel laufen.
  const [toolConfirms, setToolConfirms] = useState<ToolConfirmRequest[]>([]);
  const [options, setOptionsState] = useState<ChatOptions>(loadOptions);
  const [systemPrompt, setSystemPromptState] = useState(
    () => localStorage.getItem(SYSTEM_KEY) ?? "",
  );
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const streamingRef = useRef(false);

  // socket setup
  useEffect(() => {
    const sock = new ChatSocket();
    socketRef.current = sock;
    sock.onStatus = setStatus;

    const unsub = sock.subscribe((data) => {
      const t = data.type as string;
      if (t === "user-message") {
        const m = data.message as Message;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m],
        );
        // Legt der Server bei unbekannter sessionId einen neuen Chat an,
        // springt der Client mit — sonst landen Nachrichten "im Leeren".
        setActiveId((cur) => (cur === m.session_id ? cur : m.session_id));
      } else if (t === "assistant-start") {
        const m = data.message as Message;
        setMessages((prev) => [...prev, { ...m, content: "", thinking: "" }]);
      } else if (t === "thinking") {
        const text = data.text as string;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId
              ? { ...m, thinking: (m.thinking ?? "") + text }
              : m,
          ),
        );
      } else if (t === "token") {
        const text = data.text as string;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === data.messageId ? { ...m, content: m.content + text } : m,
          ),
        );
      } else if (t === "tool-call") {
        setToolEvents((prev) => ({
          ...prev,
          [data.messageId as string]: [
            ...(prev[data.messageId as string] ?? []),
            { name: data.name as string, args: data.args as string },
          ],
        }));
      } else if (t === "tool-result") {
        setToolEvents((prev) => {
          const list = prev[data.messageId as string] ?? [];
          // Ergebnis dem letzten offenen Aufruf desselben Werkzeugs zuordnen.
          const idx = [...list].reverse().findIndex(
            (e) => e.name === data.name && e.ok === undefined,
          );
          if (idx === -1) return prev;
          const realIdx = list.length - 1 - idx;
          const updated = list.map((e, i) =>
            i === realIdx
              ? { ...e, ok: data.ok as boolean, durationMs: data.durationMs as number }
              : e,
          );
          return { ...prev, [data.messageId as string]: updated };
        });
      } else if (t === "tool-confirm") {
        setToolConfirms((prev) => [
          ...prev,
          {
            id: data.id as string,
            messageId: data.messageId as string,
            name: data.name as string,
            args: data.args as string,
          },
        ]);
      } else if (t === "done" || t === "error") {
        streamingRef.current = false;
        setStreaming(false);
        // Der Server hat jede offene Rückfrage bereits selbst entschieden.
        setToolConfirms((prev) =>
          prev.filter((c) => c.messageId !== (data.messageId as string)),
        );
      } else if (t === "sessions-changed" || t === "session-deleted") {
        void refreshSessions();
      }
    });
    sock.connect();
    return () => {
      unsub();
      sock.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSessions = useCallback(async () => {
    const res = await fetch("/api/sessions");
    const list = (await res.json()) as Session[];
    setSessions(list);
    // Tote IDs (z. B. gelöschte Sessions) verfallen und fallen auf die neueste zurück.
    setActiveId((cur) =>
      cur && list.some((s) => s.id === cur) ? cur : (list[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  useEffect(() => {
    fetch(`/api/model?name=${encodeURIComponent(options.model)}`)
      .then((r) => r.json())
      .then(setModelInfo)
      .catch(() => setModelInfo({ ok: false, error: "Ollama nicht erreichbar" }));
  }, [options.model]);

  // load messages on session switch
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    localStorage.setItem(SESSION_KEY, activeId);
    streamingRef.current = false;
    setStreaming(false);
    fetch(`/api/sessions/${activeId}/messages`)
      .then((r) => r.json())
      .then((list: Message[]) => setMessages(Array.isArray(list) ? list : []))
      .catch(() => setMessages([]));
  }, [activeId]);

  const setOptions = useCallback((o: Partial<ChatOptions>) => {
    setOptionsState((prev) => {
      const next = { ...prev, ...o };
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const setSystemPrompt = useCallback((p: string) => {
    setSystemPromptState(p);
    localStorage.setItem(SYSTEM_KEY, p);
  }, []);

  const sendMessage = useCallback(
    (content: string, images: string[] = [], files: { name: string; content: string; encoding?: string }[] = []) => {
      // Ein Bild oder eine Datei allein ist eine gültige Anfrage.
      if ((!content.trim() && images.length === 0 && files.length === 0) || streamingRef.current || !activeId) {
        return;
      }
      streamingRef.current = true;
      setStreaming(true);
      socketRef.current?.send({
        type: "chat",
        sessionId: activeId,
        content,
        images,
        files,
        options,
        systemPrompt,
      });
    },
    [activeId, options, systemPrompt],
  );

  const abort = useCallback(() => {
    socketRef.current?.send({ type: "abort" });
    setToolConfirms([]);
  }, []);

  const decideToolConfirm = useCallback((id: string, decision: ToolDecision) => {
    socketRef.current?.send({ type: "tool-confirm-reply", id, decision });
    setToolConfirms((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const newSession = useCallback(async () => {
    const res = await fetch("/api/sessions", { method: "POST" });
    const s = (await res.json()) as Session;
    await refreshSessions();
    setActiveId(s.id);
  }, [refreshSessions]);

  const deleteSession = useCallback(
    async (id: string) => {
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveId((cur) => (cur === id ? null : cur));
      await refreshSessions();
    },
    [refreshSessions],
  );

  return {
    status,
    sessions,
    activeId,
    setActiveId,
    messages,
    streaming,
    toolEvents,
    toolConfirm: toolConfirms[0] ?? null,
    decideToolConfirm,
    sendMessage,
    abort,
    newSession,
    deleteSession,
    options,
    setOptions,
    systemPrompt,
    setSystemPrompt,
    modelInfo,
  };
}
