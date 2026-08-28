#!/usr/bin/env bash
#
# agenttwo-tools — Installationsroutine für macOS
# Prüft alle Abhängigkeiten und bietet fehlende Komponenten zur Installation an.
#
#   ./setup.sh           interaktiv (fragt vor jeder Installation)
#   ./setup.sh --check   prüft nur, ändert nichts
#   ./setup.sh --yes     installiert alles Fehlende ohne Nachfragen
#
set -u

cd "$(dirname "$0")"

AUTO=0
CHECK=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y) AUTO=1 ;;
    --check|-c) CHECK=1 ;;
    *) echo "Unbekannte Option: $arg"; exit 1 ;;
  esac
done

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BOLD='\033[1m'; OFF='\033[0m'
ok()   { printf "  ${GREEN}✓${OFF} %s\n" "$1"; }
warn() { printf "  ${YELLOW}!${OFF} %s\n" "$1"; }
fail() { printf "  ${RED}✗${OFF} %s\n" "$1"; }
sect() { printf "\n${BOLD}== %s ==${OFF}\n" "$1"; }

MISSING=0
note_missing() { MISSING=$((MISSING + 1)); }

have() { command -v "$1" >/dev/null 2>&1; }

ask() {
  if [ "$AUTO" -eq 1 ]; then echo "  → --yes: installiere automatisch"; return 0; fi
  printf "  ${BOLD}%s installieren? [J/n] ${OFF}" "$1"
  read -r answer
  [ -z "$answer" ] || [ "$answer" = "j" ] || [ "$answer" = "J" ] || [ "$answer" = "ja" ]
}

# .env lesen (nur einfache KEY=VALUE-Zeilen), ohne sie zu verändern
env_var() {
  if [ -f .env ]; then
    grep -E "^\s*$1=" .env | head -1 | cut -d= -f2- | sed 's/^["'\'']//; s/["'\'']$//'
  fi
}

MODEL="$(env_var MODEL)"; MODEL="${MODEL:-qwen3.5:latest}"
WHISPER_MODEL="$(env_var WHISPER_MODEL)"; WHISPER_MODEL="${WHISPER_MODEL:-$HOME/whisper-models/ggml-large-v3-turbo.bin}"
WHISPER_MODEL="${WHISPER_MODEL/#\~/$HOME}"
PIPER_MODEL="$(env_var PIPER_MODEL)"; PIPER_MODEL="${PIPER_MODEL:-server/voices/de_DE-thorsten-high.onnx}"
OLLAMA_URL="$(env_var OLLAMA_URL)"; OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

sect "agenttwo-tools — Setup"
echo "Ziel: lauffähiger Voice-Chat auf diesem Mac (alles lokal)."
echo "Modell: $MODEL · Ollama: $OLLAMA_URL"

sect "1/9 macOS"
if [ "$(uname -s)" = "Darwin" ]; then
  ok "macOS $(sw_vers -productVersion 2>/dev/null) · $(uname -m)"
else
  fail "Kein macOS — dieses Skript ist für macOS geschrieben."
  exit 1
fi

sect "2/9 Homebrew"
if have brew; then
  ok "brew $(brew --version | head -1 | awk '{print $2}')"
else
  note_missing
  warn "Homebrew fehlt (Paketbasis für fast alles Weitere)."
  if [ "$CHECK" -eq 0 ] && ask "Homebrew"; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew-Installation fehlgeschlagen"
    if [ "$(uname -m)" = "arm64" ] && ! have brew; then
      echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
      eval "$(/opt/homebrew/bin/brew shellenv)"
    fi
    have brew && ok "Homebrew installiert" || fail "brew weiterhin nicht gefunden — Terminal neu starten und Skript erneut laufen lassen"
  fi
fi

sect "3/9 Node.js 22+"
NODE_OK=0
if have node; then
  NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "${NODE_MAJOR:-0}" -ge 22 ]; then
    ok "node $(node -v)"
    NODE_OK=1
  else
    warn "node $(node -v) ist zu alt (mind. v22, wegen node:sqlite)."
  fi
fi
if [ "$NODE_OK" -eq 0 ]; then
  note_missing
  if [ "$CHECK" -eq 0 ] && have brew && ask "Node.js 22 (brew install node@22)"; then
    brew install node@22 && brew link --overwrite node@22
    have node && ok "node $(node -v)" || fail "node weiterhin nicht gefunden — Terminal neu starten"
  fi
fi

sect "4/9 Projekt-Abhängigkeiten (npm)"
if [ -d node_modules ] && [ -x node_modules/.bin/tsx ] && [ -x node_modules/.bin/vite ]; then
  ok "node_modules vorhanden"
else
  note_missing
  if [ "$CHECK" -eq 0 ] && have npm && ask "npm install"; then
    npm install && ok "Abhängigkeiten installiert" || fail "npm install fehlgeschlagen"
  fi
fi

sect "5/9 ffmpeg"
if have ffmpeg; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  note_missing
  if [ "$CHECK" -eq 0 ] && have brew && ask "ffmpeg (brew install ffmpeg)"; then
    brew install ffmpeg && ok "ffmpeg installiert" || fail "ffmpeg-Installation fehlgeschlagen"
  fi
