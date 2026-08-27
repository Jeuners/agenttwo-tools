export const ANCHOR_KINDS = [
  "fact",
  "decision",
  "preference",
  "entity",
  "open_question",
] as const;

export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface AnchorCandidate {
  text: string;
  kind: AnchorKind;
  importance: number;
}

const STOPWORDS = new Set([
  "der", "die", "das", "und", "ich", "ein", "eine", "einer", "ist", "nicht",
  "zu", "mit", "auf", "für", "im", "in", "den", "dem", "des", "sich", "hat",
  "haben", "sein", "wird", "werden", "von", "mir", "mich", "du", "er", "sie",
  "es", "wir", "ihr", "aber", "auch", "dass", "wie", "bei", "aus", "bitte",
  "dann", "noch", "schon", "wäre", "habe", "hatte", "kann", "muss", "soll",
]);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard-Ähnlichkeit auf Wortebene, Stoppwörter und Kurzwörter ignoriert. */
export function similarity(a: string, b: string): number {
  const wa = normalizeText(a)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const wb = normalizeText(b)
    .split(" ")
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  if (wa.length === 0 || wb.length === 0) return 0;
  const setB = new Set(wb);
  const inter = new Set(wa.filter((w) => setB.has(w))).size;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : inter / union;
}

const HEURISTICS: { pattern: RegExp; kind: AnchorKind; importance: number }[] = [
  {
    pattern: /(merke (dir|dich)|vergiss (das )?nicht|denk dran|nicht vergessen)/i,
    kind: "fact",
    importance: 0.85,
  },
  {
    pattern: /^(ich hei(ß|ss)e|mein name ist|ich wohne (in|bei)|ich arbeite (als|bei|in)|meine e-?mail|meine telefonnummer|ich bin von beruf)/i,
    kind: "fact",
    importance: 0.9,
  },
  {
    pattern: /^(ich mag|ich mag (kein|keine)|ich bevorzuge|ich hasse|ich liebe|mir gef(ä|a)llt|mir gef(ä|a)llen (kein|keine))/i,
    kind: "preference",
    importance: 0.7,
  },
  {
    pattern: /^(wir (machen|nutzen|nehmen|entscheiden|bleiben)|ab jetzt|von nun an|regel:)/i,
    kind: "decision",
    importance: 0.75,
  },
  {
    pattern: /(offene frage|noch unklar|noch zu kl(ä|a)ren|ist ungekl(ä|a)rt|bleibt offen)/i,
    kind: "open_question",
    importance: 0.6,
  },
];

/** Satzweise Heuristik-Extraktion ohne LLM — Fallback und Erstfilter. */
export function heuristicAnchors(text: string): AnchorCandidate[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 10 && s.length <= 240);
  const out: AnchorCandidate[] = [];
  for (const s of sentences) {
    for (const h of HEURISTICS) {
      if (h.pattern.test(s)) {
        out.push({ text: s.slice(0, 240), kind: h.kind, importance: h.importance });
        break;
      }
    }
  }
  return out;
}

function clampImportance(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0.1, n));
}

/**
 * Parst die Traumphase-Antwort des Modells. Akzeptiert {"anchors":[…]} oder
 * ein nacktes Array; kaputte Einträge werden still verworfen, nie geworfen.
 */
export function parseDreamAnchors(raw: string): AnchorCandidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { anchors?: unknown } | null)?.anchors;
  if (!Array.isArray(list)) return [];
  const out: AnchorCandidate[] = [];
  for (const item of list.slice(0, 8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.text !== "string") continue;
    const text = o.text.trim().slice(0, 300);
    if (text.length < 6) continue;
    const kind = ANCHOR_KINDS.includes(o.kind as AnchorKind)
      ? (o.kind as AnchorKind)
      : "fact";
    out.push({ text, kind, importance: clampImportance(Number(o.importance)) });
  }
  return out;
}
