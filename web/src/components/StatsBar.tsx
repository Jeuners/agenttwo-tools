import type { ChatStats, SessionTotals } from "../types";

const nf = new Intl.NumberFormat("de-DE");

function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString("de-DE", { maximumFractionDigits: 1 })} s`;
}

function rate(tokens: number, ms: number): string | null {
  if (!tokens || ms <= 0) return null;
  const perSecond = (tokens / ms) * 1000;
  return `${perSecond.toLocaleString("de-DE", { maximumFractionDigits: 1 })} tok/s`;
}

/**
 * Messwerte der laufenden bzw. letzten Antwort plus Session-Summe.
 *
 * Während des Streamens gibt es nur die Näherung aus gezählten Chunks — die
 * ist mit ≈ markiert. Die exakten Zahlen kommen vom Modell selbst, sobald die
 * Antwort steht.
 */
export function StatsBar({
  stats,
  live,
  totals,
  contextLength,
}: {
  stats: ChatStats | null;
  live: { tokens: number; startedAt: number } | null;
  totals: SessionTotals;
  contextLength?: number;
}) {
  const parts: string[] = [];

  if (live) {
    const elapsed = Date.now() - live.startedAt;
    parts.push(`≈ ${nf.format(live.tokens)} ↓`);
    const r = rate(live.tokens, elapsed);
    if (r) parts.push(`≈ ${r}`);
    parts.push(seconds(elapsed));
  } else if (stats) {
    parts.push(`${nf.format(stats.promptTokens)} ↑`);
    parts.push(`${nf.format(stats.responseTokens)} ↓`);
    const r = rate(stats.responseTokens, stats.evalMs);
    if (r) parts.push(r);
    if (stats.ttftMs !== null) parts.push(`TTFT ${seconds(stats.ttftMs)}`);
    parts.push(seconds(stats.totalMs));
    if (stats.rounds > 1) parts.push(`${stats.rounds} Runden`);
  }

  const window = stats?.contextLength ?? contextLength;
  const used = stats?.promptTokens ?? 0;
  const fill = window && used ? Math.min(1, used / window) : null;

  if (parts.length === 0 && totals.responses === 0) return null;

  return (
    <div className="stats-bar">
      {parts.length > 0 && (
        <span className={`stats-run ${live ? "streaming" : ""}`}>{parts.join(" · ")}</span>
      )}

      {fill !== null && window && (
        <span
          className={`stats-context ${fill > 0.9 ? "tight" : ""}`}
          title={`Prompt der letzten Antwort gegen das tatsächlich genutzte Kontextfenster (${nf.format(window)} Tokens). Darüber hinaus wird vorne abgeschnitten.`}
        >
          <span className="stats-meter">
            <span className="stats-meter-fill" style={{ width: `${fill * 100}%` }} />
          </span>
          {nf.format(used)} / {nf.format(window)}
        </span>
      )}

      {totals.responses > 0 && (
        <span
          className="stats-totals"
          title={`${totals.responses} Antworten in diesem Chat, seit dem letzten Neuladen der Seite`}
        >
          Σ {nf.format(totals.promptTokens)} ↑ {nf.format(totals.responseTokens)} ↓
          {totals.costUsd > 0 &&
            ` · $${totals.costUsd.toLocaleString("de-DE", { maximumFractionDigits: 4 })}`}
        </span>
      )}
    </div>
  );
}
