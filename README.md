# Apex Editor

A browser-based, multi-track video editing suite for the Apex ecosystem (CapCut-inspired). The app now includes a dashboard, a professional editor workspace with multi-track timeline, AI/integration-ready creator tools, and an upgraded WebCodecs export pipeline.

```bash
npm install
cp .env.example .env.local     # optional; runs in local mode without Firebase/AI config
npm run dev                    # http://localhost:5175
npm run build                  # tsc --noEmit + vite build
npm run typecheck              # tsc --noEmit
```

## Core features

### Multi-track timeline & workspace
- **Dashboard / home screen:** New Project, aspect templates (16:9, 9:16, 1:1), quick-tool shortcuts, and local project history with thumbnails/metadata.
- **Multi-track timeline:** video, audio, and text/overlay tracks with layer ordering, track visibility/mute, drag-to-arrange clips, edge trimming, playhead seeking, split at playhead, and clip deletion.
- **Editor layout:** top bar (project settings, undo/redo, save/export), left panel (Media, AI Tools, Text), center preview + transport, right inspector, bottom timeline.
- **Project state:** normalized multi-track project model (`assets`, `tracks`, `clips`, transforms/effects), local auto-save/history, and undo/redo command history.

### Creator & AI tools (UI and integration-ready)
- **Auto-Captions / Subtitles:** generates caption clips on the text track. Attempts transcription via Apex AI Router (`POST /v1/audio/transcriptions`, Whisper-compatible hook) when configured; surfaces integration guidance and placeholders when unavailable.
- **Background Removal:** per-clip chroma key (color, tolerance, softness) applied in preview/composite rendering, plus an **AI subject cutout** toggle as an integration hook for segmentation backends.
- **AI Generator & AutoCut:** prompt workflows wired to Apex AI Router `POST /v1/chat/completions` and narration/audio generation via `POST /v1/tts` (added to assets/timeline). AutoCut runs client-side DSP analysis (silence detection and transient/beat markers) with optional AI planning via the router.
- **Retouch & Adjustments:** brightness, contrast, saturation, transform (position/scale/rotation/opacity), and speed control from **0.1x to 100x** (speed-curve data model supported/integration-ready).

### Export engine
- **Fast path (remux/stream copy):** single unmodified clip timelines that match target settings use mediabunny's copy-preferred conversion path to avoid unnecessary re-encoding.
- **Composited/transcode path:** multi-track timelines, overlays/text, effects, transforms, chroma key, and speed/timing changes are rendered and encoded; WebCodecs hardware acceleration is preferred (`prefer-hardware`) when supported.
- **Presets:** device-probed MP4 (H.264 + AAC) and WebM (VP9 + Opus) presets including **720p / 1080p / 4K at 30/60fps** with bitrate options, real-time progress, cancel, and direct download.
- **Capability-first behavior:** unsupported codecs/presets are hidden with explanatory notes instead of failing at export time.

## Architecture

- `src/types/editor.ts` — project/timeline data model (projects, tracks, clips, assets, effects).
- `src/store/editorStore.tsx` — editor state, mutations, undo/redo history.
- `src/components/` — `Dashboard`, `EditorScreen`, `LeftPanel`, `Preview`, `Inspector`, `Timeline`, `ExportDialog`.
- `src/lib/capabilities.ts` — WebCodecs/encoder probing, AAC polyfill registration, preset generation.
- `src/lib/mediaPipeline.ts` — media inspection, fast-path export, composition rendering/export.
- `src/lib/mediaAnalysis.ts` — client-side silence/transient DSP helpers for AutoCut.
- `src/lib/aiRouter.ts` — Apex AI Router hooks (`/v1/chat/completions`, `/v1/tts`, transcription endpoint).
- `src/lib/firestore.ts` — optional Firebase Auth + Firestore project persistence (timeline JSON; media stays local).
- `src/lib/project.ts` — project creation, local history storage, timeline helpers.

## Environment & integrations

- `VITE_FIREBASE_*`: optional cloud save/auth (`.env.example`). Without config the app runs in local mode.
- `VITE_APEX_AI_ROUTER_URL`: base URL for AI hooks (`/v1/chat/completions`, `/v1/tts`, `/v1/audio/transcriptions`).
- `VITE_APEX_DRIVE_URL`: reserved for presigned media/bin integration.

## Notes

- Timeline preview and composition export share a canvas frame renderer for consistency; browser seek precision and multi-source audio mixing in composite exports may vary by device.
- AI features are integration-ready and require configured backend routes/credentials in the Worker/router (no secrets in the frontend).
- Firestore schema/rules in-repo remain compatibility-oriented; v2 multi-track payloads are stored when within document limits.
- The bundle is currently a single chunk because Firebase is statically imported; code-splitting is a follow-up optimization.

## The one hard rule

No secrets in the frontend. Every `VITE_` variable is compiled into the bundle. Backblaze keys and AI tokens live in the Worker as secrets, never here.
