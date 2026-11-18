/**
 * Integration hooks for the Apex AI Router backend.
 * All calls are UI/integration-ready: they require VITE_APEX_AI_ROUTER_URL and
 * gracefully report when not configured. No secrets are stored client-side.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function routerBase(): string | null {
  const url = (import.meta.env.VITE_APEX_AI_ROUTER_URL as string | undefined)?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

export function aiConfigured(): boolean {
  return routerBase() !== null;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const base = routerBase();
  if (!base) throw new Error("Apex AI Router is not configured. Set VITE_APEX_AI_ROUTER_URL to enable AI tools.");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`AI router error ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function chatCompletions(messages: ChatMessage[], model?: string): Promise<string> {
  const data = await postJson<{ choices?: { message?: { content?: string } }[]; content?: string }>(
    "/v1/chat/completions",
    { model: model ?? "default", messages, stream: false }
  );
  const content = data.choices?.[0]?.message?.content ?? data.content;
  if (!content) throw new Error("AI router returned no content.");
  return content;
}

export async function textToSpeech(text: string, voice?: string): Promise<Blob> {
  const base = routerBase();
  if (!base) throw new Error("Apex AI Router is not configured. Set VITE_APEX_AI_ROUTER_URL to enable TTS.");
  const res = await fetch(`${base}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice: voice ?? "default", format: "mp3" }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`TTS error ${res.status}: ${err || res.statusText}`);
  }
  return await res.blob();
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export async function transcribeAudioPlaceholder(file: File): Promise<TranscriptSegment[]> {
  // Integration-ready hook: if a Whisper/transcription route is exposed by the
  // router, this can POST the audio. For now we attempt a conventional endpoint
  // and surface a clear message if unavailable.
  const base = routerBase();
  if (!base) {
    throw new Error(
      "Auto-caption transcription endpoint is not configured. Set VITE_APEX_AI_ROUTER_URL (Worker AI Whisper route) to enable server transcription."
    );
  }
  const form = new FormData();
  form.append("file", file);
  form.append("model", "whisper");
  const res = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Transcription error ${res.status}: ${err || res.statusText}`);
  }
  const data = (await res.json()) as { segments?: TranscriptSegment[]; text?: string };
  if (Array.isArray(data.segments)) return data.segments;
  if (typeof data.text === "string" && data.text.trim()) {
    return [{ start: 0, end: 0, text: data.text.trim() }];
  }
  throw new Error("Transcription response did not include segments.");
}
