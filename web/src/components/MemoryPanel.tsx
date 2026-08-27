import { useCallback, useEffect, useState } from "react";
import type { Anchor, MemoryInfo } from "../types";

const KIND_LABEL: Record<string, string> = {
  fact: "Fakt",
  decision: "Entscheidung",
  preference: "Präferenz",
  entity: "Entität",
  open_question: "Offen",
};

export function MemoryPanel({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/memory`);
      const d = (await res.json()) as MemoryInfo;
      if (d.state) setInfo(d);
    } catch {
      setInfo(null);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dreamNow = async () => {
    setBusy("dream");
    try {
      await fetch(`/api/sessions/${sessionId}/dream`, { method: "POST" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    setBusy("rebuild");
    try {
      await fetch(`/api/sessions/${sessionId}/memory/rebuild`, { method: "POST" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const togglePin = async (a: Anchor) => {
    await fetch(`/api/anchors/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !a.pinned }),
    });
    await load();
  };

  const remove = async (a: Anchor) => {
    await fetch(`/api/anchors/${a.id}`, { method: "DELETE" });
    await load();
  };

  const pending = info ? info.state.last_seq - info.state.last_dream_seq : 0;

  return (
    <div className="memory-overlay" onClick={onClose}>
      <section className="memory-panel" onClick={(e) => e.stopPropagation()}>
        <header className="memory-header">
          <div>
            <div className="memory-title">🧠 Gedächtnis</div>
            <div className="memory-stats">
              {info
                ? `${info.state.last_seq} Log-Schritte · ${info.state.dream_count}× geträumt · ${pending} unkonsolidiert`
                : "lädt …"}
            </div>
          </div>
          <button className="memory-close" onClick={onClose} title="Schließen">
            ✕
          </button>
        </header>

        <div className="memory-actions">
          <button onClick={() => void dreamNow()} disabled={busy !== null}>
            {busy === "dream" ? "… träumt" : "💤 Traumphase jetzt"}
          </button>
          <button onClick={() => void rebuild()} disabled={busy !== null}>
            {busy === "rebuild" ? "… faltet" : "↻ Aus Log rekonstruieren"}
          </button>
        </div>

        {info && info.anchors.length === 0 && (
          <div className="memory-empty">
            Noch keine Ankerpunkte. Sie entstehen durch die Traumphase (automatisch
            nach Inaktivität oder Manual oben) oder wenn das Modell sich etwas
            mit „remember“ merkt.
          </div>
        )}

        {info?.anchors.map((a) => (
          <div
            key={a.id}
            className={"anchor-row" + (a.pinned ? " pinned" : "")}
          >
            <div className="anchor-body">
              <div className="anchor-kind">
                {KIND_LABEL[a.kind] ?? a.kind} · {a.origin}
              </div>
              <div className="anchor-text">{a.text}</div>
              <div className="anchor-meta">
                Wichtigkeit {(a.importance * 100).toFixed(0)} % · {a.hits}×
                bestätigt
              </div>
              <div className="anchor-bar">
                <div
                  className="anchor-bar-fill"
                  style={{ width: `${Math.round(a.importance * 100)}%` }}
                />
              </div>
            </div>
            <div className="anchor-actions">
              <button
                onClick={() => void togglePin(a)}
                title={a.pinned ? "Pin lösen (Decay möglich)" : "Pinnen (vor Decay geschützt)"}
              >
                {a.pinned ? "★" : "☆"}
              </button>
              <button
                onClick={() => void remove(a)}
                title="Ankerpunkt löschen"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
