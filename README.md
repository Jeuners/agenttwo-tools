# agenttwo-tools

> Fork von [agenttwo](https://github.com/Jeuners/agenttwo). Die Basis bleibt dort
> unverändert; hier kommen Tool-Calling und Vision dazu. Läuft auf eigenen Ports
> (Backend 8788, Frontend 5174), damit beide Projekte parallel laufen können.
> Fixes aus der Basis lassen sich per `git cherry-pick` aus dem Remote
> `upstream` übernehmen.

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

- **Node.js 22+** — `server/src/db.ts` nutzt das eingebaute `node:sqlite`,
  das es unter Node 20 noch nicht gibt. Unter Node 22 erscheint beim Start
  eine `ExperimentalWarning`; ab Node 24 ist das Modul stabil.
- [Ollama](https://ollama.com) mit einem Qwen3-Modell (`ollama pull qwen3.5`)
- `ffmpeg` im `PATH`
- `whisper-cli` im `PATH` (whisper.cpp) inklusive Modell
- Piper als **Python-Modul** — der Server ruft `python3 -m piper` auf,
  nicht das gleichnamige Homebrew-Binary

Unter macOS:

```bash
brew install ffmpeg whisper-cpp
pip3 install piper-tts
```

Prüfen, ob alles bereitsteht:

```bash
ffmpeg -version >/dev/null 2>&1 && echo "ffmpeg OK"
whisper-cli --help >/dev/null 2>&1 && echo "whisper-cli OK"
python3 -m piper --help >/dev/null 2>&1 && echo "piper OK"
node -e "require('node:sqlite')" 2>/dev/null && echo "node:sqlite OK"
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
| `PORT`               | `8788`                                           |
| `OLLAMA_URL`         | `http://localhost:11434`                         |
| `MODEL`              | `qwen3.5:latest`                                 |
| `WHISPER_MODEL`      | `~/whisper-models/ggml-large-v3-turbo.bin`       |
| `WHISPER_LANG`       | `de`                                             |
| `PIPER_MODEL`        | `server/voices/de_DE-thorsten-high.onnx`         |
| `ALLOWED_ORIGINS`    | (leer — siehe Sicherheit)                        |

## Sicherheit

Der Server hat **keine Authentifizierung** und lauscht deshalb bewusst nur auf
`127.0.0.1`. Das allein genügt aber nicht: Eine beliebige Webseite, die im
Browser geöffnet ist, kann `localhost` per `fetch()` oder WebSocket erreichen.
Deshalb prüfen sowohl die HTTP-Endpunkte als auch der WebSocket-Handshake die
`Origin` gegen eine Allowlist (`server/src/security.ts`) — Standard sind
`localhost`/`127.0.0.1` auf Port 5174 und 8788.

Läuft das Frontend woanders, die Origin ergänzen:

```bash
ALLOWED_ORIGINS=http://192.168.1.50:5174
```

Weitere Maßnahmen: Rate-Limits auf `/api/stt` (10/min) und `/api/tts` (30/min),
Format-Whitelist per Magic Bytes vor dem `ffmpeg`-Aufruf, und Fehlerdetails
landen im Server-Log statt in der HTTP-Antwort.

Für externen Zugriff reicht ein Reverse-Proxy **nicht** — davor gehört eine
echte Authentifizierung.

## Entwicklung

```bash
npm install
npm run dev          # Server (:8788) und Vite-Dev-Server (:5174) parallel
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

Der Server bindet nur an `127.0.0.1`. Zum Aussetzen ins Netz siehe
[Sicherheit](#sicherheit).
