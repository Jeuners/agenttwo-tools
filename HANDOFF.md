# Handoff

Stand: 28.08.2026. Arbeitsnotiz für die nächste Sitzung — kein Teil der
Projektdokumentation, die steht im [README](README.md).

## Wo wir stehen

Auf `main`:

| Commit    | Inhalt                                                                                     |
|-----------|--------------------------------------------------------------------------------------------|
| `8a489df` | Werkzeug-Bestätigung, DNS-Pinning, Statistik-Leiste, Produktionsbetrieb (Squash aus PR #1) |
| `a36e366` | Mic-/Anhang-Icons als SVG, blinkender Warte-Cursor                                         |

Arbeitsverzeichnis sauber, `npm run typecheck` und `vite build` grün.

## Als Nächstes

### 1. Export und Snapshots

Anlass: Am 28.08. waren die vier Chats des Nutzers plötzlich weg. Rettbar
waren sie nur, weil die Löschungen noch im SQLite-WAL standen und der
Hauptfile den Stand des letzten Checkpoints hielt. Das war Glück, keine
Vorkehrung.

- **Export** eines Chats als Markdown (Nachrichten, Anhänge als Dateinamen,
  Werkzeugaufrufe optional). Naheliegender Ort: Button im Sidebar-Kontext
  oder `GET /api/sessions/:id/export`.
- **Snapshot** der Datenbank: beim Serverstart und danach täglich eine Kopie
  nach `server/backups/data-JJJJ-MM-TT.sqlite`, die letzten ~7 behalten.
  Wichtig: `VACUUM INTO` statt `cp` — das schreibt einen konsistenten Stand
  ohne WAL-Abhängigkeit. Verzeichnis in `.gitignore` aufnehmen.

### 2. Papierkorb statt Sofortlöschung

Der ✕-Button in `web/src/components/Sidebar.tsx:38` ruft `onDelete` ohne
jede Rückfrage. Am 28.08. sind so vier Chats mit 34 Nachrichten in 1,1
Sekunden verschwunden (vier Klicks, je ~250 ms auseinander, jeweils auf den
obersten Eintrag, der nach dem Löschen nachrückt).

- Spalte `deleted_at` in `sessions`; ✕ setzt sie, statt zu löschen
- Listenabfragen filtern `deleted_at IS NULL`
- Endgültiges Löschen nach 30 Tagen oder manuell im Papierkorb
- Optional zusätzlich: kurzes „Rückgängig" nach dem Klick

Eine reine Bestätigungsabfrage wäre billiger, aber schwächer — sie schützt
nicht vor dem schnellen Durchklicken, das hier genau passiert ist.

### 3. Datenbankpfad konfigurierbar machen (klein, aber Voraussetzung)

`server/src/db.ts:5` hat den Pfad fest verdrahtet. Jeder Testlauf schreibt
damit in die echte Datenbank des Nutzers — genau das hat am 28.08. Testchats
in seiner Historie hinterlassen. Eine Variable `DB_PATH` (Default wie
bisher) erlaubt Tests gegen eine Wegwerf-Datei und gehört vor allem, was
automatisiert testet.

## Später: geplante Aufgaben (Cron)

Idee des Nutzers, bewusst zurückgestellt. Passt gut — Werkzeug-Loop,
Gedächtnis und TTS liegen bereit, und mit `dreamTimers` (`index.ts:71`)
existiert schon ein kleiner Scheduler. Zwei Punkte entscheiden das Design:

**Bestätigungspflicht.** `read_webpage` und `remember` laufen nur nach
Freigabe, und ohne Rückkanal gilt „abgelehnt" (`tools/index.ts:107`). Ein
Job um 8 Uhr hat niemanden zum Fragen — ausgerechnet der nützlichste Job
würde zuverlässig scheitern. Auflösung: Freigabe wandert vom Ausführungs-
zum **Anlegezeitpunkt**. Beim Erstellen hakt der Nutzer die erlaubten
Werkzeuge an und sieht sie zusammen mit dem Prompt; der Job trägt diese
Allowlist als `ToolContext.confirm`. Das ist Einwilligung, nicht ihre
Umgehung.

Dabei eng bleiben: `remember` **nicht** in die Standard-Allowlist. Ein
unbeaufsichtigter Job, der Fremdinhalt liest und daraus dauerhafte „Fakten
über den Nutzer" ableitet, ist genau die Kette, die der Security-Review
geschlossen hat. Jeder Job schreibt in einen eigenen Chat.

**Laufzeit.** Cron feuert nur, solange der Server läuft; gestartet wird er
heute von Hand. Statt launchd lieber Verpasstes beim nächsten Start
nachholen — deutlich weniger Systemeingriff.

## Offen beim Nutzer

- Die vier wiederhergestellten Chats: unklar, ob die Löschung am 28.08. um
  15:02 Absicht war. Falls ja, gehören sie wieder raus. Sicherungen liegen
  in `~/agenttwo-backups/` (`vor-wal.sqlite` = 8 Sessions inkl. vier
  Testchats, `geloeschter-stand.sqlite*` = leerer Stand).
- Static-Serving im Entwicklungsbetrieb: seit `8a489df` liefert `:8788` auch
  `web/dist` aus, sobald ein Build existiert — ein Standbild neben dem
  lebenden Vite auf `:5174`. Abschaltbar über `NODE_ENV` im `dev`-Script,
  bisher nicht gemacht.

## Fallstricke, teuer gelernt

- **`gh` zielt auf das falsche Repo.** Es löst auf `Jeuners/agenttwo` (das
  `upstream`-Remote) auf, nicht auf `agenttwo-tools`. Ohne
  `--repo Jeuners/agenttwo-tools` scheitert `gh pr create` mit einem
  irreführenden „No commits between". Dauerhaft:
  `gh repo set-default Jeuners/agenttwo-tools`.
- **Ollamas Kontextfenster ist nicht das deklarierte.** qwen3.5 meldet
  262144, geladen läuft es mit 4096. Der wahre Wert steht in
  `GET /api/ps`, nicht in `/api/show`.
- **Emoji lassen sich nicht einfärben.** `🎙` und `📎` sind in den Fonts fest
  grau. Zustandsfarben in CSS verpuffen an ihnen — deshalb jetzt SVG mit
  `currentColor`.
- **`.caret` ist belegt** (Aufklapp-Dreieck des Denkprozesses). Der
  Warte-Cursor heißt `.stream-caret`.
- **`onStats` muss vor `onDone` abgewartet werden.** Der `/api/ps`-Lookup ist
  asynchron; ohne `await` geht die Stats-Nachricht hinter dem `done` raus und
  der Client verwirft sie. Fiel nur auf, weil der erste (ungecachte) Lauf
  leer blieb und der zweite nicht.
- **OpenRouters `usage` kommt nach `finish_reason`.** Ein früher Return
  verschluckt die Tokenzahlen. Es braucht `stream_options.include_usage`.
- **Werkzeuge ohne Rückkanal werden abgelehnt.** Skripte und Tests, die
  `runTool` direkt aufrufen, bekommen bei bestätigungspflichtigen Werkzeugen
  „abgelehnt". Das ist Absicht — beim Testen ein `confirm` mitgeben.
