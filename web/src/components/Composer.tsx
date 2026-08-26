import { useEffect, useRef, useState } from "react";

interface Props {
  streaming: boolean;
  disabled: boolean;
  recording: boolean;
  transcribing: boolean;
  injectedText: string | null;
  onInjected: () => void;
  onSend: (text: string) => void;
  onAbort: () => void;
  onMicToggle: () => void;
}

export function Composer({
  streaming,
  disabled,
  recording,
  transcribing,
  injectedText,
  onInjected,
  onSend,
  onAbort,
  onMicToggle,
}: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (injectedText != null) {
      setValue(injectedText);
      onInjected();
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(injectedText.length, injectedText.length);
      });
    }
  }, [injectedText, onInjected]);

  const submit = () => {
    const text = value.trim();
    if (!text || streaming || disabled) return;
    onSend(text);
    setValue("");
    requestAnimationFrame(() => ref.current?.focus());
  };

  return (
    <div className="composer">
      <button
        className={`btn-mic ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`}
        onClick={onMicToggle}
        title={
          recording
            ? "Aufnahme stoppen & senden"
            : transcribing
              ? "Transkribiere …"
              : "Sprachnachricht aufnehmen"
        }
        disabled={transcribing || disabled}
      >
        {recording ? "●" : transcribing ? "…" : "🎙"}
      </button>
      <textarea
        ref={ref}
        value={value}
        placeholder={
          recording
            ? "Ich höre zu … (zum Beenden nochmal auf das Mikro klicken)"
            : disabled
              ? "Keine Session aktiv — neuen Chat starten"
              : "Nachricht an qwen3 … (Enter = senden, Shift+Enter = Zeilenumbruch)"
        }
        rows={1}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {streaming ? (
        <button className="btn-send stop" onClick={onAbort}>
          ■ Stop
        </button>
      ) : (
        <button
          className="btn-send"
          disabled={!value.trim() || disabled}
          onClick={submit}
        >
          Senden ▸
        </button>
      )}
    </div>
  );
}
