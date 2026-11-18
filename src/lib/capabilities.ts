/**
 * What this device can actually encode.
 *
 * Every export preset is probed here before it is offered, because a format
 * dropdown that fails on click is worse than a dropdown with three options.
 *
 * Two probes are used and they answer different questions:
 *   - mediabunny's canEncodeVideo/canEncodeAudio: "can this library encode this
 *     codec at these dimensions", including any custom encoder registered.
 *   - the raw VideoEncoder.isConfigSupported: "does this exact codec string
 *     work", which catches the case where a browser claims H.264 support but
 *     has no encoder for that profile.
 */
import { canEncodeAudio, canEncodeVideo } from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

export type Container = "mp4" | "webm";
export type VideoCodec = "avc" | "vp9";
export type AudioCodec = "aac" | "opus";

export interface RawProbe {
  codec: string;
  supported: boolean;
  /** True when the browser accepts a prefer-hardware config for this codec. */
  hardwarePath: boolean;
  error?: string;
}

export interface Capabilities {
  webCodecs: boolean;
  /** True when AAC had to be polyfilled, false when the browser could do it. */
  aacPolyfilled: boolean;
  /** Resolved codec string the browser will use for H.264, if any. */
  avcCodecString: string | null;
  raw: RawProbe[];
  /** Presets the device can actually produce. Empty means no export at all. */
  presets: ExportPreset[];
  /** Human-readable reasons for anything that was turned off. */
  notes: string[];
}

export interface ExportPreset {
  id: string;
  label: string;
  container: Container;
  height: number;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  extension: "mp4" | "webm";
  mimeType: string;
}

/** H.264 level 3.1 (720p30) and 4.0 (1080p30) in the AVCDecoderConfigurationRecord form. */
const AVC_CANDIDATES = [
  { codec: "avc1.4d002a", height: 720 }, // main profile, level 3.1
  { codec: "avc1.4d0034", height: 1080 }, // main profile, level 4.0
];

const DEFAULT_FPS = 30;
const DEFAULT_BITRATE = 6_000_000;

function hasWebCodecs(): boolean {
  return typeof globalThis.VideoEncoder !== "undefined" && typeof globalThis.VideoDecoder !== "undefined";
}

async function probeRaw(codec: string, width: number, height: number): Promise<RawProbe> {
  if (typeof globalThis.VideoEncoder === "undefined") {
    return { codec, supported: false, hardwarePath: false, error: "VideoEncoder is not available" };
  }
  const base = {
    codec,
    width,
    height,
    bitrate: DEFAULT_BITRATE,
    framerate: DEFAULT_FPS,
  };
  try {
    const plain = await globalThis.VideoEncoder.isConfigSupported(base);
    let hardwarePath = false;
    if (plain.supported) {
      try {
        const hardware = await globalThis.VideoEncoder.isConfigSupported({
          ...base,
          hardwareAcceleration: "prefer-hardware",
        });
        hardwarePath = Boolean(hardware.supported);
      } catch {
        hardwarePath = false;
      }
    }
    return { codec, supported: Boolean(plain.supported), hardwarePath };
  } catch (err) {
    return {
      codec,
      supported: false,
      hardwarePath: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Register the AAC encoder when the browser has none, then work out which export
 * presets exist.
 *
 * registerAacEncoder() is called here, on the main thread, on purpose. Calling it
 * inside a nested blob Web Worker stalls Firefox: the polyfill itself spins up a
 * worker, and Firefox refuses to nest one blob worker inside another.
 */
export async function detectCapabilities(): Promise<Capabilities> {
  const notes: string[] = [];

  if (!hasWebCodecs()) {
    return {
      webCodecs: false,
      aacPolyfilled: false,
      avcCodecString: null,
      raw: [],
      presets: [],
      notes: ["This browser has no WebCodecs, so nothing can be encoded here. Use a current Chrome, Edge, Safari or Firefox."],
    };
  }

  let aacPolyfilled = false;
  try {
    if (!(await canEncodeAudio("aac"))) {
      registerAacEncoder();
      aacPolyfilled = true;
      notes.push("No native AAC encoder, so the bundled AAC encoder is now in use. MP4 export still works.");
    }
  } catch (err) {
    notes.push(`Could not check AAC support: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Probe H.264 at both sizes, and VP9 as the fallback for devices with no encoder.
  const raw: RawProbe[] = [];
  for (const candidate of AVC_CANDIDATES) {
    const width = Math.round((candidate.height * 16) / 9 / 2) * 2;
    raw.push(await probeRaw(candidate.codec, width, candidate.height));
  }
  raw.push(await probeRaw("vp09.00.10.08", 1280, 720));

  const avc720 = raw.find((p) => p.codec === "avc1.4d002a")?.supported ?? false;
  const avc1080 = raw.find((p) => p.codec === "avc1.4d0034")?.supported ?? false;
  const vp9 = raw.find((p) => p.codec === "vp09.00.10.08")?.supported ?? false;

  const presets: ExportPreset[] = [];

  const avcOk720 = avc720 && (await canEncodeVideo("avc", { width: 1280, height: 720 }));
  const avcOk1080 = avc1080 && (await canEncodeVideo("avc", { width: 1920, height: 1080 }));

  if (avcOk720) {
    presets.push({
      id: "mp4-720",
      label: "MP4 · H.264 · 720p",
      container: "mp4",
      height: 720,
      videoCodec: "avc",
      audioCodec: "aac",
      extension: "mp4",
      mimeType: "video/mp4",
    });
  }
  if (avcOk1080) {
    presets.push({
      id: "mp4-1080",
      label: "MP4 · H.264 · 1080p",
      container: "mp4",
      height: 1080,
      videoCodec: "avc",
      audioCodec: "aac",
      extension: "mp4",
      mimeType: "video/mp4",
    });
  }

  if (vp9 && (await canEncodeVideo("vp9", { width: 1280, height: 720 }))) {
    presets.push({
      id: "webm-720",
      label: "WebM · VP9 · 720p",
      container: "webm",
      height: 720,
      videoCodec: "vp9",
      audioCodec: "opus",
      extension: "webm",
      mimeType: "video/webm",
    });
    if (await canEncodeVideo("vp9", { width: 1920, height: 1080 })) {
      presets.push({
        id: "webm-1080",
        label: "WebM · VP9 · 1080p",
        container: "webm",
        height: 1080,
        videoCodec: "vp9",
        audioCodec: "opus",
        extension: "webm",
        mimeType: "video/webm",
      });
    }
  }

  if (!avcOk720) {
    notes.push("This device has no H.264 encoder, so MP4 export is hidden rather than broken. WebM is offered instead.");
  }
  if (aacPolyfilled) {
    notes.push("AAC came from the bundled encoder, so MP4 audio is a software encode: slower than native, same result.");
  }

  return {
    webCodecs: true,
    aacPolyfilled,
    avcCodecString: avc1080 ? "avc1.4d0034" : avc720 ? "avc1.4d002a" : null,
    raw,
    presets,
    notes,
  };
}
