export type TrackType = "video" | "audio" | "text";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface Asset {
  id: string;
  type: "video" | "audio" | "image";
  name: string;
  /** Object URL or remote URL. Object URLs are session-local. */
  src: string;
  file?: File;
  duration: number;
  width?: number;
  height?: number;
  fps?: number | null;
  hasAudio?: boolean;
  videoCodec?: string | null;
  audioCodec?: string | null;
  createdAt: number;
}

export interface ClipTransform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
}

export interface ClipAdjustments {
  brightness: number; // -100..100
  contrast: number; // -100..100
  saturation: number; // -100..100
}

export interface ChromaKeySettings {
  enabled: boolean;
  color: string; // hex
  tolerance: number; // 0..1
  softness: number; // 0..1
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  background: string;
  outlineColor: string;
  outlineWidth: number;
  align: "left" | "center" | "right";
}

export interface SpeedPoint {
  /** Normalized position within clip duration (0..1). */
  t: number;
  /** Speed multiplier at this point. */
  speed: number;
}

export interface Clip {
  id: string;
  trackId: string;
  assetId?: string;
  type: "video" | "audio" | "image" | "text" | "caption";
  name: string;
  /** Timeline start in seconds. */
  start: number;
  /** Timeline duration in seconds (after speed). */
  duration: number;
  /** Trim-in within source asset in seconds. */
  trimIn: number;
  /** Trim-out within source asset in seconds (source time). */
  trimOut: number;
  speed: number;
  speedCurve?: SpeedPoint[];
  volume: number;
  muted: boolean;
  transform: ClipTransform;
  adjustments: ClipAdjustments;
  chromaKey?: ChromaKeySettings;
  aiCutout?: boolean;
  text?: string;
  textStyle?: TextStyle;
  locked?: boolean;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  clips: Clip[];
  muted: boolean;
  locked: boolean;
  visible: boolean;
  /** Higher order renders on top for visual tracks. */
  order: number;
}

export interface ProjectSettings {
  aspect: AspectRatio;
  width: number;
  height: number;
  fps: number;
  background: string;
}

export interface Project {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  settings: ProjectSettings;
  assets: Asset[];
  tracks: Track[];
  /** Used for dashboard thumbnail preview if captured. */
  thumbnailDataUrl?: string;
}

export interface ExportSettings {
  container: "mp4" | "webm";
  videoCodec: "avc" | "vp9" | "av1";
  audioCodec: "aac" | "opus";
  width: number;
  height: number;
  fps: 30 | 60;
  bitrateMbps: number;
  presetId: string;
  label: string;
}

export interface TimelineSelection {
  clipId?: string;
  trackId?: string;
  playhead: number;
}
