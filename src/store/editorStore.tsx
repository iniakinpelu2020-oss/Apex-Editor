import React, { createContext, useContext, useMemo, useReducer } from "react";
import type { Asset, Clip, Project, Track, TrackType } from "../types/editor";
import { createProject, cloneProject, createTrack, makeClipFromAsset } from "../lib/project";
import { uid } from "../utils/id";

interface HistoryState {
  past: Project[];
  present: Project;
  future: Project[];
}

type Action =
  | { type: "NEW_PROJECT"; title?: string; aspect?: Project["settings"]["aspect"] }
  | { type: "LOAD_PROJECT"; project: Project }
  | { type: "SET_TITLE"; title: string }
  | { type: "SET_SETTINGS"; settings: Partial<Project["settings"]> }
  | { type: "ADD_ASSET"; asset: Asset }
  | { type: "REMOVE_ASSET"; assetId: string }
  | { type: "ADD_TRACK"; trackType: TrackType }
  | { type: "REMOVE_TRACK"; trackId: string }
  | { type: "UPDATE_TRACK"; trackId: string; patch: Partial<Track> }
  | { type: "REORDER_TRACKS"; trackId: string; direction: "up" | "down" }
  | { type: "ADD_CLIP"; trackId: string; clip: Clip }
  | { type: "UPDATE_CLIP"; clipId: string; patch: Partial<Clip> }
  | { type: "REMOVE_CLIP"; clipId: string }
  | { type: "MOVE_CLIP"; clipId: string; trackId: string; start: number }
  | { type: "SPLIT_CLIP"; clipId: string; at: number }
  | { type: "ADD_ASSET_TO_TIMELINE"; assetId: string; trackType?: TrackType }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "REPLACE_PRESENT"; project: Project };

function withHistory(state: HistoryState, next: Project): HistoryState {
  return { past: [...state.past.slice(-49), cloneProject(state.present)], present: next, future: [] };
}

function updateProject(project: Project, updater: (p: Project) => void): Project {
  const next = cloneProject(project);
  updater(next);
  next.updatedAt = Date.now();
  return next;
}

function findTrack(project: Project, trackId: string): Track | undefined {
  return project.tracks.find((t) => t.id === trackId);
}

