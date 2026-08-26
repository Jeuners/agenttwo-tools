# agenttwo-tools

> Fork von [agenttwo](https://github.com/Jeuners/agenttwo). Die Basis bleibt dort
> unverändert; hier kommen Vision und Werkzeuge (Tool-Calling) dazu. Läuft auf eigenen Ports
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

## Bilder (Vision)

`qwen3.5` bringt die Fähigkeit `vision` mit, deshalb versteht der Chat Bilder.
Anhängen geht auf drei Wegen: Button 🖼 im Composer, Einfügen aus der
Zwischenablage (⌘V) oder Drag & Drop auf die Eingabezeile. Eine Nachricht darf
auch nur aus einem Bild bestehen.

Bilder werden zusammen mit der Nachricht in der SQLite-Datei abgelegt und bei
Folgefragen erneut mitgeschickt, sodass Rückfragen zum selben Bild funktionieren.
Für Ollama gehen sie als `images: [base64]` raus, für OpenRouter im
OpenAI-Format als `image_url` mit data-URL — der MIME-Typ wird dabei aus den
Magic Bytes bestimmt.

Grenzen (`server/src/images.ts`): maximal 4 Bilder pro Nachricht, je 6 MB,
nur PNG, JPEG, GIF und WebP. Der Typ wird an den Magic Bytes geprüft, nicht am
angegebenen Dateinamen; der WebSocket hat dafür ein Payload-Limit von 32 MB.

Ob das eingestellte Modell Bilder kann, verrät:

```bash
curl -s http://localhost:11434/api/show -d '{"name":"qwen3.5:latest"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['capabilities'])"
```

## Werkzeuge (Tool-Calling)

`qwen3.5` meldet die Fähigkeit `tools`. Der Server schickt bei jeder Anfrage
eine Werkzeugliste mit; will das Modell eines benutzen, wird es ausgeführt und
das Ergebnis zurückgereicht, bis eine Antwort ohne Werkzeugwunsch entsteht
(maximal `MAX_TOOL_ROUNDS` = 5 Runden, je 15 s Zeitlimit). Abschalten lässt
sich das in den Einstellungen.

| Werkzeug | Zweck |
|---|---|
| `get_time` | Datum, Uhrzeit, Wochentag für eine IANA-Zeitzone |
| `calculate` | Arithmetik mit eigenem Parser |
| `read_file` | Textdatei unterhalb des Projektverzeichnisses lesen |
| `list_files` | Verzeichnis auflisten |

Aktuelle Liste: `curl -s http://localhost:8788/api/tools`

### Grenzen

Alle Werkzeuge sind **ausschließlich lesend**. Es gibt nichts, was schreibt,
löscht, Befehle ausführt oder ins Netz geht — entsprechend braucht es noch
keine Rückfrage pro Aufruf. Das Feld `requiresConfirmation` in
`tools/types.ts` ist bereits vorgesehen, damit die Bestätigungspflicht nicht
nachträglich eingezogen werden muss, sobald ein schreibendes Werkzeug dazukommt.

Der Dateizugriff liegt in einer Sandbox: Jeder Pfad wird über `realpath`
aufgelöst (löst auch Symlinks auf) und muss danach unterhalb der Wurzel liegen,
sonst wird abgelehnt. Die Wurzel ist standardmäßig das Projektverzeichnis und
über `TOOLS_ROOT` einstellbar. `.env`, `.git/` und Schlüsseldateien sind auch
innerhalb der Wurzel gesperrt.

`calculate` benutzt bewusst **kein** `eval` oder `new Function`: der Ausdruck
stammt aus einer Modellantwort, die von Nutzereingaben beeinflusst wird. Der
Parser in `tools/calculate.ts` kennt nur Zahlen und Grundrechenarten.

Werkzeugaufrufe werden in der Oberfläche über der Antwort angezeigt. Sie leben
nur im Browser-Zustand und sind nach einem Neuladen weg — im Gegensatz zu
Bildern, die in der Datenbank landen.

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
