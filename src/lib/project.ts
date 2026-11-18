import type { AspectRatio, Asset, Clip, Project, ProjectSettings, Track } from "../types/editor";
import { uid } from "../utils/id";

const STORAGE_KEY = "apex.projects.v2";

export function defaultSettings(aspect: AspectRatio = "16:9"): ProjectSettings {
  if (aspect === "9:16") return { aspect, width: 1080, height: 1920, fps: 30, background: "#000000" };
  if (aspect === "1:1") return { aspect, width: 1080, height: 1080, fps: 30, background: "#000000" };
  return { aspect, width: 1920, height: 1080, fps: 30, background: "#000000" };
}

export function createTrack(type: Track["type"], name: string, order: number): Track {
  return {
    id: uid("trk"),
    type,
    name,
    clips: [],
    muted: false,
    locked: false,
    visible: true,
    order,
  };
}

export function createDefaultTracks(): Track[] {
  return [
    createTrack("text", "Text / Captions", 30),
    createTrack("video", "Video 1", 20),
    createTrack("audio", "Audio 1", 10),
  ];
}

export function createProject(title = "Untitled Project", aspect: AspectRatio = "16:9"): Project {
  const now = Date.now();
  return {
    id: uid("prj"),
    title,
    createdAt: now,
    updatedAt: now,
    settings: defaultSettings(aspect),
    assets: [],
    tracks: createDefaultTracks(),
  };
}

export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

export function listStoredProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Project[];
    return Array.isArray(parsed) ? parsed.sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch {
    return [];
  }
}

export function saveStoredProject(project: Project): void {
  const all = listStoredProjects().filter((p) => p.id !== project.id);
  // Strip non-serializable/runtime-only asset fields before persistence.
  const persistable: Project = {
    ...project,
    updatedAt: Date.now(),
    assets: project.assets.map((a) => ({ ...a, file: undefined, src: a.src.startsWith("blob:") ? "" : a.src })),
  };
  all.unshift(persistable);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, 20)));
  } catch {
    // If storage is full, keep only the newest few.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all.slice(0, 5)));
  }
}

export function deleteStoredProject(id: string): void {
  const all = listStoredProjects().filter((p) => p.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function projectDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clip.start + clip.duration);
    }
  }
  return max;
}

export function makeClipFromAsset(trackId: string, asset: Asset, start: number): Clip {
  const isImage = asset.type === "image";
  const duration = isImage ? 5 : Math.max(0.1, asset.duration || 5);
  return {
    id: uid("clip"),
    trackId,
    assetId: asset.id,
    type: asset.type,
    name: asset.name,
    start,
    duration,
    trimIn: 0,
    trimOut: isImage ? 5 : duration,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
    adjustments: { brightness: 0, contrast: 0, saturation: 0 },
  };
}
