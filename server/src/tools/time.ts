import type { Tool } from "./types.js";
import { ToolError } from "./types.js";

/**
 * Modelle kennen das aktuelle Datum nicht — sie raten es aus den Trainingsdaten.
 * Deshalb ist Zeit das nützlichste triviale Werkzeug.
 */
export const timeTool: Tool = {
  name: "get_time",
  description:
    "Liefert das aktuelle Datum und die Uhrzeit. Nutze dies immer, wenn nach " +
    "der Zeit, dem heutigen Datum, dem Wochentag oder einer Zeitzone gefragt wird.",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description: "IANA-Zeitzone wie Europe/Berlin oder America/New_York. Standard: Europe/Berlin",
      },
    },
  },
  async run(args) {
    const timezone = typeof args.timezone === "string" && args.timezone.trim()
      ? args.timezone.trim()
      : "Europe/Berlin";

    let fmt: Intl.DateTimeFormat;
    try {
      fmt = new Intl.DateTimeFormat("de-DE", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "short",
      });
    } catch {
      throw new ToolError(`Unbekannte Zeitzone: ${timezone}`);
    }

    const now = new Date();
    return {
      timezone,
      formatted: fmt.format(now),
      iso: now.toISOString(),
      weekday: new Intl.DateTimeFormat("de-DE", { timeZone: timezone, weekday: "long" }).format(now),
    };
  },
};
