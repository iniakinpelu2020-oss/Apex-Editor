import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../store/editorStore";
import { Timeline } from "./Timeline";
import { Preview } from "./Preview";
import { Inspector } from "./Inspector";
import { LeftPanel } from "./LeftPanel";
import { ExportDialog } from "./ExportDialog";

import { saveProject as saveProjectRemote, firebaseConfigured, signInWithGoogle, signOut, watchUser } from "../lib/firestore";
import { formatTime } from "../utils/format";

interface Props {
  onHome: () => void;
  onSaveLocal: () => void;
}

export type MediaElements = {
  video: Map<string, HTMLVideoElement>;
  image: Map<string, HTMLImageElement>;
  audio: Map<string, HTMLAudioElement>;
};

export function EditorScreen({ onHome, onSaveLocal }: Props) {
  const { project, dispatch, canUndo, canRedo } = useEditor();
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | undefined>();
  const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>();
  const [showExport, setShowExport] = useState(false);
  const [leftTab, setLeftTab] = useState<"media" | "ai" | "text">("media");
  const [user, setUser] = useState<{ uid: string; email: string | null; name: string | null } | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaElements>({ video: new Map(), image: new Map(), audio: new Map() });

  const duration = useMemo(() => {
    let max = 0;
    for (const t of project.tracks) for (const c of t.clips) max = Math.max(max, c.start + c.duration);
    return Math.max(max, 5);
  }, [project.tracks]);

  useEffect(() => {
    if (!firebaseConfigured) { setUser(null); return; }
    return watchUser(setUser);
  }, []);

  // Ensure media elements exist for assets.
  useEffect(() => {
    const { video, image, audio } = mediaRef.current;
    for (const asset of project.assets) {
      if (!asset.src) continue;
      if (asset.type === "video" && !video.has(asset.id)) {
        const el = document.createElement("video");
        el.src = asset.src;
        el.preload = "auto";
        el.playsInline = true;
        el.crossOrigin = "anonymous";
        video.set(asset.id, el);
      } else if (asset.type === "image" && !image.has(asset.id)) {
        const el = new Image();
        el.src = asset.src;
        el.crossOrigin = "anonymous";
        image.set(asset.id, el);
      } else if (asset.type === "audio" && !audio.has(asset.id)) {
        const el = document.createElement("audio");
        el.src = asset.src;
        el.preload = "auto";
        audio.set(asset.id, el);
      }
    }
  }, [project.assets]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPlayhead((p) => {
        const next = p + dt;
        if (next >= duration) { setPlaying(false); return duration; }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, duration]);

  const onSaveCloud = useCallback(async () => {
    if (!user) return;
    setSaveNote(null); setError(null);
    try {
      await saveProjectRemote(project, user.uid);
      setSaveNote(`Saved to cloud (projects/${project.id}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [user, project]);

  const onAuth = useCallback(async () => {
    setAuthBusy(true); setError(null);
    try { if (user) await signOut(); else await signInWithGoogle(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setAuthBusy(false); }
  }, [user]);

  const selectedClip = useMemo(() => {
    if (!selectedClipId) return undefined;
    for (const t of project.tracks) {
      const c = t.clips.find((x) => x.id === selectedClipId);
      if (c) return c;
    }
    return undefined;
  }, [project.tracks, selectedClipId]);

  const splitAtPlayhead = useCallback(() => {
    if (!selectedClipId) return;
    dispatch({ type: "SPLIT_CLIP", clipId: selectedClipId, at: playhead });
  }, [dispatch, selectedClipId, playhead]);

  const deleteSelected = useCallback(() => {
    if (!selectedClipId) return;
    dispatch({ type: "REMOVE_CLIP", clipId: selectedClipId });
    setSelectedClipId(undefined);
  }, [dispatch, selectedClipId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) dispatch({ type: "REDO" }); else dispatch({ type: "UNDO" });
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y")) {
        e.preventDefault(); dispatch({ type: "REDO" });
      } else if (e.key === " " ) {
        e.preventDefault(); setPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); splitAtPlayhead();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedClipId) { e.preventDefault(); deleteSelected(); }
      } else if (e.key === "Home") { setPlayhead(0); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, splitAtPlayhead, deleteSelected, selectedClipId]);

  return (
    <div className="app-shell editor-shell">
      <header className="topbar editor-topbar">
        <button className="ghost" onClick={onHome} title="Back to dashboard">← Home</button>
        <input className="project-title-input" value={project.title} onChange={(e) => dispatch({ type: "SET_TITLE", title: e.target.value })} />
        <span className="badge">{project.settings.aspect} · {project.settings.width}×{project.settings.height}</span>
        <span className="badge">{formatTime(playhead, true)} / {formatTime(duration, true)}</span>
        <div className="spacer" />
        <button onClick={() => dispatch({ type: "UNDO" })} disabled={!canUndo} title="Undo (Ctrl+Z)">Undo</button>
        <button onClick={() => dispatch({ type: "REDO" })} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button onClick={() => { onSaveLocal(); setSaveNote("Saved locally."); setTimeout(() => setSaveNote(null), 2000); }}>Save</button>
        {firebaseConfigured ? (
          <>
            <button onClick={onSaveCloud} disabled={!user}>Save Cloud</button>
            <button onClick={onAuth} disabled={authBusy}>{user ? "Sign out" : "Sign in"}</button>
          </>
        ) : <span className="tiny">Cloud save off</span>}
        <button className="primary" onClick={() => setShowExport(true)}>Export</button>
      </header>

      {(saveNote || error) && (
        <div className={`notice-bar ${error ? "error" : "ok"}`}>{error || saveNote}</div>
      )}

      <div className="editor-main">
        <LeftPanel tab={leftTab} onTab={setLeftTab} onError={setError} />
        <div className="center-column">
          <Preview project={project} playhead={playhead} playing={playing} onTogglePlay={() => setPlaying((p) => !p)} onSeek={setPlayhead} duration={duration} media={mediaRef.current} />
          <div className="transport-row">
            <button onClick={() => setPlayhead(0)}>⏮</button>
            <button className="primary" onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
            <button onClick={() => setPlayhead(duration)}>⏭</button>
            <button onClick={splitAtPlayhead} disabled={!selectedClipId} title="Split at playhead (S)">Split</button>
            <button onClick={deleteSelected} disabled={!selectedClipId} title="Delete selected (Del)">Delete</button>
            <span className="tiny">Space: play/pause · S: split · Del: remove · Ctrl+Z/Y: undo/redo</span>
          </div>
        </div>
        <Inspector clip={selectedClip} project={project} onError={setError} />
      </div>

      <Timeline
        project={project}
        playhead={playhead}
        duration={duration}
        selectedClipId={selectedClipId}
        selectedTrackId={selectedTrackId}
        onSeek={setPlayhead}
        onSelectClip={(id, tid) => { setSelectedClipId(id); setSelectedTrackId(tid); }}
        onSelectTrack={setSelectedTrackId}
      />

      {showExport && <ExportDialog project={project} media={mediaRef.current} onClose={() => setShowExport(false)} />}
    </div>
  );
}
