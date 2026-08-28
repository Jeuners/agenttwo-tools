import { useEffect, useRef, useState } from "react";

/** Muss zu MAX_IMAGES_PER_MESSAGE / MAX_IMAGE_BYTES im Server passen. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface Attachment {
  id: string;
  /** reines base64 ohne data:-Präfix — dieses Format erwartet der Server */
  base64: string;
  dataUrl: string;
  name: string;
}

interface Props {
  streaming: boolean;
  disabled: boolean;
  recording: boolean;
  transcribing: boolean;
  injectedText: string | null;
  modelLabel?: string;
  onInjected: () => void;
  onSend: (text: string, images: string[]) => void;
  onAbort: () => void;
  onMicToggle: () => void;
}

function readAsAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} konnte nicht gelesen werden`));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        base64: dataUrl.slice(comma + 1),
        dataUrl,
        name: file.name || "Bild",
      });
    };
    reader.readAsDataURL(file);
  });
}

export function Composer({
  streaming,
  disabled,
  recording,
  transcribing,
  injectedText,
  modelLabel = "qwen3",
  onInjected,
  onSend,
  onAbort,
  onMicToggle,
}: Props) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<Attachment[]>([]);
  const [imgError, setImgError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const addFiles = async (files: File[]) => {
    setImgError(null);
    const usable: File[] = [];
    for (const f of files) {
      if (!ACCEPTED.includes(f.type)) {
        setImgError(`${f.name || "Datei"}: nur PNG, JPEG, GIF oder WebP`);
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        setImgError(`${f.name}: größer als ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
        continue;
      }
      usable.push(f);
    }
    if (!usable.length) return;

    try {
      const added = await Promise.all(usable.map(readAsAttachment));
      setImages((prev) => {
        const free = MAX_IMAGES - prev.length;
        if (added.length > free) setImgError(`Maximal ${MAX_IMAGES} Bilder pro Nachricht`);
        return [...prev, ...added.slice(0, Math.max(free, 0))];
      });
    } catch (err) {
      setImgError(err instanceof Error ? err.message : "Bild konnte nicht gelesen werden");
    }
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && images.length === 0) || streaming || disabled) return;
    onSend(text, images.map((i) => i.base64));
    setValue("");
    setImages([]);
    setImgError(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const canSend = (value.trim().length > 0 || images.length > 0) && !disabled;

  return (
    <div
      className={`composer ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {(images.length > 0 || imgError) && (
        <div className="attachments">
          {images.map((img) => (
            <div className="attachment" key={img.id}>
              <img src={img.dataUrl} alt={img.name} />
              <button
                className="attachment-remove"
                onClick={() => setImages((p) => p.filter((i) => i.id !== img.id))}
                title={`${img.name} entfernen`}
              >
                ×
              </button>
            </div>
          ))}
          {imgError && <span className="attachment-error">{imgError}</span>}
        </div>
      )}

      <div className="composer-row">
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

        <button
          className="btn-attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || images.length >= MAX_IMAGES}
          title={
            images.length >= MAX_IMAGES
              ? `Maximal ${MAX_IMAGES} Bilder`
              : "Bild anhängen (auch per Einfügen oder Drag & Drop)"
          }
        >
          🖼
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED.join(",")}
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />

        <textarea
          ref={ref}
          value={value}
          placeholder={
            recording
              ? "Ich höre zu … (zum Beenden nochmal auf das Mikro klicken)"
              : disabled
                ? "Keine Session aktiv — neuen Chat starten"
                : `Nachricht an ${modelLabel} … (Enter = senden, Bild einfügen mit ⌘V)`
          }
          rows={1}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) =>
              f.type.startsWith("image/"),
            );
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
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
          <button className="btn-send" disabled={!canSend} onClick={submit}>
            Senden ▸
          </button>
        )}
      </div>
    </div>
  );
}
