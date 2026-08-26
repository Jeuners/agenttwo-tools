import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  onTranscript: (text: string) => void;
  onQueueDrained: () => void;
}

export function useVoice({ onTranscript, onQueueDrained }: Options) {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const maxDurRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queueRef = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const drainedCbRef = useRef(onQueueDrained);
  drainedCbRef.current = onQueueDrained;
  const transcriptCbRef = useRef(onTranscript);
  transcriptCbRef.current = onTranscript;

  // ---- TTS ----
  const playNext = useCallback(async () => {
    if (busyRef.current) return;
    const next = queueRef.current.shift();
    if (next === undefined) {
      setSpeaking(false);
      drainedCbRef.current();
      return;
    }
    busyRef.current = true;
    setSpeaking(true);
    try {
      abortRef.current = new AbortController();
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: next }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      await new Promise<void>((resolve) => {
        audio.onended = () => resolve();
        audio.onerror = () => resolve();
        void audio.play().catch(() => resolve());
      });
      URL.revokeObjectURL(audio.src);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      busyRef.current = false;
      abortRef.current = null;
      void playNext();
    }
  }, []);

  const enqueueSpeech = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      queueRef.current.push(t);
      void playNext();
    },
    [playNext],
  );

  const cancelSpeech = useCallback(() => {
    queueRef.current = [];
    abortRef.current?.abort();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    busyRef.current = false;
    setSpeaking(false);
  }, []);

  // ---- STT / Recording ----
  const stopRecording = useCallback(() => {
    if (maxDurRef.current) clearTimeout(maxDurRef.current);
    maxDurRef.current = null;
    recorderRef.current?.state === "recording" && recorderRef.current.stop();
  }, []);

  const startRecording = useCallback(async () => {
    if (recorderRef.current?.state === "recording") return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecording(false);
        const blob = new Blob(chunksRef.current);
        chunksRef.current = [];
        if (blob.size < 2000) return;
        setTranscribing(true);
        try {
          const res = await fetch("/api/stt", {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: blob,
          });
          const data = (await res.json()) as { ok: boolean; text?: string; error?: string };
          if (!data.ok) throw new Error(data.error ?? "STT fehlgeschlagen");
          const text = data.text?.trim();
          if (text) transcriptCbRef.current(text);
          else setError("Nichts verstanden — bitte nochmal sprechen.");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      maxDurRef.current = setTimeout(() => stopRecording(), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onTranscript, stopRecording]);

  useEffect(() => {
    return () => {
      recorderRef.current?.state === "recording" && recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      cancelSpeech();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    recording,
    transcribing,
    speaking,
    error,
    setError,
    startRecording,
    stopRecording,
    enqueueSpeech,
    cancelSpeech,
  };
}
