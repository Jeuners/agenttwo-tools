import type { Session } from "../types";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ sessions, activeId, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand">
          <span className="brand-prompt">▸</span> oxagenttwo
        </div>
        <button className="btn-new" onClick={onNew}>
          + Neuer Chat
        </button>
      </div>
      <nav className="session-list">
        {sessions.length === 0 && (
          <div className="empty-hint">Noch keine Sessions.</div>
        )}
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-title">{s.title}</span>
            <button
              className="session-delete"
              title="Session löschen"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </nav>
    </aside>
  );
}
