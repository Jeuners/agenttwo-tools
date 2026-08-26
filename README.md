# oxagenttwo

Voice-Chat-Oberfläche für lokale und Cloud-LLMs: lokales Qwen3 über
[Ollama](https://ollama.com), optionaler Fallback auf
[OpenRouter](https://openrouter.ai), Spracheingabe via
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) und deutsche
Sprachausgabe via [Piper](https://github.com/rhasspy/piper) (Stimme: Thorsten).

## Aufbau

npm-Workspace mit zwei Paketen:

| Pfad      | Inhalt                                                                 |
|-----------|------------------------------------------------------------------------|
| `server/` | Fastify + WebSocket-Backend, Ollama-/OpenRouter-Bridge, STT/TTS, SQLite |
| `web/`    | React 18 + Vite Frontend, Markdown-Rendering, Voice-Recording           |

## Voraussetzungen

- Node.js 20+
- [Ollama](https://ollama.com) mit einem Qwen3-Modell (`ollama pull qwen3.5`)
- `ffmpeg` im `PATH`
- `whisper-cli` im `PATH` (whisper.cpp) inklusive Modell
- `piper` im `PATH`

Unter macOS:

```bash
brew install ffmpeg whisper-cpp piper
```

### Whisper-Modell

Wird per Default unter `~/whisper-models/ggml-large-v3-turbo.bin` erwartet:

```bash
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

### Piper-Stimme

Die Stimmdatei ist **nicht** im Repo (109 MB, über GitHubs Dateilimit).
Einmalig herunterladen:

```bash
mkdir -p server/voices
curl -L -o server/voices/de_DE-thorsten-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx
```

Die zugehörige `de_DE-thorsten-high.onnx.json` liegt bereits im Repo.

## Konfiguration

`.env` im Projekt-Root (wird vom Server eingelesen, ist gitignored):

```bash
OPENROUTER_API_KEY=sk-or-...
```

Weitere optionale Variablen mit ihren Defaults:

| Variable             | Default                                          |
|----------------------|--------------------------------------------------|
| `PORT`               | `8787`                                           |
| `OLLAMA_URL`         | `http://localhost:11434`                         |
| `MODEL`              | `qwen3.5:latest`                                 |
| `WHISPER_MODEL`      | `~/whisper-models/ggml-large-v3-turbo.bin`       |
| `WHISPER_LANG`       | `de`                                             |
| `PIPER_MODEL`        | `server/voices/de_DE-thorsten-high.onnx`         |

## Entwicklung

```bash
npm install
npm run dev          # Server (:8787) und Vite-Dev-Server (:5173) parallel
```

Einzeln:

```bash
npm run dev:server
npm run dev:web
```

Typecheck über beide Workspaces:

```bash
npm run typecheck
```

## Produktion

```bash
npm start            # baut das Frontend und startet den Server
```

Der Server bindet bewusst nur an `127.0.0.1` — für externen Zugriff einen
Reverse-Proxy davorschalten.
