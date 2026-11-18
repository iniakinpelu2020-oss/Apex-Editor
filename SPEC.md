# Apex Editor — specification

A browser-based multi-track video editor for the Apex suite. Single owner, zero server render
cost, integrated with the rest of the ecosystem.

Anything marked **[note]** has a correction or a hard dependency in `NOTES.md`. Read those
before implementing.

## 1. Stack

| Piece | Choice |
| --- | --- |
| Frontend | React + TypeScript + Tailwind, static SPA |
| Hosting | Cloudflare Pages |
| Auth | Firebase Auth, single owner account |
| Timeline storage | Supabase table `apex_editor_projects` (RLS to owner) |
| Media storage | Backblaze B2 through the existing Apex Drive Worker's presigned URLs |
| AI | Apex AI Router Worker (Cloudflare Workers AI underneath) |
| Export | WebCodecs + `mediabunny` |

**[note]** `VITE_OWNER_UID` is a convenience check, not security. RLS and Worker token checks
are the boundary. Supabase's free tier pauses after about a week of inactivity — see
`NOTES.md` §3 before committing to it.

## 2. The video engine — all client-side

### Timeline model

Normalised JSON: clips reference assets by id, and order lives in the track arrays rather than
in the clips themselves. One store (Zustand preferred) with an explicit command stack.

- Undo / redo: every mutation is a command with an inverse. `Ctrl+Z`, `Ctrl+Shift+Z`.
- Tracks: main video, overlay/PIP, captions/text, audio/SFX.
- Tools: zoomable ruler, magnetic snapping, playhead scrub, split/blade (`B`), ripple delete,
  trim handles, per-clip speed from 0.2× to 5.0× with presets.

### Preview

- One `<canvas>` (2D is enough; WebGL2 only if transitions demand it) composited by a
  `requestAnimationFrame` clock, with the Web Audio API for the mixer.
- The frame at time `t` is a **pure function of `t`** and of the timeline. The exporter calls
  the same function. This is the single most important design rule in the app: if preview and
  export render differently, every timing bug becomes unfindable.
- Aspect presets 16:9, 9:16, 1:1. Transform: scale, x/y, rotation, opacity.
- Colour: brightness, contrast, saturation.
- Transitions: fade, cross-dissolve, slide, zoom punch.
- Keyframes with linear and ease-in-out interpolation.

### Export

`mediabunny` plus the native `VideoEncoder` / `AudioEncoder`. MP4 (H.264 + AAC) and WebM
(VP9 + Opus). Progress bar, resolution picker (720p, 1080p, 4K), frame rate picker (30, 60).

**[note]** Native AAC encoding is missing in Firefox everywhere and in every desktop Linux
browser, and H.264 encoding is missing in many desktop Linux builds. Install
`@mediabunny/aac-encoder` and gate every option behind a capability probe. **[note]** 4K on a
phone usually fails or throttles; 1080p is the default.

## 3. AI features

### 3.1 Auto-captions

Resample the selected audio to 16 kHz mono in the browser, send it to the router's
transcription route, and turn the returned timings into editable caption blocks on the
captions track, with presets: pop-in bounce, active-word colour highlight, bold outline.

**[note]** Chunk long audio, keep word-level timings, and cache the transcript.

### 3.2 Timeline copilot

A sidebar chat (`<ApexEditorCopilot />`). Commands like *"cut all silent pauses"*, *"add a
1.15× zoom punch on every beat drop"*, *"resize to 9:16"*.

The request carries a serialised timeline summary — clip ids, durations, track layout, and the
peak data already computed by the DSP pass. The response is a JSON patch list from a closed
set: `splitClip`, `deleteRange`, `addKeyframe`, `setSpeed`, `addText`.

**[note]** Validate the patch, show its effect in words, require a click, and apply the batch
as one undo entry. Never auto-apply.

### 3.3 Silence and beat detection

PCM analysis with Web Audio `AudioBuffer`: silent gaps for one-click dead-air removal, and
transient bass peaks for montage markers.

**[note]** This is DSP, not a model. It is exact, instant, free and offline. The model never
sees raw audio for this; it receives the resulting ranges.

## 4. Layout

Dark NLE workspace, background `#0B0D12`.

- **Top bar:** project title, aspect and resolution switcher, undo/redo, save, Export.
- **Left:** media bin (local upload, pull from Apex Cloud, pull from Apex Studio), text and
  caption presets, transitions, AI copilot tab.
- **Centre:** canvas viewport with a transform gizmo, transport controls.
- **Right:** inspector — transform, keyframes, speed, audio gain and fades, caption styling.
- **Bottom:** multi-track timeline with waveforms, beat markers, tool strip.

## 5. Security rules

- No secrets in the frontend. All configuration in `.env.example`; the filled `.env.local`
  stays out of git.
- Every `VITE_` variable is public. Backblaze keys, the Supabase service key and AI tokens
  live in the Worker as secrets.
- The migration in `supabase/migrations/` enforces `auth.uid() = user_id` on every operation.
- B2 presigned URLs are short-lived, single-object, single-method.

## 6. Delivery plan

`NOTES.md` §9 splits this into three versions and §10 gives the build order. The short
version: build the export path first, on a real phone, before writing a single pixel of
timeline UI.
