import { PDFParse } from "pdf-parse";

export const MAX_FILES_PER_MESSAGE = 4;
/** Maximale Zeichen je Textdatei — deckt JSON/CSV/Code weit ab, ohne das Kontextfenster zu sprengen. */
export const MAX_FILE_CHARS = 100_000;
/** Maximale PDF-Größe vor der Textextraktion. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Maximale Namenlänge nach Bereinigung. */
const MAX_NAME_CHARS = 120;

export interface ValidatedFile {
  name: string;
  content: string;
}

export interface RawFile {
  name?: unknown;
  content?: unknown;
  encoding?: unknown;
}

export class FileError extends Error {}

/** Stripped Pfade und gefährliche Namen; "." und ".." werden abgewiesen. */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new FileError("Datei ohne Namen");
  }
  const base = raw.split(/[\\/]/).pop() ?? "";
  const name = base.replace(/[\x00-\x1F]/g, "").trim().slice(0, MAX_NAME_CHARS);
  if (!name || name === "." || name === "..") {
    throw new FileError("Ungültiger Dateiname");
  }
  return name;
}

/** Textnachweis: druckbare Zeichen plus Whitespace; sonstige Steuerzeichen → binär. */
function isText(content: string): boolean {
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content.slice(0, 2000));
}

function decodeBase64(input: string): Buffer {
  const comma = input.startsWith("data:") ? input.indexOf(",") : -1;
  const raw = comma === -1 ? input : input.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.replace(/\s/g, ""))) {
    throw new FileError("Anhang ist kein gültiges base64");
  }
  return Buffer.from(raw, "base64");
}

async function extractPdfText(name: string, b64: string): Promise<string> {
  const buf = decodeBase64(b64);
  if (buf.length === 0) throw new FileError(`${name} ist leer`);
  if (buf.length > MAX_PDF_BYTES) {
    throw new FileError(`${name} ist größer als ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB`);
  }
  if (!buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new FileError(`${name} ist keine PDF-Datei`);
  }
  let text = "";
  try {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    try {
      const result = await parser.getText();
      text = result.text;
    } finally {
      await parser.destroy();
    }
  } catch {
    throw new FileError(`${name} konnte nicht gelesen werden`);
  }
  text = text.replace(/\x00/g, "").trim();
  if (!text) {
    throw new FileError(
      `${name} enthält keinen extrahierbaren Text — vermutlich gescannt (OCR wird nicht unterstützt)`,
    );
  }
  if (text.length > MAX_FILE_CHARS) {
    text = text.slice(0, MAX_FILE_CHARS) + "\n[…gekürzt]";
  }
  return text;
}

/**
 * Prüft Datei-Anhänge: Textdateien direkt, PDFs als base64 mit serverseitiger
 * Textextraktion. Wirft FileError, sobald etwas nicht passt.
 */
export async function prepareFiles(raw: unknown): Promise<ValidatedFile[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new FileError("files muss ein Array sein");
  if (raw.length > MAX_FILES_PER_MESSAGE) {
    throw new FileError(`Maximal ${MAX_FILES_PER_MESSAGE} Dateien pro Nachricht`);
  }

  const out: ValidatedFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new FileError("Datei hat ein ungültiges Format");
    }
    const o = entry as RawFile;
    const name = sanitizeName(o.name);

    if (o.encoding === "base64") {
      if (typeof o.content !== "string" || o.content.length === 0) {
        throw new FileError(`${name} ist leer`);
      }
      out.push({ name, content: await extractPdfText(name, o.content) });
      continue;
    }

    if (typeof o.content !== "string" || o.content.length === 0) {
      throw new FileError(`${name} ist leer`);
    }
    if (o.content.length > MAX_FILE_CHARS) {
      throw new FileError(
        `${name} ist größer als ${Math.round(MAX_FILE_CHARS / 1000)} kB`,
      );
    }
    if (!isText(o.content)) {
      throw new FileError(`${name} wirkt binär — nur Textdateien werden unterstützt`);
    }
    out.push({ name, content: o.content });
  }
  return out;
}

/** Baut einen Datei-Block für den LLM-Kontext, gekürzt auf maxChars. */
export function fileBlock(name: string, content: string, maxChars = 24_000): string {
  const body =
    content.length > maxChars
      ? content.slice(0, maxChars) + "\n[…gekürzt]"
      : content;
  return `[Datei: ${name}]\n\`\`\`\n${body}\n\`\`\``;
}
