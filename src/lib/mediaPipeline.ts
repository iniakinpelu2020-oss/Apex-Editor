/**
 * The media pipeline: read a file, then cut it.
 *
 * Both halves are built on mediabunny, and the important property is that the
 * export is the same data path the preview would use — there is no second
 * implementation to fall out of step with.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type ConversionCanceledError,
} from "mediabunny";
import type { AudioCodec, Container, VideoCodec } from "./capabilities";

export interface ClipInfo {
  name: string;
  bytes: number;
  duration: number;
  width: number | null;
  height: number | null;
  rotation: number;
  fps: number | null;
  videoCodec: string | null;
  videoCodecString: string | null;
  audioCodec: string | null;
  audioCodecString: string | null;
  channels: number | null;
  sampleRate: number | null;
  /** False means this device cannot decode the file, so playback and export would fail. */
  decodable: boolean;
  /** Why it cannot be decoded, in words a person can act on. */
  decodeProblem: string | null;
}

export interface ExportRequest {
  start: number;
  end: number;
  /** Output height. The width follows the source aspect ratio. */
  height: number;
  container: Container;
  /**
   * The codec the chosen preset promises. This is not advisory: if the source
   * is a different codec, the export forces a transcode. Without it, mediabunny
   * happily copies a VP9 track into an MP4 and the download is not H.264 at all.
   */
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
}

export interface ExportHooks {
  onProgress?: (progress: number) => void;
  /** Handed the live Conversion so the caller can cancel it. */
  onConversion?: (conversion: Conversion) => void;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: "mp4" | "webm";
  /** Wall-clock milliseconds spent exporting. */
  ms: number;
  /** Tracks that did not make it into the output, and why. */
  discarded: { trackType: string; reason: string }[];
  /** A plain-language caveat worth showing, or null. */
  caveat: string | null;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Read everything the UI needs to show about a file, including whether this
 * device can actually decode it.
 *
 * The decode probe matters most: an unsupported codec otherwise presents as a
 * spinner that never finishes, which looks like a broken app rather than an
 * unsupported file.
 */
export async function inspectClip(file: File): Promise<ClipInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  const info: ClipInfo = {
    name: file.name,
    bytes: file.size,
    duration: 0,
    width: null,
    height: null,
    rotation: 0,
    fps: null,
    videoCodec: null,
    videoCodecString: null,
    audioCodec: null,
    audioCodecString: null,
    channels: null,
    sampleRate: null,
    decodable: false,
    decodeProblem: null,
  };

  try {
    if (!(await input.canRead())) {
      info.decodeProblem = "This file is not a video container this browser can read. Try MP4 (H.264) or WebM.";
      return info;
    }

    info.duration = await input.computeDuration();

    const video = await input.getPrimaryVideoTrack();
    if (video) {
      // getDisplayWidth/Height account for rotation metadata, which is what a
      // phone records when you shoot in portrait.
      info.width = await video.getDisplayWidth();
      info.height = await video.getDisplayHeight();
      info.rotation = await video.getRotation();
      info.videoCodec = await video.getCodec();
      info.videoCodecString = await video.getCodecParameterString();
      try {
        const metrics = await video.computeFrameRateMetrics();
        info.fps = metrics.bestGuessFrameRate || null;
      } catch {
        info.fps = null;
      }

      // canDecode() already accounts for registered custom decoders; the raw
      // isConfigSupported check pins down the exact codec string.
      const canDecodeTrack = await video.canDecode();
      if (!canDecodeTrack) {
        info.decodable = false;
        info.decodeProblem =
          `This device cannot decode ${info.videoCodecString ?? info.videoCodec ?? "this video codec"}. ` +
          "Unsupported codec on this device — nothing here will fix it, export from a device that can play it.";
      } else {
        info.decodable = true;
        const config = await video.getDecoderConfig();
        if (config && typeof globalThis.VideoDecoder !== "undefined") {
          try {
            const support = await globalThis.VideoDecoder.isConfigSupported(config);
            if (!support.supported) {
              info.decodable = false;
              info.decodeProblem = `The video decoder refused the codec string ${config.codec}. Unsupported codec on this device.`;
            }
          } catch (err) {
            info.decodable = false;
            info.decodeProblem = `The video decoder could not accept this file: ${describe(err)}`;
          }
        }
      }
    } else {
      info.decodeProblem = "There is no video track in this file. Milestone 1 only handles video.";
    }

    const audio = await input.getPrimaryAudioTrack();
    if (audio) {
      info.audioCodec = await audio.getCodec();
      info.audioCodecString = await audio.getCodecParameterString();
      info.channels = await audio.getNumberOfChannels();
      info.sampleRate = await audio.getSampleRate();
    }
  } catch (err) {
    info.decodeProblem = `Could not read this file: ${describe(err)}`;
  } finally {
    input.dispose();
  }

