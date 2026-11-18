import { useCallback, useRef, useState } from "react";
import { useEditor } from "../store/editorStore";
import { inspectClip } from "../lib/mediaPipeline";
import { aiConfigured, chatCompletions, textToSpeech, transcribeAudioPlaceholder } from "../lib/aiRouter";
import { decodeAudioBuffer, detectSilence, detectTransients } from "../lib/mediaAnalysis";
import type { Asset, Clip } from "../types/editor";
import { uid } from "../utils/id";
import { formatTime } from "../utils/format";

interface Props {
  tab: "media" | "ai" | "text";
  onTab: (tab: "media" | "ai" | "text") => void;
  onError: (msg: string | null) => void;
}

export function LeftPanel({ tab, onTab, onError }: Props) {
  const { project, dispatch } = useEditor();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [ttsText, setTtsText] = useState("");
  const [captionText, setCaptionText] = useState("New caption");
  const [whisperStatus, setWhisperStatus] = useState<string | null>(null);

  const importFiles = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    onError(null);
    setBusy("Importing media…");
    try {
      for (const file of Array.from(files)) {
        const info = await inspectClip(file);
        const type: Asset["type"] = file.type.startsWith("audio/") || (!info.width && info.hasAudio)
          ? "audio" : file.type.startsWith("image/") ? "image" : "video";
        const asset: Asset = {
          id: uid("asset"),
          type,
          name: file.name,
          src: URL.createObjectURL(file),
          file,
          duration: type === "image" ? 5 : info.duration || 0,
          width: info.width ?? undefined,
          height: info.height ?? undefined,
          fps: info.fps ?? null,
          hasAudio: info.hasAudio,
          videoCodec: info.videoCodec,
          audioCodec: info.audioCodec,
          createdAt: Date.now(),
        };
        dispatch({ type: "ADD_ASSET", asset });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [dispatch, onError]);

  const addToTimeline = useCallback((assetId: string) => {
    dispatch({ type: "ADD_ASSET_TO_TIMELINE", assetId });
  }, [dispatch]);

  const addTextClip = useCallback(() => {
    const track = project.tracks.find((t) => t.type === "text") || project.tracks[0];
    if (!track) return;
    const start = track.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    const clip: Clip = {
      id: uid("clip"), trackId: track.id, type: "text", name: "Text", start, duration: 3, trimIn: 0, trimOut: 3,
      speed: 1, volume: 1, muted: false,
      transform: { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
      adjustments: { brightness: 0, contrast: 0, saturation: 0 },
      text: captionText || "New text", textStyle: { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 56, fontWeight: 700, color: "#ffffff", background: "transparent", outlineColor: "rgba(0,0,0,0.85)", outlineWidth: 6, align: "center" },
    };
    dispatch({ type: "ADD_CLIP", trackId: track.id, clip });
  }, [dispatch, project.tracks, captionText]);

  const runAutoCaptions = useCallback(async () => {
    onError(null);
    const audioAsset = project.assets.find((a) => a.type === "audio" || (a.type === "video" && a.hasAudio));
    if (!audioAsset?.file) { onError("Import a video/audio file with audio to generate captions."); return; }
    setBusy("Generating captions…");
    setWhisperStatus(null);
    try {
      let segments: { start: number; end: number; text: string }[] = [];
      try {
        segments = await transcribeAudioPlaceholder(audioAsset.file);
        setWhisperStatus("Captions generated via AI router transcription endpoint.");
      } catch (e) {
        // Fallback: Web Speech API is live/mic-oriented and unreliable for file transcription;
        // provide an integration-ready placeholder result and explain.
        setWhisperStatus((e instanceof Error ? e.message : String(e)) + " Web Speech API file transcription is not available in-browser; add a Worker AI Whisper route at /v1/audio/transcriptions for server captions.");
        segments = [{ start: 0, end: Math.min(audioAsset.duration || 5, 5), text: "[Caption placeholder — connect Whisper route]" }];
      }
      let textTrack = project.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        dispatch({ type: "ADD_TRACK", trackType: "text" });
      }
      // Re-find after possible add (state update async in React, so create inline target id strategy)
      textTrack = project.tracks.find((t) => t.type === "text");
      const trackId = textTrack?.id || project.tracks[0]?.id;
      if (!trackId) return;
      for (const seg of segments) {
        const duration = seg.end > seg.start ? seg.end - seg.start : Math.max(1.5, (seg.text.length / 12));
        const clip: Clip = {
          id: uid("cap"), trackId, type: "caption", name: "Caption", start: Math.max(0, seg.start), duration,
          trimIn: 0, trimOut: duration, speed: 1, volume: 1, muted: false,
          transform: { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
          adjustments: { brightness: 0, contrast: 0, saturation: 0 },
          text: seg.text, textStyle: { fontFamily: "ui-sans-serif, system-ui, sans-serif", fontSize: 42, fontWeight: 700, color: "#fff", background: "rgba(0,0,0,0.45)", outlineColor: "rgba(0,0,0,0.9)", outlineWidth: 4, align: "center" },
        };
        dispatch({ type: "ADD_CLIP", trackId, clip });
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [dispatch, onError, project.assets, project.tracks]);

  const runAutoCut = useCallback(async () => {
    onError(null);
    const audioAsset = project.assets.find((a) => a.file && (a.type === "audio" || (a.type === "video" && a.hasAudio)));
    if (!audioAsset?.file) { onError("Import a video/audio file to run AutoCut analysis."); return; }
    setBusy("Analyzing audio for AutoCut…");
    try {
      const buffer = await decodeAudioBuffer(audioAsset.file);
      if (!buffer) throw new Error("Could not decode audio for analysis in this browser.");
      const silences = detectSilence(buffer, { thresholdDb: -38, minDuration: 0.4 });
      const beats = detectTransients(buffer, 1.35);
      const summary = `AutoCut analysis: ${silences.length} silent ranges and ${beats.length} transient markers detected.`;
      setWhisperStatus(summary + " Apply cuts by splitting at markers in the timeline (select clip, move playhead, press S).");
      if (aiConfigured()) {
        const plan = await chatCompletions([
          { role: "system", content: "You are an editing assistant. Given detected silence ranges and beat markers, propose a concise highlight-reel cut plan. Return short actionable steps." },
          { role: "user", content: `Duration ${buffer.duration.toFixed(2)}s. Silences: ${JSON.stringify(silences.slice(0, 20))}. Beats: ${JSON.stringify(beats.slice(0, 30))}.` },
        ]).catch(() => null);
        if (plan) setWhisperStatus(summary + "\nAI plan: " + plan);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(null); }
  }, [onError, project.assets]);

  const runAiGenerate = useCallback(async () => {
    onError(null);
    if (!aiConfigured()) { onError("Set VITE_APEX_AI_ROUTER_URL to enable AI generation hooks."); return; }
    if (!aiPrompt.trim()) { onError("Enter a prompt for AI generation."); return; }
    setBusy("Calling AI router…");
    try {
      const result = await chatCompletions([
        { role: "system", content: "You generate structured video/audio edit plans and creative directions for a browser video editor. Be concise and actionable." },
        { role: "user", content: aiPrompt },
      ]);
      setWhisperStatus("AI response:\n" + result);
    } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }, [aiPrompt, onError]);

  const runTts = useCallback(async () => {
    onError(null);
    if (!aiConfigured()) { onError("Set VITE_APEX_AI_ROUTER_URL to enable TTS hook."); return; }
    if (!ttsText.trim()) { onError("Enter text for TTS."); return; }
    setBusy("Generating speech via /v1/tts…");
    try {
      const blob = await textToSpeech(ttsText);
      const file = new File([blob], `tts-${Date.now()}.mp3`, { type: blob.type || "audio/mpeg" });
      const url = URL.createObjectURL(file);
      const audioEl = document.createElement("audio");
      audioEl.src = url;
      await new Promise<void>((resolve, reject) => {
        audioEl.onloadedmetadata = () => resolve();
        audioEl.onerror = () => reject(new Error("Could not load generated audio."));
      }).catch(() => undefined);
      const asset: Asset = { id: uid("asset"), type: "audio", name: file.name, src: url, file, duration: audioEl.duration || 5, hasAudio: true, createdAt: Date.now() };
      dispatch({ type: "ADD_ASSET", asset });
      dispatch({ type: "ADD_ASSET_TO_TIMELINE", assetId: asset.id, trackType: "audio" });
      setWhisperStatus("TTS audio generated and added to timeline.");
    } catch (err) { onError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(null); }
  }, [dispatch, onError, ttsText]);

  return (
    <aside className="left-panel">
      <div className="panel-tabs">
        <button className={tab === "media" ? "active" : ""} onClick={() => onTab("media")}>Media</button>
        <button className={tab === "ai" ? "active" : ""} onClick={() => onTab("ai")}>AI Tools</button>
        <button className={tab === "text" ? "active" : ""} onClick={() => onTab("text")}>Text</button>
      </div>

      {busy && <div className="panel-note">{busy}</div>}

      {tab === "media" && (
        <div className="panel-body">
          <div className="drop small" onClick={() => fileRef.current?.click()}>
            + Import media (video, audio, image)
            <input ref={fileRef} type="file" multiple accept="video/*,audio/*,image/*,.mp4,.mov,.webm,.mp3,.wav,.m4a,.png,.jpg,.jpeg,.gif,.webp" onChange={(e) => importFiles(e.target.files)} />
          </div>
          <div className="asset-list">
            {project.assets.length === 0 && <p className="hint">No media yet. Import files to start editing.</p>}
            {project.assets.map((a) => (
              <div key={a.id} className="asset-item">
                <div className="asset-meta">
                  <strong>{a.name}</strong>
                  <span>{a.type} · {formatTime(a.duration)}{a.width && a.height ? ` · ${a.width}×${a.height}` : ""}</span>
                </div>
                <div className="row">
                  <button onClick={() => addToTimeline(a.id)}>Add to timeline</button>
                  <button className="ghost" onClick={() => dispatch({ type: "REMOVE_ASSET", assetId: a.id })}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "ai" && (
        <div className="panel-body ai-tools">
          <section className="tool-card">
            <h3>Auto-Captions / Subtitles</h3>
            <p className="tiny">Generates synced subtitle clips via router Whisper endpoint (/v1/audio/transcriptions) when configured; integration-ready fallback otherwise.</p>
            <button onClick={runAutoCaptions} disabled={!!busy}>Generate captions from media</button>
          </section>
          <section className="tool-card">
            <h3>Background Removal</h3>
            <p className="tiny">Select a video clip and use Inspector → Chroma Key (color/tolerance) for green screen. "AI Cutout" toggle is integration-ready for subject segmentation backends.</p>
          </section>
          <section className="tool-card">
            <h3>AI Generator & AutoCut</h3>
            <p className="tiny">Wired to Apex AI Router: /v1/chat/completions for plans and /v1/tts for generated audio. AutoCut runs client-side silence/transient analysis plus optional AI planning.</p>
            <label>Prompt / generation request</label>
            <textarea rows={3} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="Describe the highlight reel, script, or edit plan…" />
            <div className="row">
              <button onClick={runAiGenerate} disabled={!!busy}>Generate plan</button>
              <button onClick={runAutoCut} disabled={!!busy}>Run AutoCut analysis</button>
            </div>
            <label>TTS text (/v1/tts)</label>
            <textarea rows={2} value={ttsText} onChange={(e) => setTtsText(e.target.value)} placeholder="Text to synthesize as narration…" />
            <button onClick={runTts} disabled={!!busy}>Generate & add narration</button>
          </section>
          <section className="tool-card">
            <h3>Router status</h3>
            <p className="tiny">{aiConfigured() ? "Apex AI Router URL configured." : "VITE_APEX_AI_ROUTER_URL not set — AI hooks will show integration guidance until configured."}</p>
          </section>
          {whisperStatus && <pre className="ai-output">{whisperStatus}</pre>}
        </div>
      )}

      {tab === "text" && (
        <div className="panel-body">
          <section className="tool-card">
            <h3>Text & Captions</h3>
            <label>Caption/text content</label>
            <textarea rows={3} value={captionText} onChange={(e) => setCaptionText(e.target.value)} />
            <button className="primary" onClick={addTextClip}>Add to Text Track</button>
            <p className="tiny">Adds a text/caption clip to the timeline. Select it in the timeline to edit style, timing, and transform in the Inspector.</p>
          </section>
          <section className="tool-card">
            <h3>Templates</h3>
            <div className="quick-tools compact">
              <button onClick={() => { setCaptionText("TITLE"); addTextClip(); }}>Title</button>
              <button onClick={() => { setCaptionText("Subtitle goes here"); addTextClip(); }}>Subtitle</button>
              <button onClick={() => { setCaptionText("Call to action"); addTextClip(); }}>CTA</button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
