import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { Tool } from "./types.js";
import { ToolError } from "./types.js";

/**
 * Sandbox für den Dateizugriff.
 *
 * Das Modell entscheidet, welcher Pfad gelesen wird — die Eingabe ist damit
 * nicht vertrauenswürdig. Jeder Pfad wird deshalb aufgelöst (realpath, löst
 * auch Symlinks auf) und muss danach unterhalb der Wurzel liegen. Ein
 * ../../etc/passwd endet so außerhalb und wird abgewiesen.
 */
const ROOT = path.resolve(
  process.env.TOOLS_ROOT ?? path.join(import.meta.dirname, "..", "..", ".."),
);

const MAX_READ_BYTES = 256 * 1024;
const MAX_ENTRIES = 200;

/** Dateien, die auch innerhalb der Wurzel nicht gelesen werden. */
const DENIED = [/(^|\/)\.env(\.|$)/, /(^|\/)\.git\//, /\.(pem|key|p12|pfx)$/i];

async function resolveInside(input: unknown): Promise<string> {
  if (typeof input !== "string" || !input.trim()) {
    throw new ToolError("path fehlt");
  }
  // Ein ~ am Anfang würde sonst als Verzeichnisname behandelt.
  const raw = input.startsWith("~") ? path.join(homedir(), input.slice(1)) : input;
  const candidate = path.resolve(ROOT, raw);

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    // Existiert nicht — der lexikalische Pfad muss trotzdem drinnen liegen,
    // damit die Fehlermeldung keine Auskunft über das Dateisystem gibt.
    resolved = candidate;
  }

  const rel = path.relative(ROOT, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ToolError("Zugriff außerhalb des erlaubten Verzeichnisses");
  }
  if (DENIED.some((re) => re.test(rel))) {
    throw new ToolError("Diese Datei ist gesperrt");
  }
  return resolved;
}

export const readFileTool: Tool = {
  name: "read_file",
  description:
    `Liest eine Textdatei unterhalb von ${ROOT}. Nutze dies, um Quellcode, ` +
    "Konfiguration oder Notizen im Projekt anzusehen.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Pfad, relativ zum Projektverzeichnis" },
    },
    required: ["path"],
  },
  async run(args) {
    const file = await resolveInside(args.path);
    const info = await stat(file).catch(() => {
      throw new ToolError("Datei nicht gefunden");
    });
    if (info.isDirectory()) throw new ToolError("Das ist ein Verzeichnis — nutze list_files");
    if (info.size > MAX_READ_BYTES) {
      throw new ToolError(`Datei größer als ${MAX_READ_BYTES / 1024} KB`);
    }

    const content = await readFile(file, "utf8");
    return {
      path: path.relative(ROOT, file),
      bytes: info.size,
      content,
    };
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    `Listet Dateien und Ordner unterhalb von ${ROOT}. Nutze dies, um dich im ` +
    "Projekt zu orientieren, bevor du eine Datei liest.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Verzeichnis, relativ zum Projekt. Standard: Wurzel" },
    },
  },
  async run(args) {
    const dir = await resolveInside(args.path ?? ".");
    const info = await stat(dir).catch(() => {
      throw new ToolError("Verzeichnis nicht gefunden");
    });
    if (!info.isDirectory()) throw new ToolError("Das ist eine Datei — nutze read_file");

    const entries = await readdir(dir, { withFileTypes: true });
    const visible = entries
      .filter((e) => e.name !== "node_modules" && e.name !== ".git")
      .slice(0, MAX_ENTRIES)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();

    return {
      path: path.relative(ROOT, dir) || ".",
      entries: visible,
      truncated: entries.length > MAX_ENTRIES,
    };
  },
};
