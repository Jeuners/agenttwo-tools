import type { ToolConfirmRequest, ToolDecision } from "../types";

/** Kurzer Satz, was dieser Aufruf tatsächlich tut — pro Werkzeug. */
const WHAT_HAPPENS: Record<string, string> = {
  read_webpage: "Diese Adresse wird von deinem Rechner abgerufen — inklusive allem, was in der URL steht.",
  remember: "Dieser Punkt landet dauerhaft im Gedächtnis und geht künftig in jeden Chat mit ein.",
};

/** Argumente als lesbare Zeilen; unlesbares JSON fällt auf den Rohtext zurück. */
function argLines(args: string): [string, string][] {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [
        k,
        typeof v === "string" ? v : JSON.stringify(v),
      ]);
    }
  } catch {
    /* unten als Rohtext */
  }
  return [["", args]];
}

export function ToolConfirm({
  request,
  onDecide,
}: {
  request: ToolConfirmRequest;
  onDecide: (id: string, decision: ToolDecision) => void;
}) {
  return (
    <div className="tool-confirm" role="alertdialog" aria-label="Werkzeug freigeben">
      <div className="tool-confirm-head">
        <span className="tool-confirm-mark">⚠</span>
        <span>
          Das Modell möchte <code>{request.name}</code> ausführen
        </span>
      </div>

      <dl className="tool-confirm-args">
        {argLines(request.args).map(([key, value], i) => (
          <div className="tool-confirm-arg" key={`${key}-${i}`}>
            {key && <dt>{key}</dt>}
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      {WHAT_HAPPENS[request.name] && (
        <p className="tool-confirm-hint">{WHAT_HAPPENS[request.name]}</p>
      )}

      <div className="tool-confirm-actions">
        <button className="btn-decide deny" onClick={() => onDecide(request.id, "deny")}>
          Ablehnen
        </button>
        <button className="btn-decide allow" onClick={() => onDecide(request.id, "allow")}>
          Einmal zulassen
        </button>
        <button
          className="btn-decide always"
          title="Gilt für dieses Werkzeug, bis die Seite neu geladen wird"
          onClick={() => onDecide(request.id, "always")}
        >
          Immer zulassen
        </button>
      </div>
    </div>
  );
}