  return info;
}

/**
 * Cut [start, end) out of the file and return a real Blob.
 *
 * Copy is preferred: when the source codecs already fit the target container and
 * no resize was asked for, mediabunny copies the encoded packets instead of
 * re-encoding them. That is the difference between a two-second export and a
 * two-minute one. When a copy is impossible it transcodes automatically, so the
 * caller never has to know which happened.
 */
export async function exportClip(
  file: File,
  req: ExportRequest,
  hooks: ExportHooks = {}
): Promise<ExportResult> {
  const startedAt = performance.now();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const target = new BufferTarget();
  const format =
    req.container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
  const output = new Output({ format, target });

  const source = await input.getPrimaryVideoTrack();
  if (!source) {
    input.dispose();
    throw new Error("This file has no video track to export.");
  }

  const sourceHeight = await source.getDisplayHeight();
  const sourceWidth = await source.getDisplayWidth();
  const sourceVideoCodec = await source.getCodec();

  // Only ever downscale. Upscaling a 720p clip to 1080p produces a bigger file
  // of the same picture, which is a slower export for no gain.
  const wantsResize = req.height < sourceHeight;
  const targetHeight = wantsResize ? req.height : sourceHeight;
  const targetWidth = wantsResize
    ? Math.round(((sourceWidth * targetHeight) / sourceHeight) / 2) * 2
    : sourceWidth;

  // A preset is a promise about the codec, not just the container. If the source
  // does not already carry that codec, the codec has to be named explicitly so
  // the export re-encodes instead of copying a mismatched track into the file.
  const codecMismatch = sourceVideoCodec !== req.videoCodec;
  const videoOptions = wantsResize
    ? { codec: req.videoCodec, width: targetWidth, height: targetHeight, fit: "contain" as const }
    : codecMismatch
      ? { codec: req.videoCodec }
      : undefined;

  const sourceAudio = await input.getPrimaryAudioTrack();
  const sourceAudioCodec = sourceAudio ? await sourceAudio.getCodec() : null;
  const audioMismatch = sourceAudio !== null && sourceAudioCodec !== req.audioCodec;

  const conversion = await Conversion.init({
    input,
    output,
    // 'primary' keeps the first video and audio track and drops the rest, which
    // is what a single-clip trim means. Multi-track comes with the timeline.
    tracks: "primary",
    trim: { start: req.start, end: req.end },
    copy: { mode: "preferred" },
    video: videoOptions,
    // Only name an audio codec when it has to change. Naming it unnecessarily
    // turns a free audio copy into a resample-and-re-encode for no reason.
    audio: audioMismatch ? { codec: req.audioCodec } : undefined,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks
      .map((t) => `${t.track.type} track: ${t.reason}`)
      .join("\n");
    input.dispose();
    throw new Error(
      `This device cannot produce that file.\n${reasons || "No reason given by the encoder."}\n\n` +
        "Pick another preset, or lower the resolution."
    );
  }

  hooks.onConversion?.(conversion);
  if (hooks.onProgress) {
    conversion.onProgress = (p) => hooks.onProgress?.(Math.max(0, Math.min(1, p)));
  }

  try {
    await conversion.execute();
    hooks.onProgress?.(1);
  } catch (err) {
    input.dispose();
    // A cancel is not a failure, so let the caller tell them apart.
    if (err instanceof Error && err.name === "ConversionCanceledError") {
      throw err as ConversionCanceledError;
    }
    throw new Error(`Export failed: ${describe(err)}`);
  }

  const buffer = target.buffer;
  if (!buffer) {
    input.dispose();
    throw new Error("The encoder finished but produced no data.");
  }

  const discarded = conversion.discardedTracks.map((t) => ({
    trackType: t.track.type,
    reason: t.reason,
  }));

  const mimeType = req.container === "mp4" ? "video/mp4" : "video/webm";
  const result: ExportResult = {
    blob: new Blob([buffer], { type: mimeType }),
    mimeType,
    extension: req.container === "mp4" ? "mp4" : "webm",
    ms: Math.round(performance.now() - startedAt),
    discarded,
    caveat: wantsResize || (sourceVideoCodec !== req.videoCodec)
      ? `Re-encoded to ${req.videoCodec.toUpperCase()}, which is why it took real time rather than a copy.${wantsResize ? ` Resolution changed from ${sourceHeight}p to ${targetHeight}p.` : ` Source was ${(sourceVideoCodec ?? "unknown").toUpperCase()}.`}`
      : "Source codec and size already matched the preset, so the media was copied where the trim allowed it.",
  };

  input.dispose();
  return result;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, seconds);
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return m > 0 ? `${m}:${s.toFixed(2).padStart(5, "0")}` : `${s.toFixed(2)}s`;
}
