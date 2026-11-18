/**
 * Device encoding capabilities and export presets.
 *
 * Probes WebCodecs/mediabunny support and exposes only presets the device can
 * realistically produce. Hardware acceleration is requested via prefer-hardware
 * where supported by the browser.
 */
import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

export type Container = "mp4" | "webm";
export type VideoCodec = "avc" | "vp9";
export type AudioCodec = "aac" | "opus";

export interface RawProbe {
  codec: string;
  label: string;
  supported: boolean;
  hardwarePath: boolean;
  error?: string;
}

export interface ExportPreset {
  id: string;
  label: string;
  container: Container;
  width: number;
  height: number;
  fps: 30 | 60;
  bitrateMbps: number;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  extension: "mp4" | "webm";
  mimeType: string;
  fastPathEligible: boolean;
}

export interface Capabilities {
  webCodecs: boolean;
  aacPolyfilled: boolean;
  avcCodecString: string | null;
  raw: RawProbe[];
  presets: ExportPreset[];
  notes: string[];
}

const AVC_PROFILES = [
  { codec: "avc1.42001f", label: "H.264 Baseline 3.1", width: 1280, height: 720 },
  { codec: "avc1.4d002a", label: "H.264 Main 3.1", width: 1280, height: 720 },
  { codec: "avc1.4d0028", label: "H.264 Main 4.0", width: 1920, height: 1080 },
  { codec: "avc1.640028", label: "H.264 High 4.0", width: 1920, height: 1080 },
  { codec: "avc1.640033", label: "H.264 High 5.1", width: 3840, height: 2160 },
];

function hasWebCodecs(): boolean {
  return typeof globalThis.VideoEncoder !== "undefined" && typeof globalThis.VideoDecoder !== "undefined";
}

