/**
 * Lightweight DSP helpers for silence detection and beat/transient markers.
 * These are deterministic, fast, and run fully client-side.
 */

export interface TimeRange {
  start: number;
  end: number;
}

export interface SilenceOptions {
  thresholdDb?: number; // default -42
  minDuration?: number; // seconds, default 0.3
  windowMs?: number; // default 50
}

export async function decodeAudioBuffer(file: File): Promise<AudioBuffer | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    try {
      const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      return buffer;
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

export function detectSilence(buffer: AudioBuffer, opts: SilenceOptions = {}): TimeRange[] {
  const thresholdDb = opts.thresholdDb ?? -42;
  const minDuration = opts.minDuration ?? 0.3;
  const windowMs = opts.windowMs ?? 50;
  const threshold = Math.pow(10, thresholdDb / 20);
  const channelData = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const windowSize = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const ranges: TimeRange[] = [];
  let silentStart: number | null = null;

  for (let i = 0; i < channelData.length; i += windowSize) {
    let sum = 0;
    const end = Math.min(channelData.length, i + windowSize);
    for (let j = i; j < end; j++) {
      const v = channelData[j];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (end - i || 1));
    const t = i / sampleRate;
    const isSilent = rms < threshold;
    if (isSilent && silentStart === null) silentStart = t;
    if (!isSilent && silentStart !== null) {
      if (t - silentStart >= minDuration) ranges.push({ start: silentStart, end: t });
      silentStart = null;
    }
  }
  if (silentStart !== null) {
    const end = buffer.duration;
    if (end - silentStart >= minDuration) ranges.push({ start: silentStart, end });
  }
  return ranges;
}

export function detectTransients(buffer: AudioBuffer, sensitivity = 1.3): number[] {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const windowSize = Math.floor(sampleRate * 0.05);
  const hop = Math.floor(windowSize / 2);
  const energies: number[] = [];
  for (let i = 0; i + windowSize <= data.length; i += hop) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const v = data[i + j];
      sum += v * v;
    }
    energies.push(sum / windowSize);
  }
  const peaks: number[] = [];
  for (let i = 1; i < energies.length - 1; i++) {
    const prev = energies[i - 1];
    const next = energies[i + 1];
    const localAvg = (prev + next) / 2 + 1e-9;
    if (energies[i] > localAvg * sensitivity && energies[i] > prev && energies[i] > next) {
      const t = (i * hop) / sampleRate;
      if (peaks.length === 0 || t - peaks[peaks.length - 1] > 0.25) peaks.push(t);
    }
  }
  return peaks;
}
