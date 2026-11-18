import { useEffect, useRef } from "react";
import type { Project } from "../types/editor";
import { renderCompositeFrame } from "../lib/mediaPipeline";
import type { MediaElements } from "./EditorScreen";
import { clamp } from "../utils/format";

interface Props {
  project: Project;
  playhead: number;
  playing: boolean;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  media: MediaElements;
}

export function Preview({ project, playhead, playing, duration, onSeek, media }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = project.settings.width;
    canvas.height = project.settings.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    // Sync and play/pause underlying media elements based on active clips.
    const activeVideoIds = new Set<string>();
    const activeAudioIds = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (playhead < clip.start || playhead >= clip.start + clip.duration) continue;
        if ((clip.type === "video" || clip.type === "audio") && clip.assetId) {
          if (clip.type === "video" || track.type === "video") activeVideoIds.add(clip.assetId);
          if (clip.type === "audio" || track.type === "audio" || (clip.type === "video" && !track.muted)) activeAudioIds.add(clip.assetId);
          const el = (clip.type === "audio" ? media.audio.get(clip.assetId) : media.video.get(clip.assetId)) as HTMLMediaElement | undefined;
          if (el) {
            const local = clamp(playhead - clip.start, 0, clip.duration);
            const srcTime = clip.trimIn + local * Math.max(0.1, clip.speed || 1);
            if (Math.abs(el.currentTime - srcTime) > 0.15) {
              try { el.currentTime = Math.min(Math.max(0, srcTime), el.duration || srcTime); } catch { /* seek race */ }
            }
            el.playbackRate = clamp(clip.speed || 1, 0.1, 16);
            el.muted = track.muted || clip.muted || (track.type === "video"); // audio mixed via video elements off in preview except audio track elements
            if (playing && el.paused) void el.play().catch(() => undefined);
            if (!playing && !el.paused) el.pause();
          }
        }
      }
    }
    // Pause inactive.
    for (const [id, el] of media.video.entries()) {
      if (!activeVideoIds.has(id)) { if (!el.paused) el.pause(); }
      el.muted = true; // visual-only in canvas preview; audio handled separately below
    }
    for (const [id, el] of media.audio.entries()) {
      if (!activeAudioIds.has(id)) { if (!el.paused) el.pause(); }
      // For audio tracks, unmute when active.
      el.muted = !activeAudioIds.has(id);
    }

    let cancelled = false;
    void renderCompositeFrame(ctx, project, playhead, {
      getVideoElement: (id) => media.video.get(id),
      getImageElement: (id) => media.image.get(id),
    }).then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
  }, [project, playhead, playing, media]);

  return (
    <div className="preview-panel">
      <div className="preview-stage" style={{ aspectRatio: `${project.settings.width} / ${project.settings.height}` }}>
        <canvas ref={canvasRef} className="preview-canvas" />
      </div>
      <div className="preview-scrub">
        <input
          type="range"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.01}
          value={Math.min(playhead, duration)}
          onChange={(e) => onSeek(Number(e.target.value))}
        />
      </div>
    </div>
  );
}
