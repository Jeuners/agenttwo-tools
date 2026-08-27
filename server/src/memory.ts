import { db } from "./db.js";
import {
  ANCHOR_KINDS,
  heuristicAnchors,
  parseDreamAnchors,
  similarity,
  type AnchorKind,
} from "./memory-text.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS memory_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('message','tool_call')),
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_memory_events_session
    ON memory_events(session_id, seq);

  CREATE TABLE IF NOT EXISTS memory_state (
    session_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_dream_seq INTEGER NOT NULL DEFAULT 0,
    dream_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS anchors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'fact',
    importance REAL NOT NULL DEFAULT 0.5,
    hits INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'heuristic',
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_anchors_session
    ON anchors(session_id, importance);
`);

export interface MemoryEventRow {
  seq: number;
  session_id: string;
  type: "message" | "tool_call";
  payload: string;
  created_at: number;
}

export interface MemoryStateRow {
  session_id: string;
  last_seq: number;
  last_dream_seq: number;
  dream_count: number;
  updated_at: number;
}

export interface AnchorRow {
  id: number;
  session_id: string;
  text: string;
  kind: AnchorKind;
  importance: number;
  hits: number;
  pinned: number;
  origin: string;
  last_seq: number;
  created_at: number;
  updated_at: number;
}

export interface AnchorInput {
  text: string;
  kind?: AnchorKind;
  importance?: number;
  seq?: number;
  origin?: string;
  pinned?: boolean;
}

export interface DreamResult {
  ok: boolean;
  events: number;
  inserted: number;
  merged: number;
  pruned: number;
  source: "llm" | "heuristic" | "none";
  error?: string;
}

export interface DreamOptions {
  ollamaUrl: string;
  model: string;
  signal?: AbortSignal;
}

export function appendEvent(
  sessionId: string,
  type: "message" | "tool_call",
  payload: Record<string, unknown>,
): number {
  const res = db
    .prepare(
      "INSERT INTO memory_events (session_id, type, payload, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, type, JSON.stringify(payload), Date.now());
  return Number(res.lastInsertRowid);
}

export function listEvents(
  sessionId: string,
  afterSeq = 0,
): MemoryEventRow[] {
  return db
    .prepare(
      "SELECT * FROM memory_events WHERE session_id = ? AND seq > ? ORDER BY seq ASC",
    )
    .all(sessionId, afterSeq) as unknown as MemoryEventRow[];
}

export function getMemoryState(sessionId: string): MemoryStateRow {
  db.prepare(
    "INSERT OR IGNORE INTO memory_state (session_id, last_seq, last_dream_seq, dream_count, updated_at) VALUES (?, 0, 0, 0, ?)",
  ).run(sessionId, Date.now());
  return db
    .prepare("SELECT * FROM memory_state WHERE session_id = ?")
    .get(sessionId) as unknown as MemoryStateRow;
}

export function listAnchors(sessionId: string): AnchorRow[] {
  return db
    .prepare(
      "SELECT * FROM anchors WHERE session_id = ? ORDER BY pinned DESC, importance DESC, updated_at DESC",
    )
    .all(sessionId) as unknown as AnchorRow[];
}

function countAnchors(sessionId: string): number {
  return Number(
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM anchors WHERE session_id = ?")
        .get(sessionId) as { n: number }
    ).n,
  );
}

const SIMILARITY_THRESHOLD = 0.5;

/**
 * Fügt einen Ankerpunkt ein oder verstärkt einen vorhandenen. Dedupe über
 * Wort-Ähnlichkeit; Merge erhöht Treffer und nimmt die höhere Wichtigkeit.
 */
export function upsertAnchor(
  sessionId: string,
  input: AnchorInput,
): "inserted" | "merged" | "skipped" {
  const text = input.text.trim().replace(/\s+/g, " ").slice(0, 300);
  if (text.length < 6) return "skipped";
  const kind = ANCHOR_KINDS.includes(input.kind as AnchorKind)
    ? (input.kind as AnchorKind)
    : "fact";
  const importance = Number.isFinite(input.importance)
    ? Math.min(1, Math.max(0.1, Number(input.importance)))
    : 0.5;
  const now = Date.now();
  const pinned = input.pinned ? 1 : 0;

  const match = listAnchors(sessionId).find(
    (a) => similarity(a.text, text) >= SIMILARITY_THRESHOLD,
  );
  if (match) {
    db.prepare(
      "UPDATE anchors SET hits = hits + 1, importance = MAX(importance, ?), last_seq = MAX(last_seq, ?), pinned = MAX(pinned, ?), updated_at = ? WHERE id = ?",
    ).run(importance, input.seq ?? 0, pinned, now, match.id);
    return "merged";
  }

  const seq =
    input.seq ??
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM memory_events WHERE session_id = ?",
          )
          .get(sessionId) as { s: number }
      ).s,
    );
  db.prepare(
    "INSERT INTO anchors (session_id, text, kind, importance, hits, pinned, origin, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
  ).run(sessionId, text, kind, importance, pinned, input.origin ?? "heuristic", seq, now, now);
  return "inserted";
}

/**
 * Inkrementelle Rekonstruktion: faltet alle Events seit last_seq in
 * Ankerpunkte. Da das Log append-only ist, liefert Replay aus Seq 0 immer
 * denselben Zustand — Rekonstruktion ist damit deterministisch.
 */
export function foldSession(sessionId: string): {
  folded: number;
  anchors: number;
} {
  const state = getMemoryState(sessionId);
  const events = listEvents(sessionId, state.last_seq);
  let folded = 0;
  for (const ev of events) {
    if (ev.type !== "message") continue;
    let payload: { role?: string; content?: string };
    try {
      payload = JSON.parse(ev.payload) as { role?: string; content?: string };
    } catch {
      continue;
    }
    if (payload.role !== "user" || !payload.content) continue;
    for (const c of heuristicAnchors(payload.content)) {
      upsertAnchor(sessionId, { ...c, seq: ev.seq });
    }
    folded++;
  }
  const top = events.length ? events[events.length - 1].seq : state.last_seq;
  db.prepare(
    "UPDATE memory_state SET last_seq = ?, updated_at = ? WHERE session_id = ?",
  ).run(top, Date.now(), sessionId);
  return { folded, anchors: countAnchors(sessionId) };
}

/** Vollständiger Replay aus Seq 0; gepinnte Ankerpunkte bleiben erhalten. */
export function rebuildMemory(sessionId: string): {
  events: number;
  anchors: number;
} {
  db.prepare("DELETE FROM anchors WHERE session_id = ? AND pinned = 0").run(
    sessionId,
  );
  db.prepare(
    "UPDATE memory_state SET last_seq = 0, last_dream_seq = 0, dream_count = 0, updated_at = ? WHERE session_id = ?",
  ).run(Date.now(), sessionId);
  const { folded, anchors } = foldSession(sessionId);
  return { events: folded, anchors };
}

function applyDecay(sessionId: string): number {
  db.prepare(
    "UPDATE anchors SET importance = importance * 0.9, updated_at = ? WHERE session_id = ? AND pinned = 0",
  ).run(Date.now(), sessionId);
  const res = db
    .prepare(
      "DELETE FROM anchors WHERE session_id = ? AND pinned = 0 AND hits = 0 AND importance < 0.15",
    )
    .run(sessionId);
  return Number(res.changes);
}

const DREAM_SYSTEM = `Du destillierst aus einem Chatverlauf langlebige Gedächtnisanker ("Ankerpunkte").
Antworte NUR mit JSON im Format:
{"anchors":[{"text":"...","kind":"fact|decision|preference|entity|open_question","importance":0.0}]}
Regeln: Maximal 8 Anker. Jeder Anker ist ein prägnanter, in sich verständlicher Satz.
Nur dauerhaft Wichtiges: Fakten über den Nutzer, Entscheidungen, Präferenzen, benannte Entitäten, offene Punkte.
Kein Smalltalk, keine Meta-Gesprächsinhalte, keine Aufgaben, die schon erledigt sind.
importance zwischen 0.1 und 1.0.`;

/**
 * Traumphase: konsolidiert neue Events in Ankerpunkte — bevorzugt per
 * LLM-Extraktion, mit der Heuristik als Fallback. Dann Decay auf ungepinnten
 * Ankern; nicht mehr getragene verfallen und werden gelöscht.
 */
export async function dream(
  sessionId: string,
  opts: DreamOptions,
): Promise<DreamResult> {
  foldSession(sessionId);
  const state = getMemoryState(sessionId);
  const pending = listEvents(sessionId, state.last_dream_seq).slice(0, 40);
  if (pending.length === 0) {
    return { ok: true, events: 0, inserted: 0, merged: 0, pruned: 0, source: "none" };
  }

  const transcript = pending
    .map((ev) => {
      let p: { role?: string; content?: string; name?: string; args?: unknown } = {};
      try {
        p = JSON.parse(ev.payload) as typeof p;
      } catch {
        /* leer */
      }
      const who = ev.type === "tool_call" ? `tool:${p.name ?? "?"}` : (p.role ?? "?");
      const body = String(p.content ?? JSON.stringify(p.args ?? "")).slice(0, 500);
      return `[${ev.seq}] ${who}: ${body}`;
    })
    .join("\n");

  let inserted = 0;
  let merged = 0;
  let source: DreamResult["source"] = "heuristic";
  let error: string | undefined;

  try {
    const res = await fetch(`${opts.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        stream: false,
        think: false,
        format: "json",
        messages: [
          { role: "system", content: DREAM_SYSTEM },
          { role: "user", content: transcript },
        ],
        options: { temperature: 0.2, num_predict: 1024 },
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { message?: { content?: string } };
    const parsed = parseDreamAnchors(String(data.message?.content ?? ""));
    if (parsed.length === 0) throw new Error("keine brauchbaren Ankerpunkte");
    const lastSeq = pending[pending.length - 1].seq;
    for (const a of parsed) {
      const r = upsertAnchor(sessionId, { ...a, seq: lastSeq, origin: "dream" });
      if (r === "inserted") inserted++;
      else if (r === "merged") merged++;
    }
    source = "llm";
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const pruned = applyDecay(sessionId);
  if (source === "llm") {
    db.prepare(
      "UPDATE memory_state SET last_dream_seq = ?, dream_count = dream_count + 1, updated_at = ? WHERE session_id = ?",
    ).run(pending[pending.length - 1].seq, Date.now(), sessionId);
  }
  return { ok: true, events: pending.length, inserted, merged, pruned, source, error };
}

const KIND_LABEL: Record<AnchorKind, string> = {
  fact: "Fakt",
  decision: "Entscheidung",
  preference: "Präferenz",
  entity: "Entität",
  open_question: "Offene Frage",
};

/** System-Prompt-Block mit den wichtigsten Ankern, Token-Budget über maxChars. */
export function anchorContextBlock(
  sessionId: string,
  maxChars = 1200,
): string | null {
  const anchors = listAnchors(sessionId).slice(0, 20);
  const lines: string[] = [];
  let chars = 0;
  for (const a of anchors) {
    const line = `- [${KIND_LABEL[a.kind] ?? a.kind}] ${a.text}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
  }
  if (lines.length === 0) return null;
  return `Bekannte Ankerpunkte aus diesem und früheren Gesprächen (Gedächtnis — als Kontext nutzen, nicht wörtlich zitieren):\n${lines.join("\n")}`;
}

export function queryAnchors(
  sessionId: string,
  query: string,
  limit = 12,
): AnchorRow[] {
  const anchors = listAnchors(sessionId);
  const q = query.trim();
  if (!q) return anchors.slice(0, limit);
  return anchors
    .map((a) => ({ a, score: similarity(a.text, q) }))
    .filter(
      ({ a, score }) =>
        score >= 0.15 || a.text.toLowerCase().includes(q.toLowerCase()),
    )
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ a }) => a);
}

export function setAnchorPinned(id: number, pinned: boolean): boolean {
  const res = db
    .prepare("UPDATE anchors SET pinned = ?, updated_at = ? WHERE id = ?")
    .run(pinned ? 1 : 0, Date.now(), id);
  return Number(res.changes) > 0;
}

export function deleteAnchor(id: number): boolean {
  const res = db.prepare("DELETE FROM anchors WHERE id = ?").run(id);
  return Number(res.changes) > 0;
}

export function deleteSessionMemory(sessionId: string): void {
  db.prepare("DELETE FROM memory_events WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM memory_state WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM anchors WHERE session_id = ?").run(sessionId);
}
