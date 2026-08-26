import type { Tool } from "./types.js";
import { ToolError } from "./types.js";

/**
 * Rechner mit eigenem Parser.
 *
 * eval() oder new Function() kämen hier nicht in Frage: der Ausdruck stammt
 * aus einer Modellantwort, die ihrerseits von Nutzereingaben beeinflusst wird.
 * Der Parser unten kennt nur Zahlen und Grundrechenarten — er kann nichts
 * ausführen, was darüber hinausgeht.
 */

type Token = { kind: "num"; value: number } | { kind: "op"; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.,]/.test(c)) {
      let num = "";
      while (i < input.length && /[0-9._,]/.test(input[i])) num += input[i++];
      // Das Modell rechnet mit deutschen Beträgen und schreibt "87,50".
      // Komma gilt deshalb als Dezimaltrenner.
      const value = Number(num.replace(/_/g, "").replace(",", "."));
      if (!Number.isFinite(value)) throw new ToolError(`Ungültige Zahl: ${num}`);
      tokens.push({ kind: "num", value });
      continue;
    }
    if ("+-*/%()^".includes(c)) { tokens.push({ kind: "op", value: c }); i++; continue; }
    throw new ToolError(`Unerlaubtes Zeichen im Ausdruck: ${c}`);
  }
  return tokens;
}

/** Rekursiver Abstieg: Ausdruck -> Term -> Potenz -> Faktor. */
function parse(tokens: Token[]): number {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (op: string) => {
    const t = peek();
    if (t?.kind === "op" && t.value === op) { pos++; return true; }
    return false;
  };

  function factor(): number {
    if (eat("-")) return -factor();
    if (eat("+")) return factor();
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) throw new ToolError("Fehlende schließende Klammer");
      return v;
    }
    const t = peek();
    if (t?.kind === "num") { pos++; return t.value; }
    throw new ToolError("Unerwartetes Ende des Ausdrucks");
  }

  function power(): number {
    const base = factor();
    if (eat("^")) return Math.pow(base, power());
    return base;
  }

  function term(): number {
    let v = power();
    for (;;) {
      if (eat("*")) v *= power();
      else if (eat("/")) {
        const d = power();
        if (d === 0) throw new ToolError("Division durch null");
        v /= d;
      } else if (eat("%")) {
        const d = power();
        if (d === 0) throw new ToolError("Modulo durch null");
        v %= d;
      } else return v;
    }
  }

  function expr(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }

  const result = expr();
  if (pos !== tokens.length) throw new ToolError("Ausdruck konnte nicht vollständig gelesen werden");
  return result;
}

export const calculateTool: Tool = {
  name: "calculate",
  description:
    "Berechnet einen arithmetischen Ausdruck exakt. Nutze dies für jede " +
    "Rechnung statt selbst zu rechnen. Erlaubt: + - * / % ^ und Klammern. " +
    "Dezimaltrenner darf Punkt oder Komma sein (87.50 wie 87,50).",
  parameters: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "Der Ausdruck, zum Beispiel (17*23)+9/3",
      },
    },
    required: ["expression"],
  },
  async run(args) {
    const raw = args.expression;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ToolError("expression fehlt");
    }
    if (raw.length > 500) throw new ToolError("Ausdruck zu lang");

    const value = parse(tokenize(raw));
    if (!Number.isFinite(value)) throw new ToolError("Ergebnis ist keine endliche Zahl");
    return { expression: raw.trim(), result: value };
  },
};
