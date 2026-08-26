import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";

const dbPath = path.join(import.meta.dirname, "..", "data.sqlite");
export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Neuer Chat',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
`);

// Bestehende Datenbanken aus agenttwo kennen die Spalte noch nicht.
const hasImages = (
  db.prepare("PRAGMA table_info(messages)").all() as unknown as { name: string }[]
).some((c) => c.name === "images");
if (!hasImages) {
  db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
}

export interface SessionRow {
  id: string;
  title: string;
  created_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  thinking: string | null;
  /** JSON-Array mit base64-Bilddaten (ohne data:-Präfix), oder null. */
  images: string | null;
  created_at: number;
}

export function listSessions(): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC")
    .all() as unknown as SessionRow[];
}

export function createSession(title = "Neuer Chat"): SessionRow {
  const row: SessionRow = { id: randomUUID(), title, created_at: Date.now() };
  db.prepare("INSERT INTO sessions (id, title, created_at) VALUES (?, ?, ?)").run(
    row.id,
    row.title,
    row.created_at,
  );
  return row;
}

export function getSession(id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
}

export function renameSessionIfDefault(id: string, firstMessage: string) {
  const s = getSession(id);
  if (!s || s.title !== "Neuer Chat") return;
  const title =
    firstMessage.trim().slice(0, 60) + (firstMessage.length > 60 ? "…" : "");
  db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(
    title || "Neuer Chat",
    id,
  );
}

export function deleteSession(id: string) {
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function insertMessage(
  sessionId: string,
  role: string,
  content: string,
  thinking?: string | null,
  images?: string[] | null,
): MessageRow {
  const row: MessageRow = {
    id: randomUUID(),
    session_id: sessionId,
    role,
    content,
    thinking: thinking ?? null,
    images: images?.length ? JSON.stringify(images) : null,
    created_at: Date.now(),
  };
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, thinking, images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    row.id,
    row.session_id,
    row.role,
    row.content,
    row.thinking,
    row.images,
    row.created_at,
  );
  return row;
}

/** Bilder einer Zeile als Array — leer, wenn keine oder unlesbar. */
export function parseImages(row: Pick<MessageRow, "images">): string[] {
  if (!row.images) return [];
  try {
    const parsed: unknown = JSON.parse(row.images);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === "string") : [];
  } catch {
    return [];
  }
}

export function updateAssistantMessage(
  id: string,
  content: string,
  thinking: string | null,
) {
  db.prepare("UPDATE messages SET content = ?, thinking = ? WHERE id = ?").run(
    content,
    thinking,
    id,
  );
}

export function listMessages(sessionId: string): MessageRow[] {
  return db
    .prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
    )
    .all(sessionId) as unknown as MessageRow[];
}
