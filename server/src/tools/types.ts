/** JSON-Schema-Fragment, wie Ollama es für Parameter erwartet. */
export interface ToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolContext {
  /** Bricht die Ausführung ab, wenn der Nutzer die Antwort stoppt. */
  signal: AbortSignal;
  /** Sitzung des aktuellen Chats — für Werkzeuge mit Gedächtniszugriff. */
  sessionId?: string;
  /**
   * Holt die Freigabe des Nutzers für ein Werkzeug mit Außenwirkung.
   * Fehlt der Rückkanal, werden bestätigungspflichtige Werkzeuge abgelehnt —
   * lieber nicht ausführen als ungefragt.
   */
  confirm?(call: ToolCall): Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema;
  /**
   * Kennzeichnet Werkzeuge mit Außenwirkung (Netzwerk, dauerhafter Speicher).
   * `runTool` fragt vor der Ausführung über `ToolContext.confirm` beim Nutzer
   * nach und lehnt ab, wenn keine Freigabe kommt.
   */
  requiresConfirmation?: boolean;
  /** Gibt zurück, was dem Modell als Ergebnis gezeigt wird. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** Fehler, dessen Text gefahrlos an das Modell weitergegeben werden kann. */
export class ToolError extends Error {}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  name: string;
  /** Serialisiertes Ergebnis für das Modell. */
  content: string;
  ok: boolean;
  durationMs: number;
}