fi

sect "6/9 whisper.cpp (Spracheingabe)"
if have whisper-cli; then
  ok "whisper-cli gefunden"
else
  note_missing
  if [ "$CHECK" -eq 0 ] && have brew && ask "whisper.cpp (brew install whisper-cpp)"; then
    brew install whisper-cpp && ok "whisper-cli installiert" || fail "whisper-cpp-Installation fehlgeschlagen"
  fi
fi
if [ -f "$WHISPER_MODEL" ]; then
  ok "Whisper-Modell: $(basename "$WHISPER_MODEL") ($(( $(stat -f%z "$WHISPER_MODEL") / 1024 / 1024 )) MB)"
else
  note_missing
  warn "Whisper-Modell fehlt: $WHISPER_MODEL (~1,5 GB Download)."
  if [ "$CHECK" -eq 0 ] && ask "Whisper-Modell herunterladen"; then
    mkdir -p "$(dirname "$WHISPER_MODEL")"
    curl -L -o "$WHISPER_MODEL" \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin" \
      && ok "Whisper-Modell geladen" || fail "Download fehlgeschlagen"
  fi
fi

sect "7/9 Piper (Sprachausgabe)"
if python3 -m piper --help >/dev/null 2>&1; then
  ok "piper (python3 -m piper)"
else
  note_missing
  warn "piper fehlt. Hinweis: Homebrew-Python verweigert pip oft (externally-managed)."
  if [ "$CHECK" -eq 0 ] && ask "piper-tts"; then
    pip3 install piper-tts 2>/dev/null \
      || pip3 install --user piper-tts 2>/dev/null \
      || pip3 install --break-system-packages piper-tts
    python3 -m piper --help >/dev/null 2>&1 && ok "piper installiert" \
      || fail "piper weiterhin nicht nutzbar — manuell: pipx install piper-tts oder venv"
  fi
fi
if [ -f "$PIPER_MODEL" ]; then
  ok "Piper-Stimme: $(basename "$PIPER_MODEL")"
else
  note_missing
  warn "Piper-Stimme fehlt: $PIPER_MODEL (~110 MB Download)."
  if [ "$CHECK" -eq 0 ] && ask "Piper-Stimme herunterladen"; then
    mkdir -p "$(dirname "$PIPER_MODEL")"
    curl -L -o "$PIPER_MODEL" \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/high/$(basename "$PIPER_MODEL")" \
      && ok "Stimme geladen" || fail "Download fehlgeschlagen"
  fi
fi

sect "8/9 Ollama"
OLLAMA_SVC=0
if have ollama; then
  ok "ollama $(ollama --version 2>/dev/null | awk '{print $NF}')"
else
  note_missing
  warn "Ollama fehlt (führt das Sprachmodell lokal aus)."
  if [ "$CHECK" -eq 0 ] && ask "Ollama (brew install ollama)"; then
    brew install ollama && ok "Ollama installiert" || fail "Ollama-Installation fehlgeschlagen"
  fi
fi
if curl -s --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  ok "Ollama-Server erreichbar ($OLLAMA_URL)"
  OLLAMA_SVC=1
else
  note_missing
  warn "Ollama-Server läuft nicht auf $OLLAMA_URL."
  if [ "$CHECK" -eq 0 ] && have ollama && ask "Ollama-Server starten (ollama serve im Hintergrund)"; then
    nohup ollama serve >/dev/null 2>&1 & disown
    sleep 3
    if curl -s --max-time 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
      ok "Ollama-Server läuft"
      OLLAMA_SVC=1
    else
      fail "Server nicht erreichbar — App „Ollama“ öffnen oder 'ollama serve' manuell starten"
    fi
  fi
fi

sect "9/9 Sprachmodell ($MODEL)"
MODEL_OK=0
if [ "$OLLAMA_SVC" -eq 1 ]; then
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$MODEL"; then
    ok "$MODEL ist geladen"
    MODEL_OK=1
  else
    note_missing
    warn "$MODEL fehlt (Download je nach Modell mehrere GB)."
    if [ "$CHECK" -eq 0 ] && have ollama && ask "ollama pull $MODEL"; then
      ollama pull "$MODEL" && ok "$MODEL geladen" || fail "Modell-Download fehlgeschlagen"
    fi
  fi
else
  warn "Ohne laufenden Ollama-Server keine Modellprüfung möglich."
fi

sect "Ergebnis"
if [ "$MISSING" -eq 0 ]; then
  printf "${GREEN}Alles bereit!${OFF} Starten mit:\n\n  npm run dev\n  → http://localhost:5174\n"
else
  printf "${YELLOW}%s Punkt(e) offen.${OFF} Skript erneut laufen lassen (fehlende Teile werden nachinstalliert), dann:\n\n  npm run dev\n  → http://localhost:5174\n" "$MISSING"
fi
printf "\nOptional (nur für Cloud-Fallback): OPENROUTER_API_KEY in die .env eintragen.\n"
[ "$CHECK" -eq 1 ] && [ "$MISSING" -gt 0 ] && exit 1
exit 0
