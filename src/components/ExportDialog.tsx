import { useEffect, useMemo, useState } from "react";
import type { Project } from "../types/editor";
import { detectCapabilities, type Capabilities } from "../lib/capabilities";
import { canUseFastPath, exportClip, exportComposedProject, projectDuration } from "../lib/mediaPipeline";
import type { MediaElements } from "./EditorScreen";
import { formatBytes, formatTime } from "../utils/format";

interface Props {
  project: Project;
  media: MediaElements;
  onClose: () => void;
}

export function ExportDialog({ project, media, onClose }: Props) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [presetId, setPresetId] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ bytes: number; ms: number; caveat: string | null; path: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    detectCapabilities().then((c) => {
      if (cancelled) return;
      setCaps(c);
      setPresetId(c.presets[0]?.id ?? "");
    }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => { cancelled = true; };
  }, []);

  const preset = useMemo(() => caps?.presets.find((p) => p.id === presetId), [caps, presetId]);
  const duration = useMemo(() => projectDuration(project), [project]);
  const fastPath = useMemo(() => preset ? canUseFastPath(project, preset) : { ok: false, reason: "No preset selected" }, [project, preset]);

  const onExport = async () => {
    if (!preset) return;
    setError(null); setResult(null); setExporting(true); setProgress(0);
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    try {
      let out;
      if (fastPath.ok) {
        // Single-clip fast path via remux/copy-optimized Conversion.
        const videoTrack = project.tracks.find((t) => t.type === "video" && t.visible);
        const clip = videoTrack?.clips[0];
        const asset = clip ? project.assets.find((a) => a.id === clip.assetId) : undefined;
        if (!clip || !asset?.file) throw new Error("Fast path selected but source file is unavailable.");
        const start = clip.trimIn;
        const end = clip.trimIn + clip.duration; // speed==1 guaranteed by fast-path check
        out = await exportClip(asset.file, {
          start, end,
          height: preset.height,
          container: preset.container,
          videoCodec: preset.videoCodec,
          audioCodec: preset.audioCodec,
          fps: preset.fps,
          bitrateMbps: preset.bitrateMbps,
        }, { onProgress: setProgress });
      } else {
        out = await exportComposedProject(project, preset, {
          getVideoElement: (id) => media.video.get(id),
          getImageElement: (id) => media.image.get(id),
        }, { onProgress: setProgress, signal: ctrl.signal });
      }

      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.title.replace(/[^a-z0-9_-]+/gi, "_") || "apex-export"}-${preset.height}p${preset.fps}.${out.extension}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      setResult({ bytes: out.blob.size, ms: out.ms, caveat: out.caveat, path: out.path });
      setProgress(1);
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "ConversionCanceledError")) {
        setError("Export canceled.");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setExporting(false);
      setAbortCtrl(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !exporting && onClose()}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Export</h2>
          <button className="ghost" onClick={onClose} disabled={exporting}>✕</button>
        </div>

        {!caps && <p className="hint">Detecting device encoders and hardware acceleration paths…</p>}
        {caps && caps.presets.length === 0 && (
          <div className="error">No usable encoder presets found on this device. Try a current Chrome/Edge/Safari with WebCodecs support.</div>
        )}

        {caps && caps.presets.length > 0 && (
          <>
            <label>Resolution / format / bitrate preset</label>
            <select value={presetId} onChange={(e) => setPresetId(e.target.value)} disabled={exporting}>
              {caps.presets.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>

            <div className="export-info">
              <p><strong>Timeline:</strong> {formatTime(duration, true)} · {project.settings.width}×{project.settings.height} source canvas</p>
              <p><strong>Engine path:</strong> {fastPath.ok
                ? <span className="good-text">Fast path available — direct remux/stream copy when codecs and settings match (no re-encode).</span>
                : <span>Composition/transcode path — {fastPath.reason}. Hardware-accelerated WebCodecs encoding preferred when supported.</span>}</p>
              <p className="tiny">VP9 re-encode bottleneck avoided on the fast path via copy/remux. Format conversion and composited timelines use WebCodecs with prefer-hardware encoder configuration where available.</p>
            </div>

            {caps.notes.length > 0 && (
              <ul className="tiny notes-list">
                {caps.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" onClick={onExport} disabled={exporting || duration <= 0}>{exporting ? "Exporting…" : "Export & Download"}</button>
              {exporting && <button onClick={() => abortCtrl?.abort()}>Cancel</button>}
            </div>
          </>
        )}

        {exporting && (
          <div className="progress-block">
            <div className="bar"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
            <div className="tiny">{Math.round(progress * 100)}% · real-time progress</div>
          </div>
        )}

        {result && (
          <div className="ok" style={{ marginTop: 12 }}>
            Export complete: {formatBytes(result.bytes)} in {(result.ms / 1000).toFixed(2)}s ({result.path} path).
            {result.caveat ? <div className="tiny" style={{ marginTop: 4 }}>{result.caveat}</div> : null}
          </div>
        )}
        {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}
