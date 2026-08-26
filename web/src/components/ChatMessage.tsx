import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message, ToolEvent } from "../types";

/**
 * Leitet den MIME-Typ aus den ersten base64-Zeichen ab. "image/*" ist als
 * data-URL ungültig, deshalb muss der konkrete Typ bestimmt werden.
 */
function mimeOf(b64: string): string {
  if (b64.startsWith("iVBORw0KGgo")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  if (b64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

/** Der Server legt Bilder als JSON-Array mit base64-Daten ab. */
function imagesOf(message: Message): string[] {
  if (!message.images) return [];
  try {
    const parsed: unknown = JSON.parse(message.images);
    return Array.isArray(parsed) ? parsed.filter((i): i is string => typeof i === "string") : [];
  } catch {
    return [];
  }
}

export function ChatMessage({
  message,
  toolEvents = [],
}: {
  message: Message;
  toolEvents?: ToolEvent[];
}) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = message.role === "user";
  const images = imagesOf(message);

  return (
    <div className={`msg ${isUser ? "msg-user" : "msg-assistant"}`}>
      <div className="msg-role">
        {isUser ? "du" : "qwen3"}
      </div>

      {!isUser && message.thinking && message.thinking.length > 0 && (
        <div className={`thinking ${showThinking ? "open" : ""}`}>
          <button className="thinking-toggle" onClick={() => setShowThinking((v) => !v)}>
            <span className={`caret ${showThinking ? "rotated" : ""}`}>▸</span>
            {message.content === "" && showThinking === false
              ? "denkt nach …"
              : `Denkprozess (${message.thinking.length.toLocaleString("de-DE")} Zeichen)`}
          </button>
          {showThinking && (
            <pre className="thinking-body">{message.thinking}</pre>
          )}
        </div>
      )}

      {toolEvents.length > 0 && (
        <div className="tool-events">
          {toolEvents.map((e, i) => (
            <div className={`tool-event ${e.ok === false ? "failed" : ""}`} key={i}>
              <span className="tool-icon">
                {e.ok === undefined ? "⋯" : e.ok ? "✓" : "✗"}
              </span>
              <code>{e.name}</code>
              <span className="tool-args" title={e.args}>{e.args}</span>
              {e.durationMs !== undefined && (
                <span className="tool-time">{e.durationMs} ms</span>
              )}
            </div>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <div className="msg-images">
          {images.map((b64, i) => (
            <img
              key={i}
              src={`data:${mimeOf(b64)};base64,${b64}`}
              alt={`Anhang ${i + 1}`}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {isUser ? (
        message.content ? (
          <div className="msg-content user-content">{message.content}</div>
        ) : null
      ) : (
        <div className="msg-content markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content || "▍"}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}
