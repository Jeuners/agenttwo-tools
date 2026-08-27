import { upsertAnchor } from "../memory.js";
import { ANCHOR_KINDS, type AnchorKind } from "../memory-text.js";
import { ToolError } from "./types.js";
import type { Tool } from "./types.js";

export const rememberTool: Tool = {
  name: "remember",
  description:
    "Speichert einen dauerhaft wichtigen Punkt als Ankerpunkt im Gedächtnis des aktuellen Chats. Nur für Fakten, Entscheidungen, Präferenzen oder offene Punkte — nicht für flüchtige Inhalte.",
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
    const result = upsertAnchor(ctx.sessionId, {
      text,
      kind: ANCHOR_KINDS.includes(args.kind as AnchorKind)
        ? (args.kind as AnchorKind)
        : "fact",
      importance: 0.9,
      origin: "model",
      pinned: true,
    });
    return { stored: result, text };
  },
};
