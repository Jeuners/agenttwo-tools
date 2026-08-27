import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "./useChat";
import { useVoice } from "./useVoice";
import { Sidebar } from "./components/Sidebar";
import { ChatMessage } from "./components/ChatMessage";
import { Composer } from "./components/Composer";
import { MemoryPanel } from "./components/MemoryPanel";
import type { OpenRouterModel } from "./types";

const VOICE_KEY = "oxagenttwo.voiceMode";

export default function App() {
  const chat = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [injectedText, setInjectedText] = useState<string | null>(null);
  const [voiceMode, setVoiceModeState] = useState(
    () => localStorage.getItem(VOICE_KEY) === "1",
  );
  const [orModels, setOrModels] = useState<OpenRouterModel[]>([]);

  useEffect(() => {
    if (
      settingsOpen &&
      chat.options.provider === "openrouter" &&
      orModels.length === 0
    ) {
      fetch("/api/openrouter/models")
        .then((r) => r.json())
        .then((d: { ok: boolean; models?: OpenRouterModel[] }) => {
          if (d.ok && d.models) setOrModels(d.models);
        })
        .catch(() => {});
    }
  }, [settingsOpen, chat.options.provider, orModels.length]);

  const voiceModeRef = useRef(voiceMode);
  const streamingRef = useRef(false);
  const awaitingDrainRef = useRef(false);
  streamingRef.current = chat.streaming;
  voiceModeRef.current = voiceMode;

  const setVoiceMode = useCallback((on: boolean) => {
    setVoiceModeState(on);
    localStorage.setItem(VOICE_KEY, on ? "1" : "0");
  }, []);

  const voice = useVoice({
    onTranscript: (text) => {
      if (voiceModeRef.current) {
        voiceRef.current.cancelSpeech();
        pendingSpeechRef.current = "";
        chatRef.current.sendMessage(text);
      } else {
        setInjectedText(text);
      }
    },
    onQueueDrained: () => {
      if (awaitingDrainRef.current) {
        awaitingDrainRef.current = false;
        if (voiceModeRef.current && !streamingRef.current) {
          void voiceRef.current.startRecording();
        }
      }
    },
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const pendingSpeechRef = useRef("");
  const ttsCursorRef = useRef({ id: "", offset: 0 });

  // auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  // queue completed sentences for TTS while streaming
  useEffect(() => {
    if (!voiceMode) return;
    const lastAssistant = [...chat.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    if (!lastAssistant) return;

    if (ttsCursorRef.current.id !== lastAssistant.id) {
      ttsCursorRef.current = { id: lastAssistant.id, offset: 0 };
      pendingSpeechRef.current = "";
    }
    const content = lastAssistant.content;
    if (content.length < ttsCursorRef.current.offset) {
      ttsCursorRef.current.offset = content.length;
      return;
    }
    const delta = content.slice(ttsCursorRef.current.offset);
    if (!delta) return;
    pendingSpeechRef.current += delta;
    ttsCursorRef.current.offset = content.length;

    const buf = pendingSpeechRef.current;
    const matches = [...buf.matchAll(/[.!?…]+["')\]]?(?=\s|$)/g)];
    let speakPart = "";
    if (matches.length) {
      const lastMatch = matches[matches.length - 1];
      const end = lastMatch.index + lastMatch[0].length;
      if (end >= 40) speakPart = buf.slice(0, end);
    } else if (buf.length > 300) {
      const brk = Math.max(buf.lastIndexOf(", "), buf.lastIndexOf(" "));
      speakPart = brk > 100 ? buf.slice(0, brk + 1) : buf;
    }
    if (speakPart) {
      pendingSpeechRef.current = buf.slice(speakPart.length);
      voice.enqueueSpeech(speakPart);
    }
  });

  // flush remainder once streaming finished
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !chat.streaming && voiceMode) {
      const rest = pendingSpeechRef.current.trim();
      if (rest) {
        pendingSpeechRef.current = "";
        voice.enqueueSpeech(rest);
      }
      if (rest || ttsCursorRef.current.id) awaitingDrainRef.current = true;
    }
    wasStreamingRef.current = chat.streaming;
  }, [chat.streaming, voiceMode, voice]);

  const [toolNames, setToolNames] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/tools")
      .then((r) => r.json())
      .then((d: { tools?: string[] }) => setToolNames(d.tools ?? []))
      .catch(() => setToolNames([]));
  }, []);

  const handleSend = useCallback(
    (text: string, images: string[] = []) => {
      voice.cancelSpeech();
      pendingSpeechRef.current = "";
      chat.sendMessage(text, images);
    },
    [chat, voice],
  );

  const handleAbort = useCallback(() => {
    voice.cancelSpeech();
    pendingSpeechRef.current = "";
    chat.abort();
  }, [chat, voice]);

  const handleMicToggle = useCallback(() => {
    if (voice.recording) {
      voice.stopRecording();
    } else {
      voice.cancelSpeech();
      void voice.startRecording();
    }
  }, [voice]);

  return (
    <div className="app">
      <Sidebar
        sessions={chat.sessions}
        activeId={chat.activeId}
        onSelect={chat.setActiveId}
        onNew={() => void chat.newSession()}
        onDelete={(id) => void chat.deleteSession(id)}
      />

      <main className="main">
        <header className="topbar">
          <div
            className="model-badge"
            title={chat.modelInfo?.ok ? undefined : chat.modelInfo?.error}
          >
            <span
              className={`status-dot ${chat.status === "open" ? "on" : "off"}`}
            />
            {chat.options.provider === "openrouter"
              ? `☁ ${chat.options.openrouterModel}`
              : chat.modelInfo?.ok
                ? `${chat.modelInfo.model} · ${chat.modelInfo.parameterSize} · ${chat.modelInfo.quantization}`
                : "Ollama offline"}
          </div>
          <div className="topbar-actions">
            {voiceMode && (voice.recording || voice.transcribing || voice.speaking) && (
              <span className="voice-state">
                {voice.recording
                  ? "● hört zu"
                  : voice.transcribing
                    ? "… transkribiert"
                    : "🔊 spricht"}
              </span>
            )}
            <button
              className={`btn-settings ${voiceMode ? "toggled" : ""}`}
              onClick={() => {
                if (voiceMode) {
                  voice.cancelSpeech();
                  voice.stopRecording();
                }
                setVoiceMode(!voiceMode);
              }}
              title="Sprachmodus: Antworten werden vorgelesen, danach wird automatisch wieder zugehört"
            >
              {voiceMode ? "🔊 Stimme: an" : "🔇 Stimme: aus"}
            </button>
            <button
              className="btn-settings"
              onClick={() => setMemoryOpen((v) => !v)}
              disabled={!chat.activeId}
              title="Gedächtnis: Ankerpunkte, Traumphase, Log-Rekonstruktion"
            >
              🧠 Gedächtnis
            </button>
            <button
              className="btn-settings"
              onClick={() => setSettingsOpen((v) => !v)}
            >
              ⚙ Einstellungen
            </button>
          </div>
        </header>

        {settingsOpen && (
          <section className="settings-panel">
            <label className="setting-row">
              <span>Modell</span>
              <select
                className="provider-select"
                value={chat.options.provider}
                onChange={(e) =>
                  chat.setOptions({ provider: e.target.value as "ollama" | "openrouter" })
                }
              >
                <option value="ollama">Lokal: qwen3.5 (Ollama)</option>
                <option value="openrouter">OpenRouter (Cloud)</option>
              </select>
            </label>
            {chat.options.provider === "openrouter" && (
              <label className="setting-row column">
                <span>OpenRouter-Modell ({orModels.length} verfügbar)</span>
                <input
                  list="or-models"
                  value={chat.options.openrouterModel}
                  placeholder="z. B. anthropic/claude-sonnet-4.5"
                  onChange={(e) =>
                    chat.setOptions({ openrouterModel: e.target.value })
                  }
                />
                <datalist id="or-models">
                  {orModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} · {m.promptPrice === 0 ? "gratis" : `$${m.promptPrice.toFixed(2)}/M`}
                    </option>
                  ))}
                </datalist>
              </label>
            )}
            {chat.options.provider === "ollama" && (
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={chat.options.think}
                onChange={(e) => chat.setOptions({ think: e.target.checked })}
              />
              <span>Thinking-Mode (Modell denkt sichtbar vor der Antwort)</span>
            </label>
            )}
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={chat.options.tools}
                onChange={(e) => chat.setOptions({ tools: e.target.checked })}
              />
              <span>
                Werkzeuge ({toolNames.length > 0 ? toolNames.join(", ") : "keine geladen"})
              </span>
            </label>
            <label className="setting-row">
              <span>Temperature: {chat.options.temperature.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={1.5}
                step={0.05}
                value={chat.options.temperature}
                onChange={(e) =>
                  chat.setOptions({ temperature: Number(e.target.value) })
                }
              />
            </label>
            <label className="setting-row">
              <span>Max. Tokens: {chat.options.numPredict}</span>
              <input
                type="range"
                min={256}
                max={8192}
                step={256}
                value={chat.options.numPredict}
                onChange={(e) =>
                  chat.setOptions({ numPredict: Number(e.target.value) })
                }
              />
            </label>
            <label className="setting-row">
              <span>Gedächtnis-Fenster: {chat.options.memorySteps} Schritte</span>
              <input
                type="range"
                min={2}
                max={50}
                step={1}
                value={chat.options.memorySteps}
                onChange={(e) =>
                  chat.setOptions({ memorySteps: Number(e.target.value) })
                }
              />
            </label>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={chat.options.memoryAnchors}
                onChange={(e) =>
                  chat.setOptions({ memoryAnchors: e.target.checked })
                }
              />
              <span>
                Ankerpunkte ins Modell einspielen (Gedächtnis als System-Kontext)
              </span>
            </label>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={chat.options.dreamAuto}
                onChange={(e) => chat.setOptions({ dreamAuto: e.target.checked })}
              />
              <span>
                Auto-Traumphase (Konsolidierung nach 3 Min Inaktivität oder 10
                Schritten)
              </span>
            </label>
            <label className="setting-row column">
              <span>System-Prompt</span>
              <textarea
                rows={3}
                placeholder="Optional: Verhalten des Modells steuern …"
                value={chat.systemPrompt}
                onChange={(e) => chat.setSystemPrompt(e.target.value)}
              />
            </label>
          </section>
        )}

        {memoryOpen && chat.activeId && (
          <MemoryPanel
            sessionId={chat.activeId}
            onClose={() => setMemoryOpen(false)}
          />
        )}

        <div className="messages" ref={scrollRef}>
          {chat.messages.length === 0 && (
            <div className="welcome">
              <div className="welcome-title">▸ agenttwo-tools</div>
              <p>
                Echtzeit-Chat mit lokalem Qwen3 über Ollama — per Tastatur oder
                Stimme (Whisper STT + Piper TTS, alles lokal).
              </p>
              <p className="hint">
                🎙 für Sprachnachricht · 🔊 Stimme an für freihändigen Dialog
              </p>
            </div>
          )}
          {chat.messages.map((m) => (
            <ChatMessage key={m.id} message={m} toolEvents={chat.toolEvents[m.id]} />
          ))}
        </div>

        {voice.error && (
          <div className="voice-error">
            {voice.error}
            <button onClick={() => voice.setError(null)}>✕</button>
          </div>
        )}

        <Composer
          streaming={chat.streaming}
          disabled={!chat.activeId}
          recording={voice.recording}
          transcribing={voice.transcribing}
          injectedText={injectedText}
          onInjected={() => setInjectedText(null)}
          onSend={handleSend}
          onAbort={handleAbort}
          onMicToggle={handleMicToggle}
        />
      </main>
    </div>
  );
}
