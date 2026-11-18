import { useMemo } from "react";
import { useEditor } from "../store/editorStore";
import type { Clip, Project } from "../types/editor";

interface Props {
  clip?: Clip;
  project: Project;
  onError: (msg: string | null) => void;
}

export function Inspector({ clip, project }: Props) {
  const { dispatch } = useEditor();
  const track = useMemo(() => project.tracks.find((t) => t.clips.some((c) => c.id === clip?.id)), [project.tracks, clip?.id]);

  if (!clip) {
    return (
      <aside className="inspector">
        <div className="panel-tabs"><span className="tab-label">Inspector</span></div>
        <div className="panel-body">
          <p className="hint">Select a clip on the timeline to edit transform, adjustments, speed, chroma key, and text.</p>
          <section className="tool-card">
            <h3>Project</h3>
            <p className="tiny">Aspect: {project.settings.aspect} · {project.settings.width}×{project.settings.height} @ {project.settings.fps}fps</p>
            <p className="tiny">Tracks: {project.tracks.length} · Assets: {project.assets.length}</p>
          </section>
          <section className="tool-card">
            <h3>Shortcuts</h3>
            <p className="tiny">Space play/pause · S split · Delete remove · Ctrl/Cmd+Z undo · Ctrl/Cmd+Shift+Z or Y redo</p>
          </section>
        </div>
      </aside>
    );
  }

  const patch = (p: Partial<Clip>) => dispatch({ type: "UPDATE_CLIP", clipId: clip.id, patch: p });
  const patchAdj = (key: keyof Clip["adjustments"], value: number) => patch({ adjustments: { ...clip.adjustments, [key]: value } });
  const patchTransform = (key: keyof Clip["transform"], value: number) => patch({ transform: { ...clip.transform, [key]: value } });

  return (
    <aside className="inspector">
      <div className="panel-tabs"><span className="tab-label">Inspector · {clip.name}</span></div>
      <div className="panel-body">
        <section className="tool-card">
          <h3>Clip</h3>
          <p className="tiny">Type: {clip.type}{track ? ` · Track: ${track.name}` : ""}</p>
          <label>Start (s)</label>
          <input type="number" step={0.05} value={clip.start} onChange={(e) => patch({ start: Math.max(0, Number(e.target.value) || 0) })} />
          <label>Duration (s)</label>
          <input type="number" step={0.05} min={0.1} value={clip.duration} onChange={(e) => patch({ duration: Math.max(0.1, Number(e.target.value) || 0.1) })} />
          <label>Trim in (s)</label>
          <input type="number" step={0.05} min={0} value={clip.trimIn} onChange={(e) => patch({ trimIn: Math.max(0, Number(e.target.value) || 0) })} />
          <label>Volume</label>
          <input type="range" min={0} max={2} step={0.01} value={clip.volume} onChange={(e) => patch({ volume: Number(e.target.value) })} />
          <div className="tiny">{Math.round(clip.volume * 100)}%</div>
        </section>

        <section className="tool-card">
          <h3>Speed</h3>
          <label>Speed multiplier (0.1x – 100x)</label>
          <input type="range" min={0.1} max={100} step={0.1} value={clip.speed} onChange={(e) => patch({ speed: Number(e.target.value) })} />
          <div className="row">
            {[0.25, 0.5, 1, 1.5, 2, 4, 8].map((s) => <button key={s} onClick={() => patch({ speed: s })}>{s}x</button>)}
          </div>
          <input type="number" min={0.1} max={100} step={0.1} value={clip.speed} onChange={(e) => patch({ speed: Math.min(100, Math.max(0.1, Number(e.target.value) || 1)) })} />
          <p className="tiny">Speed curves: set base speed here. Keyframed speed curves are integration-ready via clip.speedCurve data model.</p>
        </section>

        <section className="tool-card">
          <h3>Retouch & Adjustments</h3>
          <label>Brightness ({clip.adjustments.brightness})</label>
          <input type="range" min={-100} max={100} value={clip.adjustments.brightness} onChange={(e) => patchAdj("brightness", Number(e.target.value))} />
          <label>Contrast ({clip.adjustments.contrast})</label>
          <input type="range" min={-100} max={100} value={clip.adjustments.contrast} onChange={(e) => patchAdj("contrast", Number(e.target.value))} />
          <label>Saturation ({clip.adjustments.saturation})</label>
          <input type="range" min={-100} max={100} value={clip.adjustments.saturation} onChange={(e) => patchAdj("saturation", Number(e.target.value))} />
          <button onClick={() => patch({ adjustments: { brightness: 0, contrast: 0, saturation: 0 } })}>Reset adjustments</button>
        </section>

        {(clip.type === "video" || clip.type === "image") && (
          <section className="tool-card">
            <h3>Background Removal</h3>
            <label className="check"><input type="checkbox" checked={!!clip.chromaKey?.enabled} onChange={(e) => patch({ chromaKey: { enabled: e.target.checked, color: clip.chromaKey?.color ?? "#00ff00", tolerance: clip.chromaKey?.tolerance ?? 0.22, softness: clip.chromaKey?.softness ?? 0.12 } })} /> Enable chroma key (green screen)</label>
            <label>Key color</label>
            <input type="color" value={clip.chromaKey?.color ?? "#00ff00"} onChange={(e) => patch({ chromaKey: { enabled: clip.chromaKey?.enabled ?? true, color: e.target.value, tolerance: clip.chromaKey?.tolerance ?? 0.22, softness: clip.chromaKey?.softness ?? 0.12 } })} />
            <label>Tolerance ({Math.round((clip.chromaKey?.tolerance ?? 0.22) * 100)}%)</label>
            <input type="range" min={0} max={1} step={0.01} value={clip.chromaKey?.tolerance ?? 0.22} onChange={(e) => patch({ chromaKey: { enabled: clip.chromaKey?.enabled ?? true, color: clip.chromaKey?.color ?? "#00ff00", tolerance: Number(e.target.value), softness: clip.chromaKey?.softness ?? 0.12 } })} />
            <label>Softness ({Math.round((clip.chromaKey?.softness ?? 0.12) * 100)}%)</label>
            <input type="range" min={0} max={1} step={0.01} value={clip.chromaKey?.softness ?? 0.12} onChange={(e) => patch({ chromaKey: { enabled: clip.chromaKey?.enabled ?? true, color: clip.chromaKey?.color ?? "#00ff00", tolerance: clip.chromaKey?.tolerance ?? 0.22, softness: Number(e.target.value) } })} />
            <label className="check"><input type="checkbox" checked={!!clip.aiCutout} onChange={(e) => patch({ aiCutout: e.target.checked })} /> AI subject cutout (integration-ready toggle)</label>
            <p className="tiny">AI cutout is a UI/integration hook for segmentation backends; chroma key works client-side in preview/composite export.</p>
          </section>
        )}

        <section className="tool-card">
          <h3>Transform</h3>
          <label>Position X ({clip.transform.x}px)</label>
          <input type="range" min={-1000} max={1000} value={clip.transform.x} onChange={(e) => patchTransform("x", Number(e.target.value))} />
          <label>Position Y ({clip.transform.y}px)</label>
          <input type="range" min={-1000} max={1000} value={clip.transform.y} onChange={(e) => patchTransform("y", Number(e.target.value))} />
          <label>Scale ({clip.transform.scale.toFixed(2)}x)</label>
          <input type="range" min={0.1} max={4} step={0.01} value={clip.transform.scale} onChange={(e) => patchTransform("scale", Number(e.target.value))} />
          <label>Rotation ({clip.transform.rotation}°)</label>
          <input type="range" min={-180} max={180} value={clip.transform.rotation} onChange={(e) => patchTransform("rotation", Number(e.target.value))} />
          <label>Opacity ({Math.round(clip.transform.opacity * 100)}%)</label>
          <input type="range" min={0} max={1} step={0.01} value={clip.transform.opacity} onChange={(e) => patchTransform("opacity", Number(e.target.value))} />
        </section>

        {(clip.type === "text" || clip.type === "caption") && (
          <section className="tool-card">
            <h3>Text / Caption</h3>
            <label>Content</label>
            <textarea rows={4} value={clip.text ?? ""} onChange={(e) => patch({ text: e.target.value })} />
            <label>Font size</label>
            <input type="number" min={8} max={300} value={clip.textStyle?.fontSize ?? 48} onChange={(e) => patch({ textStyle: { ...(clip.textStyle ?? { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 48, fontWeight: 700, color: "#fff", background: "transparent", outlineColor: "rgba(0,0,0,0.9)", outlineWidth: 4, align: "center" }), fontSize: Number(e.target.value) || 48 } })} />
            <label>Color</label>
            <input type="color" value={clip.textStyle?.color ?? "#ffffff"} onChange={(e) => patch({ textStyle: { ...(clip.textStyle ?? { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 48, fontWeight: 700, color: "#fff", background: "transparent", outlineColor: "rgba(0,0,0,0.9)", outlineWidth: 4, align: "center" }), color: e.target.value } })} />
            <label>Background</label>
            <input type="text" value={clip.textStyle?.background ?? "transparent"} onChange={(e) => patch({ textStyle: { ...(clip.textStyle ?? { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 48, fontWeight: 700, color: "#fff", background: "transparent", outlineColor: "rgba(0,0,0,0.9)", outlineWidth: 4, align: "center" }), background: e.target.value } })} />
          </section>
        )}
      </div>
    </aside>
  );
}
