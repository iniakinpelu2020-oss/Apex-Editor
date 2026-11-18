import { useMemo, useRef, useState } from "react";
import { useEditor } from "../store/editorStore";
import type { Clip, Project } from "../types/editor";
import { formatTime, clamp } from "../utils/format";

interface Props {
  project: Project;
  playhead: number;
  duration: number;
  selectedClipId?: string;
  selectedTrackId?: string;
  onSeek: (t: number) => void;
  onSelectClip: (clipId: string | undefined, trackId: string | undefined) => void;
  onSelectTrack: (trackId: string | undefined) => void;
}

const PX_PER_SEC_BASE = 80;

export function Timeline({ project, playhead, duration, selectedClipId, selectedTrackId, onSeek, onSelectClip, onSelectTrack }: Props) {
  const { dispatch } = useEditor();
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ clipId: string; startX: number; origStart: number; origTrackId: string } | null>(null);
  const [trim, setTrim] = useState<{ clipId: string; edge: "start" | "end"; startX: number; origStart: number; origDur: number; origTrimIn: number; origTrimOut: number } | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pxPerSec = PX_PER_SEC_BASE * zoom;
  const totalWidth = Math.max(duration, 10) * pxPerSec + 200;

  const tracks = useMemo(() => [...project.tracks].sort((a, b) => b.order - a.order), [project.tracks]); // higher order on top

  const ticks = useMemo(() => {
    const step = zoom >= 2 ? 0.5 : zoom >= 1 ? 1 : 2;
    const arr: number[] = [];
    for (let t = 0; t <= duration + step; t += step) arr.push(Number(t.toFixed(2)));
    return arr;
  }, [duration, zoom]);

  const onRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + (scrollerRef.current?.scrollLeft || 0) - 140; // header width offset
    const t = clamp(x / pxPerSec, 0, duration);
    onSeek(t);
  };

  const startDrag = (e: React.PointerEvent, clip: Clip) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ clipId: clip.id, startX: e.clientX, origStart: clip.start, origTrackId: clip.trackId });
    onSelectClip(clip.id, clip.trackId);
  };

  const startTrim = (e: React.PointerEvent, clip: Clip, edge: "start" | "end") => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setTrim({ clipId: clip.id, edge, startX: e.clientX, origStart: clip.start, origDur: clip.duration, origTrimIn: clip.trimIn, origTrimOut: clip.trimOut });
    onSelectClip(clip.id, clip.trackId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) {
      const dx = e.clientX - drag.startX;
      const dt = dx / pxPerSec;
      const newStart = Math.max(0, drag.origStart + dt);
      // Find track under cursor (simple: keep in same track for now; vertical move by drop)
      dispatch({ type: "MOVE_CLIP", clipId: drag.clipId, trackId: drag.origTrackId, start: newStart });
    } else if (trim) {
      const dx = e.clientX - trim.startX;
      const dt = dx / pxPerSec;
      if (trim.edge === "start") {
        const newStart = clamp(trim.origStart + dt, 0, trim.origStart + trim.origDur - 0.1);
        const delta = newStart - trim.origStart;
        const newDur = trim.origDur - delta;
        const speed = 1; // trim adjusts source in/out relative to speed; simplified
        dispatch({ type: "UPDATE_CLIP", clipId: trim.clipId, patch: { start: newStart, duration: newDur, trimIn: Math.max(0, trim.origTrimIn + delta * speed) } });
      } else {
        const newDur = Math.max(0.1, trim.origDur + dt);
        dispatch({ type: "UPDATE_CLIP", clipId: trim.clipId, patch: { duration: newDur, trimOut: trim.origTrimIn + newDur } });
      }
    }
  };

  const onPointerUp = () => { setDrag(null); setTrim(null); };

  const addTrack = (type: "video" | "audio" | "text") => dispatch({ type: "ADD_TRACK", trackType: type });

  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <strong>Timeline</strong>
        <span className="tiny">Drag clips to arrange · drag edges to trim · click ruler to seek</span>
        <div className="spacer" />
        <label className="tiny">Zoom</label>
        <input type="range" min={0.25} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} style={{ width: 120 }} />
        <button onClick={() => addTrack("video")}>+ Video track</button>
        <button onClick={() => addTrack("audio")}>+ Audio track</button>
        <button onClick={() => addTrack("text")}>+ Text track</button>
      </div>
      <div className="timeline-scroll" ref={scrollerRef} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <div className="timeline-inner" style={{ width: totalWidth }}>
          <div className="timeline-ruler" onClick={onRulerClick}>
            <div className="track-header-spacer" />
            <div className="ruler-ticks" style={{ width: totalWidth - 140 }}>
              {ticks.map((t) => (
                <div key={t} className="tick" style={{ left: t * pxPerSec }}>
                  <span>{formatTime(t)}</span>
                </div>
              ))}
              <div className="playhead-line" style={{ left: playhead * pxPerSec }} />
            </div>
          </div>
          {tracks.map((track) => (
            <div key={track.id} className={`timeline-track ${selectedTrackId === track.id ? "selected" : ""}`} onClick={() => onSelectTrack(track.id)}>
              <div className="track-header">
                <div className="track-name">{track.name}</div>
                <div className="track-controls">
                  <button className={track.visible ? "on" : ""} title="Visible" onClick={(e) => { e.stopPropagation(); dispatch({ type: "UPDATE_TRACK", trackId: track.id, patch: { visible: !track.visible } }); }}>👁</button>
                  <button className={track.muted ? "" : "on"} title="Mute" onClick={(e) => { e.stopPropagation(); dispatch({ type: "UPDATE_TRACK", trackId: track.id, patch: { muted: !track.muted } }); }}>M</button>
                  <button title="Layer up" onClick={(e) => { e.stopPropagation(); dispatch({ type: "REORDER_TRACKS", trackId: track.id, direction: "up" }); }}>↑</button>
                  <button title="Layer down" onClick={(e) => { e.stopPropagation(); dispatch({ type: "REORDER_TRACKS", trackId: track.id, direction: "down" }); }}>↓</button>
                </div>
              </div>
              <div className="track-lane" onClick={(e) => {
                if ((e.target as HTMLElement).closest(".clip")) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                onSeek(clamp(x / pxPerSec, 0, duration));
                onSelectClip(undefined, track.id);
              }}>
                <div className="playhead-line lane" style={{ left: playhead * pxPerSec }} />
                {track.clips.map((clip) => (
                  <div
                    key={clip.id}
                    className={`clip clip-${clip.type} ${selectedClipId === clip.id ? "selected" : ""}`}
                    style={{ left: clip.start * pxPerSec, width: Math.max(24, clip.duration * pxPerSec) }}
                    onPointerDown={(e) => startDrag(e, clip)}
                    onClick={(e) => { e.stopPropagation(); onSelectClip(clip.id, track.id); }}
                    title={`${clip.name} (${formatTime(clip.duration)})`}
                  >
                    <div className="trim-handle left" data-handle="left" onPointerDown={(e) => startTrim(e, clip, "start")} />
                    <div className="clip-label">{clip.name}{clip.type === "caption" || clip.type === "text" ? `: ${(clip.text || "").slice(0, 24)}` : ""}</div>
                    <div className="trim-handle right" data-handle="right" onPointerDown={(e) => startTrim(e, clip, "end")} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
