# agenttwo-tools

Sprachfähige Chat-Oberfläche für lokale und Cloud-Sprachmodelle. Läuft
vollständig auf dem eigenen Rechner: Modell über [Ollama](https://ollama.com),
Spracheingabe über [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
Sprachausgabe über [Piper](https://github.com/rhasspy/piper). Der Weg nach
außen ist optional — [OpenRouter](https://openrouter.ai) lässt sich pro Chat
zuschalten.

- **Werkzeuge** — das Modell rechnet, liest Projektdateien, ruft Websites ab
  und führt ein eigenes Gedächtnis. Werkzeuge mit Außenwirkung fragen vorher
  nach.
- **Anhänge** — Bilder, Textdateien und PDFs, per Button, ⌘V oder Drag & Drop.
- **Gedächtnis** — Append-Only-Log plus destillierte Ankerpunkte, deterministisch
  aus dem Log rekonstruierbar.
- **Sprache** — Diktat und freihändiger Dialog, deutsche Stimme, alles lokal.
- **Messwerte** — Tokens, Durchsatz, Latenz und Kontext-Füllstand pro Antwort.

## Aufbau

npm-Workspace mit zwei Paketen:

| Pfad      | Inhalt                                                                  |
|-----------|-------------------------------------------------------------------------|
| `server/` | Fastify + WebSocket-Backend, Ollama-/OpenRouter-Bridge, STT/TTS, SQLite |
| `web/`    | React 18 + Vite Frontend, Markdown-Rendering, Voice-Recording           |

Der Chat läuft über einen WebSocket (`/ws`), alles andere über REST. Chats,
Nachrichten, Anhänge und Gedächtnis liegen in `server/data.sqlite`.

## Voraussetzungen

- **macOS** mit [Homebrew](https://brew.sh)
- **Node.js 22+** — `server/src/db.ts` nutzt das eingebaute `node:sqlite`,
  das es unter Node 20 noch nicht gibt. Unter Node 22 erscheint beim Start
  eine `ExperimentalWarning`; ab Node 24 ist das Modul stabil.
- [Ollama](https://ollama.com) mit einem Qwen3-Modell (`ollama pull qwen3.5`)
- `ffmpeg` und `whisper-cli` (whisper.cpp) im `PATH`, inklusive Whisper-Modell
- Piper als **Python-Modul** — der Server ruft `python3 -m piper` auf,
  nicht das gleichnamige Homebrew-Binary

**RAM (Apple Silicon):** qwen3.5 belegt ~7 GB — mit weniger als 16 GB RAM wird
es eng. Dann das kleinere [`qwen3:8b`](https://ollama.com/library/qwen3)
(`ollama pull qwen3:8b`, ~5 GB) nehmen und in den Einstellungen unter
„Lokales Modell“ wählen oder `MODEL=qwen3:8b` in die `.env` schreiben.

## Schnellstart

`setup.sh` prüft alle Abhängigkeiten und bietet fehlende zur Installation an —
Homebrew, Node, ffmpeg, whisper.cpp, Piper, Ollama, Modell und Sprachdateien:

```bash
git clone https://github.com/Jeuners/agenttwo-tools.git
cd agenttwo-tools
./setup.sh          # oder: npm run setup
npm run dev         # → http://localhost:5174
```

| Aufruf               | Wirkung                                   |
|----------------------|-------------------------------------------|
| `./setup.sh`         | Fragt vor jeder Installation nach         |
| `./setup.sh --check` | Prüft nur, ändert nichts                  |
| `./setup.sh --yes`   | Installiert alles Fehlende ohne Rückfrage |

### Manuell

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

Whisper-Modell (~1,5 GB), per Default unter
`~/whisper-models/ggml-large-v3-turbo.bin` erwartet:

```bash
mkdir -p ~/whisper-models
curl -L -o ~/whisper-models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Piper-Stimme (109 MB, wegen GitHubs Dateilimit nicht im Repo — die zugehörige
`.onnx.json` liegt bereits dort):

```bash
mkdir -p server/voices
curl -L -o server/voices/de_DE-thorsten-high.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/de_DE-thorsten-high.onnx
```

## Konfiguration

`.env` im Projekt-Root, wird vom Server eingelesen und ist gitignored. Alle
Werte sind optional außer dem Schlüssel für den Cloud-Fallback:

```bash
OPENROUTER_API_KEY=sk-or-...
```

| Variable          | Default                                    | Zweck                                                |
|-------------------|--------------------------------------------|------------------------------------------------------|
| `PORT`            | `8788`                                     | Port des Backends                                    |
| `OLLAMA_URL`      | `http://localhost:11434`                   | Adresse des Ollama-Servers                           |
| `MODEL`           | `qwen3.5:latest`                           | Lokales Standardmodell                               |
| `WHISPER_MODEL`   | `~/whisper-models/ggml-large-v3-turbo.bin` | Modelldatei für die Spracherkennung                  |
| `WHISPER_LANG`    | `de`                                       | Sprache der Spracherkennung                          |
| `PIPER_MODEL`     | `server/voices/de_DE-thorsten-high.onnx`   | Stimme für die Sprachausgabe                         |
| `TOOLS_ROOT`      | Projektverzeichnis                         | Wurzel der Datei-Sandbox                             |
| `ALLOWED_ORIGINS` | (leer)                                     | Zusätzliche Origins, siehe [Sicherheit](#sicherheit) |

`MODEL` ist nur der Startwert: In den Einstellungen lässt sich das lokale
Modell pro Chat über das Dropdown „Lokales Modell“ wechseln — die Liste kommt
live von `GET /api/ollama/models`.

## Anhänge

Anhängen geht über den Button 📎, aus der Zwischenablage (⌘V) oder per
Drag & Drop auf die Eingabezeile. Eine Nachricht darf auch nur aus einem
Anhang bestehen.

**Bilder** setzen ein Modell mit der Fähigkeit `vision` voraus — qwen3.5 bringt
sie mit. Sie werden zusammen mit der Nachricht gespeichert und bei Folgefragen
erneut mitgeschickt, sodass Rückfragen zum selben Bild funktionieren. Für
Ollama gehen sie als `images: [base64]` raus, für OpenRouter im OpenAI-Format
als `image_url` mit data-URL.

**Text- und PDF-Dateien** landen als formatierter Block im Kontext und werden
ebenfalls gespeichert. Unterstützt sind `.txt .json .md .csv .yaml .xml .sql`
und gängige Code-Endungen, dazu `.pdf` — der Text wird serverseitig mit
[pdf-parse](https://www.npmjs.com/package/pdf-parse) extrahiert. Gescannte PDFs
ohne Textebene werden abgewiesen, OCR gibt es nicht.

| Grenze               | Bilder (`images.ts`) | Dateien (`files.ts`)           |
|----------------------|----------------------|--------------------------------|
| Anzahl pro Nachricht | 4                    | 4                              |
| Größe                | 6 MB je Bild         | 10 MB je PDF                   |
| Umfang im Kontext    | —                    | 100 kB extrahierter Text       |
| Typprüfung           | Magic Bytes          | Steuerzeichen erkennen Binäres |

Der Typ wird an den Magic Bytes geprüft, nicht am Dateinamen; erlaubt sind
PNG, JPEG, GIF und WebP. Der WebSocket hat ein Payload-Limit von 32 MB. Zu
lange PDF-Texte werden gekürzt, nicht abgelehnt.

Ob das eingestellte Modell Bilder kann:

```bash
curl -s http://localhost:11434/api/show -d '{"name":"qwen3.5:latest"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['capabilities'])"
```

## Werkzeuge

Der Server schickt bei jeder Anfrage eine Werkzeugliste mit. Will das Modell
eines benutzen, wird es ausgeführt und das Ergebnis zurückgereicht, bis eine
Antwort ohne Werkzeugwunsch entsteht — maximal `MAX_TOOL_ROUNDS` = 5 Runden,
je 15 s Zeitlimit. Abschalten lässt sich das in den Einstellungen.

| Werkzeug       | Zweck                                                       |
|----------------|-------------------------------------------------------------|
| `get_time`     | Datum, Uhrzeit, Wochentag für eine IANA-Zeitzone            |
| `calculate`    | Arithmetik mit eigenem Parser                               |
| `read_file`    | Textdatei unterhalb der Sandbox-Wurzel lesen                |
| `list_files`   | Verzeichnis auflisten                                       |
| `recall`       | Gedächtnis nach Ankerpunkten durchsuchen                    |
| `remember`     | Ankerpunkt ins Gedächtnis schreiben — **mit Rückfrage**     |
| `read_webpage` | Website laden, Hauptinhalt als Markdown — **mit Rückfrage** |

Aktuelle Liste: `curl -s http://localhost:8788/api/tools`

### Rückfrage vor Werkzeugen mit Außenwirkung

Werkzeuge mit `requiresConfirmation` laufen erst nach Freigabe. Der Server
fragt über den WebSocket an, die Oberfläche zeigt Werkzeugname und die
**vollständigen** Argumente, und erst die Antwort löst die Ausführung aus:

| Antwort         | Wirkung                                                            |
|-----------------|--------------------------------------------------------------------|
| Ablehnen        | Werkzeug läuft nicht; das Modell erfährt das und macht ohne weiter |
| Einmal zulassen | Nur dieser eine Aufruf                                             |
| Immer zulassen  | Dieses Werkzeug bis zum Neuladen der Seite, je Verbindung          |

Ohne Antwort gilt nach 2 Minuten „abgelehnt“ — ebenso bei Verbindungsabbruch
und beim Stoppen der Antwort. Läuft ein Werkzeug ohne Rückkanal, etwa in einem
Skript, wird es abgelehnt statt ungefragt ausgeführt: die Bestätigung soll sich
nicht dadurch umgehen lassen, dass niemand zum Fragen da ist.

### Grenzen

Kein Werkzeug führt Befehle aus oder verändert Dateien. Zwei haben trotzdem
Außenwirkung und sind deshalb bestätigungspflichtig:

- **`read_webpage`** verlässt den Rechner. Die URL selbst ist dabei der
  kritische Teil: Fremdinhalt kann das Modell anweisen, Gesprächsinhalte in
  eine Adresse zu packen und so nach außen zu geben. Deshalb sieht der Nutzer
  die vollständige URL vor dem Abruf.
- **`remember`** schreibt dauerhaft und sessionübergreifend. Vom Modell
  gesetzte Anker werden **nicht** gepinnt und verfallen normal; gepinnt wird
  nur, was der Nutzer im Gedächtnis-Panel selbst mit ★ markiert.

Der Abruf in `read_webpage` ist mehrfach geguardet: nur http/https, private
Adressbereiche abgewiesen (auch über Weiterleitungen), 15 s Zeitlimit, 2 MB
Fetch-Limit, 25 kB Output-Cap. Die DNS-Auflösung ist **an die Verbindung
gepinnt** (`lookup`-Hook in `tools/web.ts`) — geprüft wird genau die Adresse,
die dann auch verbunden wird. Ein getrennter Vorab-Check, wie ihn `fetch`
erzwingt, ließe DNS-Rebinding zu: öffentlich beim Prüfen, `127.0.0.1` beim
Verbinden. Der Inhalt wird dem Modell zusätzlich als nicht vertrauenswürdig
markiert.

Der Dateizugriff liegt in einer Sandbox: Jeder Pfad wird über `realpath`
aufgelöst — das löst auch Symlinks auf — und muss danach unterhalb der Wurzel
liegen. `.env`, `.git/` und Schlüsseldateien sind auch innerhalb der Wurzel
gesperrt.

`calculate` benutzt bewusst **kein** `eval` oder `new Function`: der Ausdruck
stammt aus einer Modellantwort, die von Nutzereingaben beeinflusst wird. Der
Parser in `tools/calculate.ts` kennt nur Zahlen und Grundrechenarten.

Ein Abbruch über „Stop“ beendet auch ein laufendes Werkzeug — `ctx.signal`
kombiniert Abbruch und Zeitlimit und wirkt bis in den offenen Netzwerkabruf.

Werkzeugaufrufe werden über der Antwort angezeigt. Sie leben nur im
Browser-Zustand und sind nach einem Neuladen weg, anders als Anhänge.

## Statistik-Leiste

Über dem Eingabefeld stehen die Messwerte der letzten Antwort:

```text
3.891 ↑ · 127 ↓ · 34,5 tok/s · TTFT 0,6 s · 5,2 s · 2 Runden   ▬▬▬ 3.891 / 4.096   Σ 12.480 ↑ 2.143 ↓
```

| Wert       | Bedeutung                                                   |
|------------|-------------------------------------------------------------|
| `↑` / `↓`  | Tokens im Prompt / erzeugte Tokens                          |
| `tok/s`    | Erzeugte Tokens durch reine Generierungszeit                |
| `TTFT`     | Zeit bis zum ersten sichtbaren Token, Denken zählt mit      |
| Gesamtzeit | Wanduhr inklusive Werkzeuglaufzeit                          |
| Runden     | Erst ab 2 — jede Werkzeugrunde ist ein eigener Modellaufruf |
| Balken     | Prompt gegen das Kontextfenster, ab 90 % orange             |
| `Σ`        | Summe über den Chat, seit dem letzten Neuladen der Seite    |

Die Zahlen sind **gemessen, nicht geschätzt**: bei Ollama stammen sie aus dem
Abschluss-Chunk (`prompt_eval_count`, `eval_count`, `eval_duration`), bei
OpenRouter aus dem `usage`-Block, für den `stream_options.include_usage`
gesetzt wird — dort kommen die Kosten aus der Preisliste dazu. Während des
Streamens gibt es diese Werte noch nicht; solange zählt die Leiste die
eingehenden Chunks und markiert das mit `≈`.

Der Kontextbalken rechnet gegen das **tatsächlich genutzte** Fenster, das
Ollama unter `GET /api/ps` meldet — nicht gegen die im Modell deklarierte
Länge. Das ist nicht
dasselbe: qwen3.5 deklariert 262144, geladen läuft es je nach Ollama-Default
mit 4096. Gegen die deklarierte Länge stünde der Balken bei 1 %, während vorne
längst abgeschnitten wird.

## Gedächtnis

Drei Schichten:

| Schicht           | Speicher           | Zweck                                          |
|-------------------|--------------------|------------------------------------------------|
| Arbeitsgedächtnis | Nachrichtenfenster | Default 10 Schritte, geht ans Modell           |
| Episodisch        | `memory_events`    | Append-Only-Log: nur INSERT, nie UPDATE/DELETE |
| Semantisch        | `anchors`          | Ankerpunkte, destilliert in der Traumphase     |

Das Fenster ist in den Einstellungen per Slider einstellbar (2–100 Schritte).

### Traumphase

Die Traumphase konsolidiert neue Log-Einträge zu Ankerpunkten — bevorzugt per
LLM-Extraktion (JSON-Format, Temperatur 0.2), mit einer Regex-Heuristik als
Fallback. Sie läuft automatisch nach 3 Minuten Inaktivität oder wenn 10
Schritte unkonsolidiert sind, manuell über 🧠 **Gedächtnis** → „Traumphase
jetzt“.

Ankerpunkte haben eine Wichtigkeit (0–1), eine Art (`fact`, `decision`,
`preference`, `entity`, `open_question`) und einen Ursprung (`dream`, `model`,
`heuristic`, `test`). Ähnliche Anker werden zusammengeführt — Wort-Ähnlichkeit
≥ 0.5, `hits` steigt. Bei jedem Traumlauf verfallen ungepinnte Anker
(Wichtigkeit × 0.9); unter 0.15 und ohne Treffer werden sie gelöscht. Gepinnte
(★) bleiben.

Die wichtigsten Anker gehen als System-Kontext mit (Budget ~1200 Zeichen) —
das Modell beantwortet dann Fragen aus Inhalten, die nie im sichtbaren
Chatverlauf standen.

### Rekonstruktion

Weil das Log append-only ist, lässt sich der Zustand jederzeit deterministisch
aus Seq 0 neu falten: 🧠 **Gedächtnis** → „Aus Log rekonstruieren“, gepinnte
Anker bleiben erhalten. Die Eval der Heuristik und des Dream-Parsers:

```bash
npm run memory:eval --workspace server
```

## Sicherheit

Der Server hat **keine Authentifizierung** und lauscht deshalb bewusst nur auf
`127.0.0.1`. Das allein genügt nicht: Eine beliebige im Browser geöffnete
Webseite erreicht `localhost` per `fetch()` oder WebSocket. Deshalb prüfen
sowohl die HTTP-Endpunkte als auch der WebSocket-Handshake die `Origin` gegen
eine Allowlist (`server/src/security.ts`) — Standard sind `localhost` und
`127.0.0.1` auf Port 5174 und 8788. Läuft das Frontend woanders:

```bash
ALLOWED_ORIGINS=http://192.168.1.50:5174
```

Weitere Maßnahmen: Rate-Limits auf `/api/stt` (10/min), `/api/tts` (30/min),
Traumphase (4/min) und Chats je WebSocket-Verbindung (30/min);
Format-Whitelist per Magic Bytes vor dem `ffmpeg`-Aufruf; Fehlerdetails landen
im Server-Log statt in der HTTP-Antwort.

Bewusst **nicht** abgesichert: Anfragen ohne `Origin`-Header werden
durchgelassen. Für Browser-Clients trägt die Prüfung, weil `fetch` und
Formular-POSTs immer eine Origin senden — jedes lokale Programm kommt aber
ungefragt an die API. Für den Einzelplatzbetrieb ist das so gewollt.

Für externen Zugriff reicht ein Reverse-Proxy **nicht**. Davor gehört eine
echte Authentifizierung.

## API

| Endpunkt                           | Methode       | Zweck                            |
|------------------------------------|---------------|----------------------------------|
| `/ws`                              | WebSocket     | Chat-Stream, Werkzeug-Rückfragen |
| `/api/health`                      | GET           | Lebenszeichen                    |
| `/api/tools`                       | GET           | Registrierte Werkzeuge           |
| `/api/model?name=`                 | GET           | Fähigkeiten eines Ollama-Modells |
| `/api/ollama/models`               | GET           | Lokal verfügbare Modelle         |
| `/api/openrouter/models`           | GET           | Cloud-Modelle mit Preisen        |
| `/api/sessions`                    | GET, POST     | Chats auflisten, anlegen         |
| `/api/sessions/:id`                | DELETE        | Chat samt Gedächtnis löschen     |
| `/api/sessions/:id/messages`       | GET           | Verlauf eines Chats              |
| `/api/sessions/:id/memory`         | GET           | Zustand und Ankerpunkte          |
| `/api/sessions/:id/dream`          | POST          | Traumphase auslösen              |
| `/api/sessions/:id/memory/rebuild` | POST          | Aus dem Log rekonstruieren       |
| `/api/anchors/:id`                 | PATCH, DELETE | Anker pinnen, löschen            |
| `/api/stt`                         | POST          | Audio zu Text (Whisper)          |
| `/api/tts`                         | POST          | Text zu Audio (Piper)            |

## Entwicklung

```bash
npm install
npm run dev          # Server (:8788) und Vite-Dev-Server (:5174) parallel
npm run dev:server   # nur Backend
npm run dev:web      # nur Frontend
npm run typecheck    # beide Workspaces
```

Der Vite-Dev-Server leitet `/api` und `/ws` an das Backend weiter, deshalb
läuft die App unter `http://localhost:5174` aus einer Herkunft.

## Produktion

```bash
npm start            # baut web/dist und startet den Server
```

**Hinweis:** Der Server liefert das gebaute Frontend derzeit *nicht* aus — er
stellt nur die API auf `:8788` bereit, `web/dist` bleibt liegen. Für einen
Produktivbetrieb braucht es einen statischen Server davor, der `web/dist`
ausliefert und `/api` sowie `/ws` an `127.0.0.1:8788` weiterreicht. Für den
Alltagsbetrieb auf dem eigenen Rechner ist `npm run dev` der vorgesehene Weg.

Der Server bindet ausschließlich an `127.0.0.1`; zum Aussetzen ins Netz siehe
[Sicherheit](#sicherheit).
