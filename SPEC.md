# Apex Editor — specification

A browser-based multi-track video editor for the Apex suite. Single owner, zero server render
cost, integrated with the rest of the ecosystem.

Anything marked **[note]** has a correction or a hard dependency in `NOTES.md`. Read those
before implementing.

**Current state:** milestone 1 (the export path) is built and verified. See `README.md`.
The rest of this document is the target, not the current code.

## 1. Stack

| Piece | Choice |
| --- | --- |
| Frontend | React + TypeScript + Vite, static SPA |
| Styling | plain CSS for milestone 1 (Tailwind planned with the timeline UI) |
| Hosting | Cloudflare Pages |
| Auth | Firebase Auth, single owner account |
| Timeline storage | Cloud Firestore, `projects/{projectId}` |
| Media storage | Backblaze B2 through the Apex AI Router's presigned URLs |
| AI | Apex AI Router Worker (Cloudflare Workers AI underneath) |
| Export | `mediabunny` + `@mediabunny/aac-encoder` over WebCodecs |

**[note]** Supabase was removed: its free tier pauses a project after about a week of
inactivity, which is exactly what a personal editor looks like. Firestore does not pause, and
Firebase Auth was already the sign-in gate, so this choice removes a vendor rather than adding
one.

**[note]** `VITE_OWNER_UID` no longer exists. It was a convenience check, not a security
control. Ownership is enforced by `firestore.rules` and by the Worker's Firebase ID token
check.

## 2. The video engine — all client-side

### Capability-first export

Nothing about formats is hardcoded. At startup the app probes what this device can do:

- `canEncodeAudio("aac")`, falling back to the bundled AAC encoder when the browser has none.
- `VideoEncoder.isConfigSupported()` with the exact codec strings `avc1.4d002a` (720p30) and
  `avc1.4d0034` (1080p30), plus `vp09.00.10.08` for the WebM fallback.
- `Conversion.init(...).isValid` and `discardedTracks` — the encoder's own reasons, shown to the
  user, rather than a generic failure.

On import, the file's track is checked with `track.canDecode()` and
`VideoDecoder.isConfigSupported(config)` using the codec string extracted from the file. A file
this device cannot decode says **"Unsupported codec on this device"** instead of spinning.

Presets the device cannot produce are not offered at all.

### A preset is a promise about the codec

Choosing "MP4 · H.264" means the output contains H.264 — not merely an MP4 container. If the
source is VP9, the export re-encodes. Without that, mediabunny copies the VP9 track into the
MP4, the export looks instant and successful, and the label is a lie. See `NOTES.md` §2.

### Timeline model (milestone 2)

Normalised JSON: clips reference assets by id, and order lives in the track arrays rather than
in the clips themselves. One store (Zustand preferred) with an explicit command stack.

- Undo / redo: every mutation is a command with an inverse. `Ctrl+Z`, `Ctrl+Shift+Z`.
- Tracks: main video, overlay/PIP, captions/text, audio/SFX.
- Tools: zoomable ruler, magnetic snapping, playhead scrub, split/blade (`B`), ripple delete,
  trim handles, per-clip speed from 0.2× to 5.0× with presets.

### Preview

- One `<canvas>` composited by a `requestAnimationFrame` clock, with the Web Audio API for the
  mixer.
- The frame at time `t` is a **pure function of `t`** and of the timeline. The exporter calls the
  same function. If preview and export render differently, every timing bug becomes unfindable.
- Aspect presets 16:9, 9:16, 1:1. Transform: scale, x/y, rotation, opacity.
- Colour: brightness, contrast, saturation.
- Transitions: fade, cross-dissolve, slide, zoom punch.
- Keyframes with linear and ease-in-out interpolation.

### Export

MP4 (H.264 + AAC) and WebM (VP9 + Opus). Progress bar, cancel, resolution picker (720p, 1080p;
4K only when the device and source both justify it), frame rate picker (30, 60).

**[note]** 4K on a phone usually fails or throttles. 1080p is the default.

## 3. AI features

### 3.1 Auto-captions

Resample the selected audio to 16 kHz mono in the browser, send it to the router's transcription
route, and turn the returned timings into editable caption blocks, with presets: pop-in bounce,
active-word colour highlight, bold outline.

**[note]** Chunk long audio, keep word-level timings, and cache the transcript.

### 3.2 Timeline copilot

A sidebar chat. Commands like *"cut all silent pauses"*, *"add a 1.15× zoom punch on every beat
drop"*, *"resize to 9:16"*.

The request carries a serialised timeline summary — clip ids, durations, track layout and peak
data from the DSP pass. The response is a JSON patch list from a closed set: `splitClip`,
`deleteRange`, `addKeyframe`, `setSpeed`, `addText`.

**[note]** Validate the patch, show its effect in words, require a click, and apply the batch as
one undo entry. Never auto-apply.

### 3.3 Silence and beat detection

PCM analysis with Web Audio `AudioBuffer`: silent gaps for one-click dead-air removal, and
transient bass peaks for montage markers.

**[note]** This is DSP, not a model. It is exact, instant, free and offline.

## 4. Layout

Dark NLE workspace, background `#0B0D12`.

- **Top bar:** project title, aspect and resolution switcher, undo/redo, save, Export.
- **Left:** media bin (local upload, pull from Apex Cloud, pull from Apex Studio), text and
  caption presets, transitions, AI copilot tab.
- **Centre:** canvas viewport with a transform gizmo, transport controls.
- **Right:** inspector — transform, keyframes, speed, audio gain and fades, caption styling.
- **Bottom:** multi-track timeline with waveforms, beat markers, tool strip.

## 5. Security rules

- No secrets in the frontend. All configuration in `.env.example`; the filled `.env.local` stays
  out of git.
- Every `VITE_` variable is public. Backblaze keys, the service credentials and AI tokens live in
  the Worker as secrets.
- `firestore.rules` enforces `request.auth.uid == resource.data.userId` on every read and write,
  requires the same on create, and refuses ownership changes.
- B2 presigned URLs are short-lived, single-object, single-method, and forced under `u/<uid>/`.

## 6. Delivery plan

`NOTES.md` §10 gives the build order. The short version: the export path first, on a real phone,
before a single pixel of timeline UI. That milestone is built; `NOTES.md` §11 lists exactly what
it does and does not do.
