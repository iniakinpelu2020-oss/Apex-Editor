/**
 * Media inspection and export pipeline.
 *
 * - Single-clip trim/export uses mediabunny Conversion (copy-preferred fast path).
 * - Multi-clip/composited timelines use a canvas composition renderer and are
 *   encoded via WebCodecs through mediabunny Output + CanvasSource when possible.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import type { AudioCodec, Container, ExportPreset, VideoCodec } from "./capabilities";
import type { Clip, Project, Track } from "../types/editor";
import { clamp } from "../utils/format";

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
  hasAudio: boolean;
  decodable: boolean;
  decodeProblem: string | null;
}

export interface SimpleExportRequest {
  start: number;
  end: number;
  height: number;
  container: Container;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec;
  fps?: number;
  bitrateMbps?: number;
}

export interface ExportHooks {
  onProgress?: (progress: number) => void;
  onConversion?: (conversion: Conversion) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: "mp4" | "webm";
  ms: number;
  discarded: { trackType: string; reason: string }[];
  caveat: string | null;
  path: "copy" | "transcode" | "composite";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
    hasAudio: false,
    decodable: false,
    decodeProblem: null,
  };

  try {
    if (!(await input.canRead())) {
      info.decodeProblem = "This file is not a readable media container in this browser.";
      return info;
    }
    info.duration = await input.computeDuration();
    const video = await input.getPrimaryVideoTrack();
    if (video) {
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
      const canDecodeTrack = await video.canDecode();
      if (!canDecodeTrack) {
        info.decodable = false;
        info.decodeProblem = `This device cannot decode ${info.videoCodecString ?? info.videoCodec ?? "this video codec"}.`;
      } else {
        info.decodable = true;
        const config = await video.getDecoderConfig();
        if (config && typeof globalThis.VideoDecoder !== "undefined") {
          try {
            const support = await globalThis.VideoDecoder.isConfigSupported(config);
            if (!support.supported) {
              info.decodable = false;
              info.decodeProblem = `Decoder rejected codec ${config.codec} on this device.`;
            }
          } catch (err) {
            info.decodable = false;
            info.decodeProblem = `Decoder could not accept this file: ${describe(err)}`;
          }
        }
      }
    } else {
      // Audio-only assets are valid for audio tracks.
      info.decodable = true;
    }

    const audio = await input.getPrimaryAudioTrack();
    if (audio) {
      info.hasAudio = true;
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

export async function exportClip(
  file: File,
  req: SimpleExportRequest,
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
  const wantsResize = req.height < sourceHeight;
  const targetHeight = wantsResize ? req.height : sourceHeight;
  const targetWidth = wantsResize
    ? Math.round(((sourceWidth * targetHeight) / sourceHeight) / 2) * 2
    : sourceWidth;
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
    tracks: "primary",
    trim: { start: req.start, end: req.end },
    copy: { mode: "preferred" },
    video: videoOptions,
    audio: audioMismatch ? { codec: req.audioCodec } : undefined,
  });

  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => `${t.track.type} track: ${t.reason}`).join("\n");
    input.dispose();
    throw new Error(`This device cannot produce that file.\n${reasons || "No reason given."}`);
  }

  hooks.onConversion?.(conversion);
  if (hooks.onProgress) conversion.onProgress = (p) => hooks.onProgress?.(Math.max(0, Math.min(1, p)));

  try {
    await conversion.execute();
    hooks.onProgress?.(1);
  } catch (err) {
    input.dispose();
    throw err;
  }

  const buffer = target.buffer;
  if (!buffer) {
    input.dispose();
    throw new Error("Encoder finished but produced no data.");
  }

  const copied = !wantsResize && !codecMismatch && !audioMismatch;
  const result: ExportResult = {
    blob: new Blob([buffer], { type: req.container === "mp4" ? "video/mp4" : "video/webm" }),
    mimeType: req.container === "mp4" ? "video/mp4" : "video/webm",
    extension: req.container === "mp4" ? "mp4" : "webm",
    ms: Math.round(performance.now() - startedAt),
    discarded: conversion.discardedTracks.map((t) => ({ trackType: t.track.type, reason: t.reason })),
    caveat: copied
      ? "Fast path: source matched target settings, so media was remuxed/copied where possible."
      : "Transcode path: re-encoded to match selected format, resolution, or codec (hardware acceleration preferred when available).",
    path: copied ? "copy" : "transcode",
  };
  input.dispose();
  return result;
}

/** Determine whether a project can use the single-clip fast export path. */
export function canUseFastPath(project: Project, preset: ExportPreset): { ok: boolean; reason: string } {
  const videoTracks = project.tracks.filter((t) => t.type === "video" && t.visible);
  const audioTracks = project.tracks.filter((t) => t.type === "audio" && !t.muted);
  const textTracks = project.tracks.filter((t) => t.type === "text" && t.visible);
  const allVideoClips = videoTracks.flatMap((t) => t.clips);
  const allAudioClips = audioTracks.flatMap((t) => t.clips);
  const allTextClips = textTracks.flatMap((t) => t.clips);
  if (allTextClips.length > 0) return { ok: false, reason: "text/overlay tracks require composition" };
  if (allVideoClips.length !== 1) return { ok: false, reason: "fast path requires exactly one visible video clip" };
  if (allAudioClips.length > 1) return { ok: false, reason: "multiple audio clips require composition/mix" };
  const clip = allVideoClips[0];
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (!asset || !asset.file) return { ok: false, reason: "source file unavailable for remux/copy" };
  const hasEffects = clip.adjustments.brightness !== 0 || clip.adjustments.contrast !== 0 || clip.adjustments.saturation !== 0;
  const transformed = clip.transform.x !== 0 || clip.transform.y !== 0 || clip.transform.scale !== 1 || clip.transform.opacity !== 1 || clip.transform.rotation !== 0;
  if (hasEffects || transformed || clip.chromaKey?.enabled || clip.aiCutout) return { ok: false, reason: "visual effects/transforms require composition" };
  if (clip.speed !== 1 || (clip.speedCurve && clip.speedCurve.length)) return { ok: false, reason: "speed changes require re-timing/re-encode" };
  if (clip.start !== 0) return { ok: false, reason: "timeline offset requires composition" };
  if (preset.fps !== 30 && asset.fps && Math.abs(asset.fps - preset.fps) > 0.5) return { ok: false, reason: "frame-rate conversion requires re-encode" };
  return { ok: true, reason: "single unmodified clip eligible for remux/copy path" };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 255, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function applyChromaKey(image: ImageData, color: string, tolerance: number, softness: number) {
  const key = hexToRgb(color);
  const tol = clamp(tolerance, 0, 1) * 255;
  const soft = clamp(softness, 0, 1) * 255 + 1;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const dr = d[i] - key.r;
    const dg = d[i + 1] - key.g;
    const db = d[i + 2] - key.b;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < tol) d[i + 3] = 0;
    else if (dist < tol + soft) d[i + 3] = Math.round(((dist - tol) / soft) * 255);
  }
}