function reducer(state: HistoryState, action: Action): HistoryState {
  const { present } = state;
  switch (action.type) {
    case "NEW_PROJECT":
      return { past: [], present: createProject(action.title, action.aspect), future: [] };
    case "LOAD_PROJECT":
      return { past: [], present: cloneProject(action.project), future: [] };
    case "REPLACE_PRESENT":
      return { ...state, present: cloneProject(action.project) };
    case "SET_TITLE":
      return withHistory(state, updateProject(present, (p) => { p.title = action.title; }));
    case "SET_SETTINGS":
      return withHistory(state, updateProject(present, (p) => { p.settings = { ...p.settings, ...action.settings }; }));
    case "ADD_ASSET":
      return withHistory(state, updateProject(present, (p) => {
        if (!p.assets.find((a) => a.id === action.asset.id)) p.assets.push(action.asset);
      }));
    case "REMOVE_ASSET":
      return withHistory(state, updateProject(present, (p) => {
        p.assets = p.assets.filter((a) => a.id !== action.assetId);
        for (const t of p.tracks) t.clips = t.clips.filter((c) => c.assetId !== action.assetId);
      }));
    case "ADD_TRACK": {
      const order = present.tracks.length ? Math.max(...present.tracks.map((t) => t.order)) + 10 : 10;
      const name = action.trackType === "video" ? `Video ${present.tracks.filter((t) => t.type === "video").length + 1}`
        : action.trackType === "audio" ? `Audio ${present.tracks.filter((t) => t.type === "audio").length + 1}`
        : `Text ${present.tracks.filter((t) => t.type === "text").length + 1}`;
      return withHistory(state, updateProject(present, (p) => { p.tracks.push(createTrack(action.trackType, name, order)); }));
    }
    case "REMOVE_TRACK":
      return withHistory(state, updateProject(present, (p) => { p.tracks = p.tracks.filter((t) => t.id !== action.trackId); }));
    case "UPDATE_TRACK":
      return withHistory(state, updateProject(present, (p) => {
        const t = findTrack(p, action.trackId);
        if (t) Object.assign(t, action.patch);
      }));
    case "REORDER_TRACKS":
      return withHistory(state, updateProject(present, (p) => {
        const sorted = [...p.tracks].sort((a, b) => a.order - b.order);
        const idx = sorted.findIndex((t) => t.id === action.trackId);
        if (idx < 0) return;
        const swapWith = action.direction === "up" ? idx + 1 : idx - 1;
        if (swapWith < 0 || swapWith >= sorted.length) return;
        const tmp = sorted[idx].order;
        sorted[idx].order = sorted[swapWith].order;
        sorted[swapWith].order = tmp;
        p.tracks = sorted;
      }));
    case "ADD_CLIP":
      return withHistory(state, updateProject(present, (p) => {
        const t = findTrack(p, action.trackId);
        if (t) t.clips.push({ ...action.clip, trackId: action.trackId });
      }));
    case "UPDATE_CLIP":
      return withHistory(state, updateProject(present, (p) => {
        for (const t of p.tracks) {
          const c = t.clips.find((x) => x.id === action.clipId);
          if (c) { Object.assign(c, action.patch); break; }
        }
      }));
    case "REMOVE_CLIP":
      return withHistory(state, updateProject(present, (p) => {
        for (const t of p.tracks) t.clips = t.clips.filter((c) => c.id !== action.clipId);
      }));
    case "MOVE_CLIP":
      return withHistory(state, updateProject(present, (p) => {
        let clip: Clip | undefined;
        for (const t of p.tracks) {
          const idx = t.clips.findIndex((c) => c.id === action.clipId);
          if (idx >= 0) { clip = t.clips.splice(idx, 1)[0]; break; }
        }
        if (!clip) return;
        const target = findTrack(p, action.trackId);
        if (!target) return;
        clip.trackId = action.trackId;
        clip.start = Math.max(0, action.start);
        target.clips.push(clip);
      }));
    case "SPLIT_CLIP":
      return withHistory(state, updateProject(present, (p) => {
        for (const t of p.tracks) {
          const idx = t.clips.findIndex((c) => c.id === action.clipId);
          if (idx < 0) continue;
          const c = t.clips[idx];
          const splitAt = action.at;
          if (splitAt <= c.start + 0.05 || splitAt >= c.start + c.duration - 0.05) return;
          const leftDur = splitAt - c.start;
          const rightDur = c.duration - leftDur;
          const speed = Math.max(0.1, c.speed || 1);
          const right: Clip = {
            ...JSON.parse(JSON.stringify(c)),
            id: uid("clip"),
            start: splitAt,
            duration: rightDur,
            trimIn: c.trimIn + leftDur * speed,
          };
          c.duration = leftDur;
          c.trimOut = c.trimIn + leftDur * speed;
          t.clips.splice(idx + 1, 0, right);
          return;
        }
      }));
    case "ADD_ASSET_TO_TIMELINE":
      return withHistory(state, updateProject(present, (p) => {
        const asset = p.assets.find((a) => a.id === action.assetId);
        if (!asset) return;
        const trackType = action.trackType ?? (asset.type === "audio" ? "audio" : "video");
        let track = p.tracks.filter((t) => t.type === trackType).sort((a, b) => b.order - a.order)[0];
        if (!track) {
          track = createTrack(trackType, trackType === "audio" ? "Audio 1" : "Video 1", 20);
          p.tracks.push(track);
        }
        const end = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
        track.clips.push(makeClipFromAsset(track.id, asset, end));
      }));
    case "UNDO": {
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return { past: state.past.slice(0, -1), present: cloneProject(previous), future: [cloneProject(state.present), ...state.future] };
    }
    case "REDO": {
      if (!state.future.length) return state;
      const [next, ...rest] = state.future;
      return { past: [...state.past, cloneProject(state.present)], present: cloneProject(next), future: rest };
    }
    default:
      return state;
  }
}

interface EditorContextValue {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  dispatch: React.Dispatch<Action>;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({ past: [], present: createProject("Untitled Project"), future: [] }));
  const value = useMemo<EditorContextValue>(() => ({
    project: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    dispatch,
  }), [state]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used within EditorProvider");
  return ctx;
}
