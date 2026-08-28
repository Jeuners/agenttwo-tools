import { queryAnchors } from "../memory.js";
import { ToolError } from "./types.js";
import type { Tool } from "./types.js";

export const recallTool: Tool = {
  name: "recall",
  description:
    "Durchsucht das Gedächtnis (Ankerpunkte) des aktuellen Chats, z. B. um frühere Fakten, Entscheidungen oder Präferenzen abzurufen.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optionaler Suchbegriff; ohne Query kommen die wichtigsten Ankerpunkte.",
      },
    },
  },
  async run(args, ctx) {
    if (!ctx.sessionId) throw new ToolError("Keine Sitzung für das Gedächtnis bekannt");
    const anchors = queryAnchors(String(args.query ?? ""));
    return {
      count: anchors.length,
      anchors: anchors.map((a) => ({
        text: a.text,
        kind: a.kind,
        importance: a.importance,
        hits: a.hits,
      })),
    };
  },
};
