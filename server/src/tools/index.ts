import { timeTool } from "./time.js";
import { calculateTool } from "./calculate.js";
import { readFileTool, listFilesTool } from "./files.js";
import { rememberTool } from "./remember.js";
import { recallTool } from "./recall.js";
import { readWebpageTool } from "./web.js";
import type { Tool, ToolCall, ToolContext, ToolResult } from "./types.js";
import { ToolError } from "./types.js";

export type { Tool, ToolCall, ToolResult } from "./types.js";
export { ToolError } from "./types.js";

/** Zeitlimit je Aufruf, damit ein hängendes Werkzeug die Antwort nicht blockiert. */
const TOOL_TIMEOUT_MS = 15_000;
/** Obergrenze für Werkzeug-Runden pro Nachricht — verhindert Endlosschleifen. */
export const MAX_TOOL_ROUNDS = 5;

const REGISTRY: Tool[] = [
  timeTool,
  calculateTool,
  readFileTool,
  listFilesTool,
  rememberTool,
  recallTool,
  readWebpageTool,
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.name, t]));

/** Werkzeugliste im Format, das Ollama erwartet. */
export function toolDefinitions() {
  return REGISTRY.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function toolNames(): string[] {
  return REGISTRY.map((t) => t.name);
}

/**
 * Zeitlimit für das Ergebnis. Der `signal` unten bricht das Werkzeug zusätzlich
 * ab — beides zusammen, weil ein Werkzeug den Signal auch ignorieren kann und
 * die Antwort dann trotzdem nicht ewig hängen darf.
 */
function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ToolError(`${name}: Zeitlimit von ${ms / 1000}s überschritten`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Führt einen Werkzeugaufruf aus. Fehler werden nicht geworfen, sondern als
 * Ergebnis zurückgegeben — das Modell soll erfahren, was schiefging, und
 * darauf reagieren können, statt dass die ganze Antwort abbricht.
 */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now();
  const tool = BY_NAME.get(call.name);

  if (!tool) {
    return {
      name: call.name,
      content: JSON.stringify({ error: `Unbekanntes Werkzeug: ${call.name}` }),
      ok: false,
      durationMs: 0,
    };
  }

  if (tool.requiresConfirmation && !(await isApproved(call, ctx))) {
    return {
      name: tool.name,
      content: JSON.stringify({
        error:
          "Vom Nutzer abgelehnt. Nicht erneut aufrufen — ohne dieses Werkzeug " +
          "weitermachen und sagen, was dadurch fehlt.",
      }),
      ok: false,
      durationMs: Date.now() - started,
    };
  }

  // Zeitlimit und Nutzer-Abbruch als ein Signal, das an das Werkzeug geht:
  // damit endet auch ein laufender Netzwerkabruf, statt weiterzulaufen.
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TOOL_TIMEOUT_MS)]);

  try {
    const value = await withTimeout(
      tool.run(call.arguments, { ...ctx, signal }),
      TOOL_TIMEOUT_MS,
      tool.name,
    );
    return {
      name: tool.name,
      content: JSON.stringify(value),
      ok: true,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    // ToolError-Texte sind bewusst formuliert; alles andere könnte interne
    // Details enthalten und wird deshalb nicht durchgereicht.
    const message = err instanceof ToolError ? err.message : "Werkzeug fehlgeschlagen";
    return {
      name: tool.name,
      content: JSON.stringify({ error: message }),
      ok: false,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Freigabe für ein bestätigungspflichtiges Werkzeug. Ohne Rückkanal (Skripte,
 * Tests) gilt "abgelehnt" — die Bestätigung soll sich nicht dadurch umgehen
 * lassen, dass niemand zum Fragen da ist.
 */
async function isApproved(call: ToolCall, ctx: ToolContext): Promise<boolean> {
  if (!ctx.confirm) return false;
  try {
    return await ctx.confirm(call);
  } catch {
    return false;
  }
}
