import { useEffect, useRef, useState } from "react";

/** Muss zu MAX_IMAGES_PER_MESSAGE / MAX_IMAGE_BYTES im Server passen. */
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Muss zu MAX_FILES_PER_MESSAGE / MAX_FILE_CHARS im Server passen. */
const MAX_FILES = 4;
const MAX_FILE_CHARS = 100_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const TEXT_EXTS = [
  ".txt", ".json", ".md", ".markdown", ".csv", ".tsv", ".log", ".xml", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".conf", ".sql", ".sh", ".bash", ".zsh",
  ".py", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".css", ".scss", ".html",
  ".htm", ".svg", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".swift", ".diff", ".patch",
];
const PDF_TYPES = ["application/pdf"];
const PDF_EXTS = [".pdf"];
const TEXT_MIMES = ["application/json", "application/xml", "application/yaml", "application/x-sh"];

interface Attachment {
  id: string;
  /** reines base64 ohne data:-Präfix — dieses Format erwartet der Server */
  base64: string;
  dataUrl: string;
  name: string;
}

interface TextAttachment {
  id: string;
  name: string;
  /** Textinhalt oder base64 (encoding: base64, nur PDF). */
  content: string;
  bytes: number;
  encoding: "text" | "base64";
}

interface Props {
  streaming: boolean;
  disabled: boolean;
  recording: boolean;
  transcribing: boolean;
  injectedText: string | null;
  modelLabel?: string;
  onInjected: () => void;
  onSend: (text: string, images: string[], files?: { name: string; content: string; encoding?: string }[]) => void;
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

async function readAsTextAttachment(file: File): Promise<TextAttachment> {
  const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
  if (PDF_TYPES.includes(file.type) || PDF_EXTS.includes(ext)) {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`${file.name}: größer als ${Math.round(MAX_PDF_BYTES / 1024 / 1024)} MB`);
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`${file.name} konnte nicht gelesen werden`));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(file);
    });
    const comma = dataUrl.indexOf(",");
    return {
      id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
      name: file.name || "PDF",
      content: dataUrl.slice(comma + 1),
      bytes: file.size,
      encoding: "base64",
    };
  }
  const content = await file.text();
  if (content.length === 0) throw new Error(`${file.name} ist leer`);
  if (content.length > MAX_FILE_CHARS) {
    throw new Error(`${file.name}: größer als ${Math.round(MAX_FILE_CHARS / 1000)} kB Text`);
  }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content.slice(0, 2000))) {
    throw new Error(`${file.name}: wirkt binär — nur Textdateien`);
  }
  return {
    id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
    name: file.name || "Datei",
    content,
    bytes: file.size,
    encoding: "text",
  };
}

/**
 * Icons als SVG statt Emoji.
 *
 * 🎙 und 📎 sind in den Emoji-Fonts fest grau eingefärbt — `color` greift bei
 * ihnen nicht. Damit blieben auch die Zustandsfarben unten wirkungslos
 * (Aufnahme rot, Transkription orange): sie färbten nur den Rahmen. Als SVG
 * mit `currentColor` zieht die Farbe wieder durch.
 */
const ICON = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function MicIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3M8.5 21h7" />
    </svg>
  );
}

function RecordIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <circle cx="12" cy="12" r="5.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a5.5 5.5 0 0 1-7.78-7.78l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49" />
    </svg>
  );
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
  const [textFiles, setTextFiles] = useState<TextAttachment[]>([]);
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
    const imgFiles: File[] = [];
    const txtFiles: File[] = [];
    for (const f of files) {
      const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
      if (ACCEPTED.includes(f.type)) {
        if (f.size > MAX_IMAGE_BYTES) {
          setImgError(`${f.name}: größer als ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
          continue;
        }
        imgFiles.push(f);
      } else if (
        f.type.startsWith("text/") ||
        TEXT_MIMES.includes(f.type) ||
        PDF_TYPES.includes(f.type) ||
        TEXT_EXTS.includes(ext) ||
        PDF_EXTS.includes(ext)
      ) {
        if (f.size > MAX_FILE_CHARS * 2) {
          setImgError(`${f.name}: größer als ${Math.round((MAX_FILE_CHARS * 2) / 1000)} kB`);
          continue;
        }
        txtFiles.push(f);
      } else {
        setImgError(`${f.name || "Datei"}: nur Bilder (PNG, JPEG, GIF, WebP) oder Textdateien`);
      }
    }

    try {
      if (imgFiles.length) {
        const added = await Promise.all(imgFiles.map(readAsAttachment));
        setImages((prev) => {
          const free = MAX_IMAGES - prev.length;
          if (added.length > free) setImgError(`Maximal ${MAX_IMAGES} Bilder pro Nachricht`);
          return [...prev, ...added.slice(0, Math.max(free, 0))];
        });
      }
      if (txtFiles.length) {
        const added = await Promise.all(txtFiles.map(readAsTextAttachment));
        setTextFiles((prev) => {
          const free = MAX_FILES - prev.length;
          if (added.length > free) setImgError(`Maximal ${MAX_FILES} Dateien pro Nachricht`);
          return [...prev, ...added.slice(0, Math.max(free, 0))];
        });
      }
    } catch (err) {
      setImgError(err instanceof Error ? err.message : "Datei konnte nicht gelesen werden");
    }
  };

  const submit = () => {
    const text = value.trim();
    if ((!text && images.length === 0 && textFiles.length === 0) || streaming || disabled) return;
    onSend(text, images.map((i) => i.base64), textFiles.map((f) => ({
      name: f.name,
      content: f.content,
      encoding: f.encoding === "base64" ? "base64" : undefined,
    })));
    setValue("");
    setImages([]);
    setTextFiles([]);
    setImgError(null);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const canSend = (value.trim().length > 0 || images.length > 0 || textFiles.length > 0) && !disabled;

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
      {(images.length > 0 || textFiles.length > 0 || imgError) && (
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
          {textFiles.map((f) => (
            <div className="attachment attachment-file" key={f.id}>
              <span className="attachment-file-name">
                📄 {f.name} · {Math.max(1, Math.round(f.bytes / 1024))} kB
              </span>
              <button
                className="attachment-remove"
                onClick={() => setTextFiles((p) => p.filter((i) => i.id !== f.id))}
                title={`${f.name} entfernen`}
              >
                ×
              </button>
            </div>
          ))}
          {imgError && <span className="attachment-error">{imgError}</span>}
        </div>
      )}

      <div className="composer-row">
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
            const files = [...e.clipboardData.files].filter((f) => {
              const ext = "." + (f.name.split(".").pop() ?? "").toLowerCase();
              return (
                ACCEPTED.includes(f.type) ||
                f.type.startsWith("text/") ||
                TEXT_MIMES.includes(f.type) ||
                TEXT_EXTS.includes(ext)
              );
            });
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

        <button
          className={`btn-icon btn-mic ${recording ? "recording" : ""} ${transcribing ? "transcribing" : ""}`}
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
          {recording ? <RecordIcon /> : transcribing ? "…" : <MicIcon />}
        </button>

        <button
          className="btn-icon btn-attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title="Bild oder Textdatei anhängen (auch per Einfügen oder Drag & Drop)"
        >
          <ClipIcon />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={[...ACCEPTED, ...TEXT_EXTS, ...PDF_EXTS].join(",")}
          multiple
          hidden
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