async function probeRaw(
  codec: string,
  label: string,
  width: number,
  height: number,
  framerate: number,
  bitrate: number
): Promise<RawProbe> {
  if (typeof globalThis.VideoEncoder === "undefined") {
    return { codec, label, supported: false, hardwarePath: false, error: "VideoEncoder unavailable" };
  }
  const base: VideoEncoderConfig = { codec, width, height, bitrate, framerate };
  try {
    const plain = await globalThis.VideoEncoder.isConfigSupported(base);
    let hardwarePath = false;
    if (plain.supported) {
      try {
        const hw = await globalThis.VideoEncoder.isConfigSupported({
          ...base,
          hardwareAcceleration: "prefer-hardware",
        } as VideoEncoderConfig);
        hardwarePath = Boolean(hw.supported);
      } catch {
        hardwarePath = false;
      }
    }
    return { codec, label, supported: Boolean(plain.supported), hardwarePath };
  } catch (err) {
    return { codec, label, supported: false, hardwarePath: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function even(n: number): number {
  return Math.round(n / 2) * 2;
}

function dimsForHeight(aspectW: number, aspectH: number, targetHeight: number): { width: number; height: number } {
  const height = even(targetHeight);
  const width = even((height * aspectW) / aspectH);
  return { width, height };
}

export async function detectCapabilities(): Promise<Capabilities> {
  const notes: string[] = [];
  if (!hasWebCodecs()) {
    return {
      webCodecs: false,
      aacPolyfilled: false,
      avcCodecString: null,
      raw: [],
      presets: [],
      notes: ["WebCodecs is unavailable. Export requires a current Chromium, Safari, or Firefox build with encoder support."],
    };
  }

  let aacPolyfilled = false;
  try {
    if (!(await canEncodeAudio("aac"))) {
      registerAacEncoder();
      aacPolyfilled = true;
      notes.push("Native AAC encoder unavailable; bundled AAC encoder registered for MP4 export.");
    }
  } catch (err) {
    notes.push(`AAC capability check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const raw: RawProbe[] = [];
  // Probe representative AVC profiles and VP9 at common targets.
  for (const p of AVC_PROFILES) {
    raw.push(await probeRaw(p.codec, `${p.label} ${p.height}p`, p.width, p.height, 30, 8_000_000));
  }
  raw.push(await probeRaw("vp09.00.10.08", "VP9 Profile 0 720p", 1280, 720, 30, 5_000_000));
  raw.push(await probeRaw("vp09.00.31.08", "VP9 Profile 0 1080p", 1920, 1080, 30, 8_000_000));
  raw.push(await probeRaw("vp09.00.51.08", "VP9 Profile 0 4K", 3840, 2160, 30, 20_000_000));

  const supportedAvc = raw.filter((r) => r.codec.startsWith("avc1") && r.supported);
  const avc720ok = supportedAvc.some((r) => /3\.1|720/.test(r.label));
  const avc1080ok = supportedAvc.some((r) => /4\.0|1080/.test(r.label));
  const avc4kok = supportedAvc.some((r) => /5\.1|4K|2160/.test(r.label));
  const vp9_720 = raw.find((r) => r.codec === "vp09.00.10.08")?.supported ?? false;
  const vp9_1080 = raw.find((r) => r.codec === "vp09.00.31.08")?.supported ?? false;
  const vp9_4k = raw.find((r) => r.codec === "vp09.00.51.08")?.supported ?? false;
  const avcCodecString = supportedAvc.sort((a, b) => b.codec.localeCompare(a.codec))[0]?.codec ?? null;

  const presets: ExportPreset[] = [];

  async function tryAdd(p: Omit<ExportPreset, "id"> & { id?: string }) {
    const videoOk = await canEncodeVideo(p.videoCodec, { width: p.width, height: p.height }).catch(() => false);
    const audioOk = await canEncodeAudio(p.audioCodec).catch(() => false);
    if (!videoOk || !audioOk) return;
    presets.push({ id: p.id ?? `${p.container}-${p.height}p${p.fps}`, ...p } as ExportPreset);
  }

  const aspect16x9 = { w: 16, h: 9 };
  const targets: { labelBase: string; height: number; fps: 30 | 60; bitrateMbps: number }[] = [
    { labelBase: "720p", height: 720, fps: 30, bitrateMbps: 5 },
    { labelBase: "720p", height: 720, fps: 60, bitrateMbps: 7.5 },
    { labelBase: "1080p", height: 1080, fps: 30, bitrateMbps: 8 },
    { labelBase: "1080p", height: 1080, fps: 60, bitrateMbps: 12 },
    { labelBase: "4K", height: 2160, fps: 30, bitrateMbps: 35 },
    { labelBase: "4K", height: 2160, fps: 60, bitrateMbps: 53 },
  ];

  for (const t of targets) {
    const { width, height } = dimsForHeight(aspect16x9.w, aspect16x9.h, t.height);
    const is4k = t.height >= 2160;
    if (avc720ok || avc1080ok || avc4kok) {
      if ((t.height <= 720 && avc720ok) || (t.height === 1080 && avc1080ok) || (is4k && avc4kok)) {
        await tryAdd({
          label: `MP4 · H.264 · ${t.labelBase} ${t.fps}fps · ${t.bitrateMbps} Mbps`,
          container: "mp4",
          width,
          height,
          fps: t.fps,
          bitrateMbps: t.bitrateMbps,
          videoCodec: "avc",
          audioCodec: "aac",
          extension: "mp4",
          mimeType: "video/mp4",
          fastPathEligible: true,
        });
      }
    }
    if (vp9_720 || vp9_1080 || vp9_4k) {
      if ((t.height <= 720 && vp9_720) || (t.height === 1080 && vp9_1080) || (is4k && vp9_4k)) {
        await tryAdd({
          label: `WebM · VP9 · ${t.labelBase} ${t.fps}fps · ${t.bitrateMbps} Mbps`,
          container: "webm",
          width,
          height,
          fps: t.fps,
          bitrateMbps: t.bitrateMbps,
          videoCodec: "vp9",
          audioCodec: "opus",
          extension: "webm",
          mimeType: "video/webm",
          fastPathEligible: true,
        });
      }
    }
  }

  if (!supportedAvc.length) {
    notes.push("No H.264 encoder detected; MP4 presets are hidden and WebM/VP9 is preferred when available.");
  }
  if (aacPolyfilled) {
    notes.push("AAC uses the bundled software encoder; expect slower MP4 exports than native hardware AAC paths.");
  }
  if (!presets.some((p) => p.height >= 2160)) {
    notes.push("4K export presets are unavailable on this device/browser. 1080p is the recommended maximum.");
  }

  return {
    webCodecs: true,
    aacPolyfilled,
    avcCodecString,
    raw,
    presets,
    notes,
  };
}

export async function probeHardwarePreference(codec: string, width: number, height: number, bitrate: number, framerate: number): Promise<boolean> {
  if (typeof globalThis.VideoEncoder === "undefined") return false;
  try {
    const hw = await globalThis.VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate,
      hardwareAcceleration: "prefer-hardware",
    } as VideoEncoderConfig);
    return Boolean(hw.supported);
  } catch {
    return false;
  }
}
