import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Playwright, PwPage } from "./harness.ts";

/**
 * Короткое видео для защиты: запись экрана настоящего бота и озвучка ElevenLabs.
 * Каждая фраза начинается в момент своего действия на экране, сцена длится,
 * пока не закончатся и фраза, и ответ бота.
 */
export interface Segment {
  readonly id: string;
  readonly say: string;
  readonly act: (page: PwPage) => Promise<void>;
}

export interface VideoResult {
  readonly file: string;
  readonly seconds: number;
  readonly segments: readonly { readonly id: string; readonly startMs: number; readonly voiceMs: number }[];
}

/** Голос Liam из библиотеки ElevenLabs, его выбрал автор проекта. Темп чуть быстрее, как в первом видео. */
const VOICE = "TX3LPaxmHKxFdv7VOQHJ";
const TEMPO = 1.22;

const forSpeech = (text: string): string =>
  text.replaceAll("VoroniX.ai", "ВорониКс эй-ай").replaceAll("VoroniX", "ВорониКс").replaceAll("CRM", "Си Ар Эм");

async function synthesize(text: string, file: string, key: string, previous: string, next: string): Promise<void> {
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({
      text: forSpeech(text),
      model_id: "eleven_v4",
      language_code: "ru",
      previous_text: forSpeech(previous),
      next_text: forSpeech(next),
    }),
  });
  if (!response.ok) {
    throw new Error(`ElevenLabs ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
  }
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

const probeSeconds = (file: string): number =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

export async function recordDemoVideo(options: {
  readonly base: string;
  readonly playwright: Playwright;
  readonly outFile: string;
  readonly workDir: string;
  readonly elevenKey: string;
  readonly segments: readonly Segment[];
}): Promise<VideoResult> {
  const { base, playwright, outFile, workDir, elevenKey, segments } = options;
  mkdirSync(workDir, { recursive: true });
  const voice: number[] = [];
  for (const [index, segment] of segments.entries()) {
    const file = path.join(workDir, `${segment.id}.mp3`);
    const previous = segments[index - 1]?.say ?? "";
    const next = segments[index + 1]?.say ?? "";
    // Озвучка платная: если текст реплики не менялся, берём готовый файл из прошлого прогона.
    const keyFile = path.join(workDir, `${segment.id}.key`);
    const key = JSON.stringify([VOICE, segment.say, previous, next]);
    if (!existsSync(file) || !existsSync(keyFile) || readFileSync(keyFile, "utf8") !== key) {
      await synthesize(segment.say, file, elevenKey, previous, next);
      writeFileSync(keyFile, key);
    }
    voice.push(Math.round((probeSeconds(file) * 1000) / TEMPO));
  }

  const rawDir = path.join(workDir, "raw");
  const browser = await playwright.chromium.launch();
  const starts: number[] = [];
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: rawDir, size: { width: 1280, height: 720 } },
      colorScheme: "dark",
      locale: "ru-RU",
    });
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(base);
    for (const [index, segment] of segments.entries()) {
      const start = Date.now();
      starts.push(start - t0);
      await segment.act(page);
      const left = start + (voice[index] ?? 0) + 600 - Date.now();
      if (left > 0) {
        await page.waitForTimeout(left);
      }
    }
    await page.waitForTimeout(1000);
    await context.close();
  } finally {
    await browser.close();
  }

  const raw = readdirSync(rawDir).find((file) => file.endsWith(".webm"));
  if (raw === undefined) {
    throw new Error("Playwright did not save the screen recording");
  }
  const inputs = segments.flatMap((segment) => ["-i", path.join(workDir, `${segment.id}.mp3`)]);
  const chains = segments.map((_segment, index) => {
    const delay = String(starts[index] ?? 0);
    return `[${String(index + 1)}:a]atempo=${String(TEMPO)},adelay=${delay}|${delay}[a${String(index)}]`;
  });
  const mix = `${segments.map((_segment, index) => `[a${String(index)}]`).join("")}amix=inputs=${String(segments.length)}:normalize=0,loudnorm=I=-14:LRA=7:TP=-1.5[aout]`;
  mkdirSync(path.dirname(outFile), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-i", path.join(rawDir, raw),
    ...inputs,
    "-filter_complex", [...chains, mix].join(";"),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    outFile,
  ]);
  return {
    file: outFile,
    seconds: Math.round(probeSeconds(outFile) * 10) / 10,
    segments: segments.map((segment, index) => ({ id: segment.id, startMs: starts[index] ?? 0, voiceMs: voice[index] ?? 0 })),
  };
}