export interface CompositionSources {
  getVideoElement: (assetId: string) => HTMLVideoElement | undefined;
  getImageElement: (assetId: string) => HTMLImageElement | undefined;
}

export function activeClipsAt(tracks: Track[], type: Track["type"], t: number): Clip[] {
  return tracks
    .filter((tr) => tr.type === type && tr.visible)
    .sort((a, b) => a.order - b.order)
    .flatMap((tr) => tr.clips.filter((c) => !c.muted && t >= c.start && t < c.start + c.duration));
}

export function clipSourceTime(clip: Clip, timelineTime: number): number {
  const local = clamp(timelineTime - clip.start, 0, clip.duration);
  const speed = Math.max(0.1, clip.speed || 1);
  return clip.trimIn + local * speed;
}

export async function renderCompositeFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  t: number,
  sources: CompositionSources
): Promise<void> {
  const { width, height } = project.settings;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = project.settings.background || "#000";
  ctx.fillRect(0, 0, width, height);

  const visualTracks = project.tracks
    .filter((tr) => (tr.type === "video" || tr.type === "text") && tr.visible)
    .sort((a, b) => a.order - b.order);

  for (const track of visualTracks) {
    for (const clip of track.clips) {
      if (t < clip.start || t >= clip.start + clip.duration) continue;
      if (track.type === "video" && (clip.type === "video" || clip.type === "image")) {
        const el = clip.type === "image"
          ? sources.getImageElement(clip.assetId || "")
          : sources.getVideoElement(clip.assetId || "");
        if (!el) continue;
        if (clip.type === "video") {
          const video = el as HTMLVideoElement;
          const srcTime = clipSourceTime(clip, t);
          // Best-effort seek for frame-accurate-ish composition.
          if (Math.abs(video.currentTime - srcTime) > 0.04) {
            try { video.currentTime = Math.min(Math.max(0, srcTime), video.duration || srcTime); } catch { /* ignore */ }
          }
        }
        ctx.save();
        ctx.globalAlpha = clamp(clip.transform.opacity ?? 1, 0, 1);
        const cx = width / 2 + (clip.transform.x || 0);
        const cy = height / 2 + (clip.transform.y || 0);
        ctx.translate(cx, cy);
        ctx.rotate(((clip.transform.rotation || 0) * Math.PI) / 180);
        const scale = clip.transform.scale || 1;
        const dw = (el instanceof HTMLVideoElement ? el.videoWidth || width : (el as HTMLImageElement).naturalWidth || width) * scale;
        const dh = (el instanceof HTMLVideoElement ? el.videoHeight || height : (el as HTMLImageElement).naturalHeight || height) * scale;
        const fitScale = Math.min(width / dw, height / dh) * scale;
        const rw = dw * fitScale;
        const rh = dh * fitScale;
        const b = clip.adjustments?.brightness ?? 0;
        const c = clip.adjustments?.contrast ?? 0;
        const s = clip.adjustments?.saturation ?? 0;
        const filters: string[] = [];
        if (b !== 0) filters.push(`brightness(${1 + b / 100})`);
        if (c !== 0) filters.push(`contrast(${1 + c / 100})`);
        if (s !== 0) filters.push(`saturate(${1 + s / 100})`);
        ctx.filter = filters.length ? filters.join(" ") : "none";
        if (clip.chromaKey?.enabled) {
          // Draw to temp canvas for chroma key processing.
          const tmp = document.createElement("canvas");
          tmp.width = Math.max(1, Math.round(rw));
          tmp.height = Math.max(1, Math.round(rh));
          const tctx = tmp.getContext("2d");
          if (tctx) {
            tctx.drawImage(el, 0, 0, tmp.width, tmp.height);
            const img = tctx.getImageData(0, 0, tmp.width, tmp.height);
            applyChromaKey(img, clip.chromaKey.color || "#00ff00", clip.chromaKey.tolerance ?? 0.2, clip.chromaKey.softness ?? 0.1);
            tctx.putImageData(img, 0, 0);
            ctx.drawImage(tmp, -rw / 2, -rh / 2, rw, rh);
          } else {
            ctx.drawImage(el, -rw / 2, -rh / 2, rw, rh);
          }
        } else {
          ctx.drawImage(el, -rw / 2, -rh / 2, rw, rh);
        }
        ctx.restore();
      } else if (track.type === "text" || clip.type === "text" || clip.type === "caption") {
        const text = clip.text || clip.name || "";
        if (!text) continue;
        const style = clip.textStyle;
        ctx.save();
        ctx.globalAlpha = clamp(clip.transform.opacity ?? 1, 0, 1);
        const x = width / 2 + (clip.transform.x || 0);
        const y = height - 120 + (clip.transform.y || 0);
        ctx.translate(x, y);
        ctx.rotate(((clip.transform.rotation || 0) * Math.PI) / 180);
        const fontSize = (style?.fontSize ?? 48) * (clip.transform.scale || 1);
        ctx.font = `${style?.fontWeight ?? 700} ${fontSize}px ${style?.fontFamily ?? "ui-sans-serif, system-ui, sans-serif"}`;
        ctx.textAlign = style?.align ?? "center";
        ctx.textBaseline = "middle";
        const lines = text.split("\n");
        const lineHeight = fontSize * 1.25;
        lines.forEach((line, i) => {
          const ly = (i - (lines.length - 1) / 2) * lineHeight;
          if ((style?.outlineWidth ?? 4) > 0) {
            ctx.strokeStyle = style?.outlineColor ?? "rgba(0,0,0,0.9)";
            ctx.lineWidth = style?.outlineWidth ?? 4;
            ctx.strokeText(line, 0, ly);
          }
          if (style?.background && style.background !== "transparent") {
            const metrics = ctx.measureText(line);
            const pad = fontSize * 0.25;
            ctx.fillStyle = style.background;
            ctx.fillRect(-metrics.width / 2 - pad, ly - fontSize / 2 - pad / 2, metrics.width + pad * 2, fontSize + pad);
          }
          ctx.fillStyle = style?.color ?? "#ffffff";
          ctx.fillText(line, 0, ly);
        });
        ctx.restore();
      }
    }
  }
  ctx.restore();
}

