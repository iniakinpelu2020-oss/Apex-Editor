import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Conversion } from "mediabunny";
import { detectCapabilities, type Capabilities, type ExportPreset } from "./lib/capabilities";
import {
  exportClip,
  formatBytes,
  formatTime,
  inspectClip,
  type ClipInfo,
  type ExportResult,
} from "./lib/mediaPipeline";
import {
  firebaseConfigured,
  projectSize,
  saveProject,
  signInWithGoogle,
  signOut,
  watchUser,
  type ProjectDoc,
} from "./lib/firestore";

type AuthUser = { uid: string; email: string | null; name: string | null } | null;

const MIN_GAP = 0.1;

export default function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [info, setInfo] = useState<ClipInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [presetId, setPresetId] = useState<string>("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  const conversionRef = useRef<Conversion | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    let cancelled = false;
    detectCapabilities()
      .then((c) => {
        if (cancelled) return;
        setCaps(c);
        setPresetId(c.presets[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(`Could not check what this device can encode: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!firebaseConfigured) {
      setUser(null);
      return;
    }
    return watchUser(setUser);
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const preset: ExportPreset | undefined = caps?.presets.find((p) => p.id === presetId);

  const handleFile = useCallback(async (next: File) => {
    setError(null);
    setResult(null);
    setSaveNote(null);
    setInfo(null);
    setFile(next);
    setInspecting(true);
    try {
      const details = await inspectClip(next);
      setInfo(details);
      const duration = Number.isFinite(details.duration) ? details.duration : 0;
      setStart(0);
      // Trim to ten seconds first: the export path has to be proven on a short
      // range before anyone waits two minutes to find out it does not work.
      setEnd(Math.min(10, duration));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspecting(false);
    }
  }, []);

  const onPick = useCallback(
    (files: FileList | null) => {
      const picked = files?.[0];
      if (picked) void handleFile(picked);
    },
    [handleFile]
  );

  const selectedSeconds = Math.max(0, end - start);

  const onExport = useCallback(async () => {
    if (!file || !preset || !info) return;
    if (!info.decodable) {
      setError("This device cannot decode this file, so it cannot be exported here.");
      return;
    }
    setError(null);
    setResult(null);
    setExporting(true);
    setProgress(0);
    conversionRef.current = null;

    try {
      const out = await exportClip(
        file,
        {
          start,
          end,
          height: preset.height,
          container: preset.container,
          videoCodec: preset.videoCodec,
          audioCodec: preset.audioCodec,
        },
        {
          onProgress: setProgress,
          onConversion: (c) => {
            conversionRef.current = c;
          },
        }
      );
      setResult(out);
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `apex-trim-${Date.now()}.${out.extension}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "ConversionCanceledError") {
        setError(null);
        setProgress(0);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setExporting(false);
      conversionRef.current = null;
    }
  }, [file, preset, info, start, end]);

  const onCancel = useCallback(async () => {
    const conversion = conversionRef.current;
    if (!conversion) return;
    try {
      await conversion.cancel();
    } catch {
      // cancel() resolves once resources are freed; a rejection here means it
      // already finished, which is not worth reporting.
    }
  }, []);

  const onSave = useCallback(async () => {
    if (!user) return;
    setSaveNote(null);
    setError(null);
    const project: ProjectDoc = {
      id: `apex-${user.uid.slice(0, 8)}-default`,
      title: file ? file.name.replace(/\.[^.]+$/, "") : "Untitled project",
      aspect: "16:9",
      clips: file && info ? [{ id: "clip-1", name: file.name, in: start, out: end }] : [],
      version: 1,
    };
    try {
      await saveProject(project, user.uid);
      setSaveNote(`Saved to Firestore as projects/${project.id} (${projectSize(project)} bytes).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [user, file, info, start, end]);

  const onAuth = useCallback(async () => {
    setAuthBusy(true);
    setError(null);
    try {
      if (user) await signOut();
      else await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  }, [user]);

  const canExport = Boolean(file && info?.decodable && preset && selectedSeconds >= MIN_GAP && !exporting);

  return (
    <>
      <header className="top">
        <div className="brand">
          Apex <span>Editor</span>
        </div>
        <span className="badge">milestone 1 · export path</span>
        <div className="spacer" />
        {caps && (
          <>
            <span className={`badge ${caps.webCodecs ? "good" : "bad"}`}>
              <span className="dot" />
              {caps.webCodecs ? "WebCodecs ready" : "No WebCodecs"}
            </span>
            <span className="badge">
              AAC: {caps.aacPolyfilled ? "bundled encoder" : "native"}
            </span>
          </>
        )}
        {firebaseConfigured ? (
          <button onClick={onAuth} disabled={authBusy}>
            {user ? `Sign out ${user.email ?? ""}` : "Sign in"}
          </button>
        ) : (
          <span className="badge">local mode · no save</span>
        )}
      </header>

      <main>
        <section className="card">
          <h2>1 · Import a clip</h2>
          <p className="hint">
            Stays on this device. Nothing is uploaded to import or export a clip.
          </p>

          <div
            className="drop"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onPick(e.dataTransfer.files);
            }}
          >
            {file ? `${file.name} — click to choose another` : "Tap to choose a video, or drop one here"}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              onChange={(e) => onPick(e.target.files)}
            />
          </div>

          {inspecting && <div className="out">Reading the file…</div>}

          {info && (
            <dl className="meta" style={{ marginTop: 14 }}>
              <dt>Duration</dt>
              <dd>{formatTime(info.duration)}</dd>
              <dt>Resolution</dt>
              <dd>
                {info.width && info.height ? `${info.width} × ${info.height}` : "—"}
                {info.rotation ? ` (rotated ${info.rotation}°)` : ""}
              </dd>
              <dt>Frame rate</dt>
              <dd>{info.fps ? `${info.fps.toFixed(2)} fps` : "—"}</dd>
              <dt>Video codec</dt>
              <dd>
                {info.videoCodec ?? "—"} <code>{info.videoCodecString ?? "unknown"}</code>
              </dd>
              <dt>Audio codec</dt>
              <dd>
                {info.audioCodec ? (
                  <>
                    {info.audioCodec} <code>{info.audioCodecString ?? "unknown"}</code> ·{" "}
                    {info.channels ?? "?"} ch · {info.sampleRate ?? "?"} Hz
                  </>
                ) : (
                  "no audio track"
                )}
              </dd>
              <dt>File size</dt>
              <dd>{formatBytes(info.bytes)}</dd>
              <dt>This device can decode it</dt>
              <dd style={{ color: info.decodable ? "var(--accent)" : "var(--danger)" }}>
                {info.decodable ? "yes" : "no"}
              </dd>
            </dl>
          )}

          {info?.decodeProblem && (
            <div className="error" style={{ marginTop: 12 }}>
              {info.decodeProblem}
            </div>
          )}

          {previewUrl && info?.decodable && (
            <video src={previewUrl} controls playsInline style={{ marginTop: 14 }} />
          )}
        </section>

        <section className="card">
          <h2>2 · Trim to ten seconds</h2>
          <p className="hint">
            The fast path is a copy, not a re-encode — a 10-second cut should take about a
            second. It only becomes a re-encode when the resolution changes.
          </p>

          <label htmlFor="trim-start">Start — {formatTime(start)}</label>
          <input
            id="trim-start"
            type="range"
            min={0}
            max={Math.max(0, (info?.duration ?? 0) - MIN_GAP)}
            step={0.05}
            value={start}
            disabled={!info}
            onChange={(e) => {
              const next = Number(e.target.value);
              setStart(Math.min(next, Math.max(0, end - MIN_GAP)));
            }}
          />

          <label htmlFor="trim-end">End — {formatTime(end)}</label>
          <input
            id="trim-end"
            type="range"
            min={MIN_GAP}
            max={info?.duration ?? 0}
            step={0.05}
            value={end}
            disabled={!info}
            onChange={(e) => {
              const next = Number(e.target.value);
              setEnd(Math.max(next, start + MIN_GAP));
            }}
          />

          <div className="row" style={{ marginTop: 12 }}>
            <button
              disabled={!info}
              onClick={() => setStart(Math.max(0, end - 10))}
              title="Keep the ten seconds that end where the current end is"
            >
              Last 10s
            </button>
            <button
              disabled={!info}
              onClick={() => {
                setStart(0);
                setEnd(Math.min(10, info?.duration ?? 0));
              }}
            >
              First 10s
            </button>
            <span className="tiny">
              Selection: {formatTime(selectedSeconds)} of {formatTime(info?.duration ?? 0)}
            </span>
          </div>
        </section>

        <section className="card">
          <h2>3 · Export</h2>
          <p className="hint">
            Only presets this device can actually encode are listed. If MP4 is missing, this
            browser has no H.264 encoder.
          </p>

          {!caps && <div className="out">Checking encoders…</div>}

          {caps && caps.presets.length === 0 && (
            <div className="error">
              No usable encoder was found. This usually means WebCodecs is unavailable or the
              browser is a build without hardware encoding. Chrome, Edge or Safari on a recent
              device will work.
            </div>
          )}

          {caps && caps.presets.length > 0 && (
            <>
              <label htmlFor="preset">Format</label>
              <select id="preset" value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                {caps.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>

              <div className="row" style={{ marginTop: 14 }}>
                <button className="primary" onClick={onExport} disabled={!canExport}>
                  {exporting ? "Exporting…" : "Export and download"}
                </button>
                {exporting && <button onClick={onCancel}>Cancel</button>}
              </div>
            </>
          )}

          {exporting && (
            <>
              <div className="bar">
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="out">{Math.round(progress * 100)}%</div>
            </>
          )}

          {result && (
            <div className="ok" style={{ marginTop: 14 }}>
              Exported {formatBytes(result.blob.size)} of {result.mimeType} in{" "}
              {(result.ms / 1000).toFixed(1)}s. Saved to your downloads.
              {result.caveat ? ` ${result.caveat}` : ""}
            </div>
          )}

          {error && (
            <div className="error" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}
        </section>

        <section className="card span-2">
          <h2>This device</h2>
          <p className="hint">
            Probed with <code>VideoEncoder.isConfigSupported()</code>. Hardware is reported only
            when the browser accepts a <code>prefer-hardware</code> configuration, which is a
            hint rather than a guarantee — the browser still decides per frame.
          </p>

          {caps ? (
            <>
              <div className="row">
                {caps.raw.map((probe) => (
                  <span key={probe.codec} className={`badge ${probe.supported ? "good" : "bad"}`}>
                    {probe.codec} · {probe.supported ? (probe.hardwarePath ? "hardware path" : "software only") : "unsupported"}
                  </span>
                ))}
              </div>
              {caps.notes.length > 0 && (
                <ul className="tiny" style={{ marginTop: 12, paddingLeft: 18 }}>
                  {caps.notes.map((note) => (
                    <li key={note} style={{ marginBottom: 4 }}>
                      {note}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="out">Probing…</div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button onClick={onSave} disabled={!user || !file}>
              Save project to Firestore
            </button>
            <span className="tiny">
              {firebaseConfigured
                ? user
                  ? `Signed in as ${user.email ?? user.uid}. A document is timeline JSON only — media stays local.`
                  : "Sign in to save the project. Import and export work without it."
                : "Firebase is not configured, so saving is off. Fill in .env.local to enable it."}
            </span>
          </div>

          {saveNote && (
            <div className="ok" style={{ marginTop: 12 }}>
              {saveNote}
            </div>
          )}
        </section>
      </main>
    </>
  );
}
