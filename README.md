# Apex Editor

A browser-based video editor for the Apex suite. Milestone 1 — **the export path** — is built:
import a clip, trim it to ten seconds, export a real MP4.

```bash
npm install
cp .env.example .env.local     # optional; the app runs in local mode without it
npm run dev                    # http://localhost:5175
npm run build                  # tsc --noEmit + vite build
```

## What works today

- **Import** `.mp4` / `.mov` / `.webm` and see real metadata: duration, resolution, rotation,
  frame rate, video and audio codec strings, channels, sample rate.
- **Codec check on import.** The file's own track is probed with `canDecode()` and
  `VideoDecoder.isConfigSupported()`. An unsupported codec says so plainly instead of hanging.
- **Trim** with start/end sliders and first-10s / last-10s shortcuts.
- **Export** to MP4 (H.264 + AAC) or WebM (VP9 + Opus), with a progress bar, a cancel button and
  a real downloaded file.
- **Capability badges** listing exactly which codec strings this device can encode.
- **Optional save** of the timeline JSON to Firestore under `projects/{projectId}`.

Only presets the device can actually produce are offered. If MP4 is missing from the format
list, this browser has no H.264 encoder — WebM is offered instead rather than a dropdown that
fails on click.

## Verified, not assumed

The export path was driven end to end in a real browser with a generated 3-second VP9 clip:

| Check | Result |
| --- | --- |
| Metadata read | 3.01 s, 640×360, 30 fps, `vp09.00.21.08…` |
| WebM · VP9 export | 313 KB in 0.0 s — the copy path |
| MP4 · H.264 export | 233 KB in 0.4 s, bytes contain `avc1` + `avcC`, no `vp09` |
| Trim 0 → 1.5 s, MP4 | 117 KB, measured **1.50 s**, 640×360 |
| `tsc --noEmit` / `vite build` | pass |

The second row is the one worth keeping: an earlier build reported success while copying a VP9
track into an MP4. `NOTES.md` §2 explains the fix.

## What is not done

- No timeline UI, no compositor, no multi-track. That is milestone 2.
- Firebase has never been exercised against a real project — there is no config here, so the app
  runs in local mode and saving is disabled.
- No automated tests. Verification was manual, through the browser.
- The bundle is one 2.5 MB chunk (683 KB gzipped) because Firebase is imported statically.

## Files

- `src/App.tsx` — the milestone-1 screen.
- `src/lib/capabilities.ts` — codec probing and the AAC polyfill registration.
- `src/lib/mediaPipeline.ts` — inspect and trim/export.
- `src/lib/firestore.ts` — Firebase Auth and the project document.
- `firestore.rules` — ownership rules; deploy with `firebase deploy --only firestore:rules`.
- `SPEC.md` — the full product. `NOTES.md` — corrections, measurements and known gaps.

## The one hard rule

No secrets in the frontend. Every `VITE_` variable is compiled into the bundle. Backblaze keys
and AI tokens live in the Worker as secrets, never here.
