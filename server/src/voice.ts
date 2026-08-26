import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

const WHISPER_MODEL =
  process.env.WHISPER_MODEL ??
  path.join(homedir(), "whisper-models", "ggml-large-v3-turbo.bin");
const PIPER_MODEL =
  process.env.PIPER_MODEL ??
  path.join(import.meta.dirname, "..", "voices", "de_DE-thorsten-high.onnx");
const WHISPER_LANG = process.env.WHISPER_LANG ?? "de";

export async function transcribeAudio(input: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "oxa-voice-"));
  const rawPath = path.join(dir, "in.raw");
  const wavPath = path.join(dir, "in.wav");
  try {
    await writeFile(rawPath, input);
    await pExecFile(
      "ffmpeg",
      ["-y", "-i", rawPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { timeout: 30_000 },
    );
    const { stdout } = await pExecFile(
      "whisper-cli",
      ["-m", WHISPER_MODEL, "-f", wavPath, "-nt", "-np", "-l", WHISPER_LANG],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/https?:\/\/\S+/g, "Link")
    .replace(/\s+/g, " ")
    .trim();
}

export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const cleaned = stripMarkdownForSpeech(text);
  if (!cleaned) throw new Error("Kein sprechbarer Text");

  const dir = await mkdtemp(path.join(tmpdir(), "oxa-tts-"));
  const wavPath = path.join(dir, "out.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        "python3",
        ["-m", "piper", "-m", PIPER_MODEL, "-f", wavPath, "--sentence-silence", "0.2"],
        { stdio: ["pipe", "ignore", "pipe"] },
      );
      let err = "";
      proc.stderr.on("data", (d) => (err += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`piper exit ${code}: ${err.slice(-400)}`)),
      );
      proc.stdin.write(cleaned);
      proc.stdin.end();
    });
    return await readFile(wavPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
