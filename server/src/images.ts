/**
 * Validierung für Bild-Anhänge.
 *
 * Bilder kommen als base64 über den WebSocket herein und gehen von dort an
 * Ollama bzw. OpenRouter. Weil der Inhalt von außen stammt, wird hier Anzahl,
 * Größe und Typ begrenzt, bevor irgendetwas gespeichert oder weitergereicht
 * wird.
 */

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Maximale Größe je Bild nach dem Dekodieren. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Obergrenze für eine ganze WebSocket-Nachricht inklusive base64-Overhead. */
export const MAX_WS_PAYLOAD = 32 * 1024 * 1024;

const MAGIC: { mime: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", test: (b) => b.subarray(0, 6).toString("latin1").startsWith("GIF8") },
  {
    mime: "image/webp",
    test: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

/** Bestimmt den MIME-Typ eines base64-Bildes; Fallback PNG. */
export function mimeFromBase64(b64: string): string {
  const head = Buffer.from(b64.slice(0, 32), "base64");
  return MAGIC.find((m) => m.test(head))?.mime ?? "image/png";
}

export interface ValidatedImage {
  /** Reines base64 ohne data:-Präfix — dieses Format erwartet Ollama. */
  base64: string;
  mime: string;
  bytes: number;
}

export class ImageError extends Error {}

/** Entfernt einen optionalen data:-Präfix und prüft das Ergebnis. */
function decode(input: string): Buffer {
  const comma = input.startsWith("data:") ? input.indexOf(",") : -1;
  const raw = comma === -1 ? input : input.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.replace(/\s/g, ""))) {
    throw new ImageError("Bild ist kein gültiges base64");
  }
  return Buffer.from(raw, "base64");
}

/**
 * Prüft eine Liste roher Bild-Strings und gibt die normalisierte Form zurück.
 * Wirft ImageError, sobald etwas nicht passt — lieber ablehnen als raten.
 */
export function validateImages(raw: unknown): ValidatedImage[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ImageError("images muss ein Array sein");
  if (raw.length > MAX_IMAGES_PER_MESSAGE) {
    throw new ImageError(`Maximal ${MAX_IMAGES_PER_MESSAGE} Bilder pro Nachricht`);
  }

  return raw.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ImageError("Bild ist leer oder kein String");
    }
    const buf = decode(entry);
    if (buf.length === 0) throw new ImageError("Bild ist leer");
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new ImageError(
        `Bild größer als ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`,
      );
    }
    const match = MAGIC.find((m) => m.test(buf));
    if (!match) throw new ImageError("Nicht unterstütztes Bildformat (PNG, JPEG, GIF, WebP)");

    return { base64: buf.toString("base64"), mime: match.mime, bytes: buf.length };
  });
}
