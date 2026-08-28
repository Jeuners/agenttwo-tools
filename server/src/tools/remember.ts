import { upsertAnchor } from "../memory.js";
import { ANCHOR_KINDS, type AnchorKind } from "../memory-text.js";
import { ToolError } from "./types.js";
import type { Tool } from "./types.js";

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Speichert einen dauerhaft wichtigen Punkt als Ankerpunkt im Gedächtnis des aktuellen Chats. Nur für Fakten, Entscheidungen, Präferenzen oder offene Punkte — nicht für flüchtige Inhalte. Der Nutzer muss jeden Aufruf freigeben.",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Der zu merkende Punkt als ein prägnanter Satz.",
      },
      kind: {
        type: "string",
        enum: [...ANCHOR_KINDS],
        description: "Art des Ankerpunkts (Default: fact).",
      },
    },
    required: ["text"],
  },
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!ctx.sessionId) throw new ToolError("Keine Sitzung für das Gedächtnis bekannt");
    if (text.length < 6) throw new ToolError("Text ist zu kurz, um ihn zu merken");
    // Bewusst ungepinnt: ein vom Modell gesetzter Anker soll dem normalen
    // Verfall unterliegen. Gepinnt wird nur, was der Nutzer im
    // Gedächtnis-Panel selbst mit ★ markiert — sonst überlebt ein einmal
    // untergeschobener "Fakt" jede Traumphase und jede Rekonstruktion.
    const result = upsertAnchor(ctx.sessionId, {
      text,
      kind: ANCHOR_KINDS.includes(args.kind as AnchorKind)
        ? (args.kind as AnchorKind)
        : "fact",
      importance: 0.9,
      origin: "model",
    });
    return { stored: result, text };
  },
};
