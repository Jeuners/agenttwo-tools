/**
 * Schutz gegen Cross-Origin-Zugriff durch beliebige Webseiten.
 *
 * Der Server lauscht nur auf 127.0.0.1 — das verhindert aber keinen Zugriff
 * durch Seiten, die der Nutzer im Browser geöffnet hat: Ein fetch() oder
 * WebSocket aus einem fremden Tab erreicht localhost problemlos. Da es keine
 * Authentifizierung gibt, ist die Origin-Prüfung die einzige Grenze.
 */

const DEFAULT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
];

/** Zusätzliche Origins via ALLOWED_ORIGINS="https://a.example,https://b.example". */
export const ALLOWED_ORIGINS: readonly string[] = [
  ...DEFAULT_ORIGINS,
  ...(process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
];

/**
 * Same-Origin-Requests (curl, native Clients) senden gar keinen Origin-Header
 * und werden zugelassen; ein *fremder* Origin-Header muss auf der Liste stehen.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** Ab dieser Größe wird aufgeräumt — reicht für jede realistische Nutzung. */
const MAX_BUCKETS = 1000;

/**
 * Einfacher In-Memory-Zähler pro Zeitfenster. Bremst teure Endpunkte
 * (Whisper läuft bis zu 180 s) gegen versehentliche oder böswillige Fluten.
 */
export function createRateLimiter(limit: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  /** Abgelaufene Zähler wegräumen, damit die Map nicht unbegrenzt wächst. */
  function sweep(now: number) {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  }

  return function allow(key: string): boolean {
    const now = Date.now();
    if (buckets.size > MAX_BUCKETS) sweep(now);
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (bucket.count >= limit) return false;

    buckets.set(key, { count: bucket.count + 1, resetAt: bucket.resetAt });
    return true;
  };
}