export async function exportComposedProject(
  project: Project,
  preset: ExportPreset,
  sources: CompositionSources,
  hooks: ExportHooks = {}
): Promise<ExportResult> {
  const startedAt = performance.now();
  const duration = Math.max(0.1, projectDuration(project));
  const width = preset.width || project.settings.width;
  const height = preset.height || project.settings.height;
  const fps = preset.fps || 30;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas 2D context unavailable for composition export.");

  // Try mediabunny CanvasSource path for WebCodecs hardware-accelerated encoding.
  try {
    const target = new BufferTarget();
    const format = preset.container === "mp4"
      ? new Mp4OutputFormat({ fastStart: "in-memory" })
      : new WebMOutputFormat();
    const output = new Output({ format, target });
    const videoSource = new CanvasSource(canvas, {
      codec: preset.videoCodec as "avc" | "vp9",
      bitrate: preset.bitrateMbps * 1_000_000,
    } as unknown as ConstructorParameters<typeof CanvasSource>[1]);
    output.addVideoTrack(videoSource, { frameRate: fps });
    await output.start();

    const totalFrames = Math.ceil(duration * fps);
    const frameDuration = 1 / fps;
    for (let i = 0; i < totalFrames; i++) {
      if (hooks.signal?.aborted) throw new DOMException("Export canceled", "AbortError");
      const t = i * frameDuration;
      await renderCompositeFrame(ctx, project, t, sources);
      await videoSource.add(t, frameDuration);
      hooks.onProgress?.(Math.min(1, (i + 1) / totalFrames));
      // Yield periodically to keep UI responsive.
      if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
    }

    videoSource.close();
    await output.finalize();
    const buffer = target.buffer;
    if (!buffer) throw new Error("Composition export produced no data.");
    return {
      blob: new Blob([buffer], { type: preset.mimeType }),
      mimeType: preset.mimeType,
      extension: preset.extension,
      ms: Math.round(performance.now() - startedAt),
      discarded: [],
      caveat: "Composited export: multi-track timeline rendered and encoded with WebCodecs (hardware acceleration preferred when supported). Audio mixing for multi-source compositions may be limited in this path.",
      path: "composite",
    };
  } catch (err) {
    // Fallback: MediaRecorder captureStream path.
    const stream = canvas.captureStream(fps);
    const mimeCandidates = preset.container === "webm"
      ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
      : ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];
    const mimeType = mimeCandidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) || "video/webm";
    if (typeof MediaRecorder === "undefined") throw err;
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: preset.bitrateMbps * 1_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    const stopped = new Promise<void>((resolve, reject) => {
      recorder.onerror = () => reject(new Error("MediaRecorder failed during composition export."));
      recorder.onstop = () => resolve();
    });
    recorder.start(250);
    const totalFrames = Math.ceil(duration * fps);
    const frameDuration = 1 / fps;
    for (let i = 0; i < totalFrames; i++) {
      if (hooks.signal?.aborted) {
        recorder.stop();
        throw new DOMException("Export canceled", "AbortError");
      }
      const t = i * frameDuration;
      await renderCompositeFrame(ctx, project, t, sources);
      hooks.onProgress?.(Math.min(1, (i + 1) / totalFrames));
      await new Promise((r) => setTimeout(r, (frameDuration * 1000) / 2));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: mimeType });
    const ext = mimeType.includes("mp4") ? "mp4" : "webm";
    return {
      blob,
      mimeType,
      extension: ext,
      ms: Math.round(performance.now() - startedAt),
      discarded: [],
      caveat: `Composited export used MediaRecorder fallback (${mimeType}). Install/enable WebCodecs for the full hardware-accelerated pipeline.`,
      path: "composite",
    };
  }
}

export function projectDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) for (const clip of track.clips) max = Math.max(max, clip.start + clip.duration);
  return max;
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
