import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Message } from "../types";

export function ChatMessage({ message }: { message: Message }) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = message.role === "user";

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

      {isUser ? (
        <div className="msg-content user-content">{message.content}</div>
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
