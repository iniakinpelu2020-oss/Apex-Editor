# Apex Editor — technical notes and corrections

Read this before changing the pipeline. Everything below is either a verified fact or a
decision that has to be made deliberately, and several of these would cost days if you found
them by trial.

## 1. MP4 with AAC audio needs one extra package, and a capability check

"Render crisp `.mp4` (H.264 + AAC) 100% client-side" is achievable, but not with `mediabunny`
alone.

Verified state of WebCodecs audio encoding:

- **Opus** — broadly supported for encoding, and the safe choice everywhere.
- **AAC** — *not* supported for encoding in Firefox on any platform, nor in any browser on
  desktop Linux. Safari supports it only from version 26. Chrome supports it on most platforms.

So an MP4 + AAC export will simply fail for a chunk of browsers. The fix:

```ts
import { canEncodeAudio } from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

if (!(await canEncodeAudio("aac"))) registerAacEncoder();
```

That polyfill is a size-optimised WASM build of FFmpeg's AAC encoder. With it registered, MP4 +
AAC works anywhere the muxer does.

**Call it on the main thread.** `registerAacEncoder()` spins up a Worker internally, and Firefox
refuses to nest a blob-buffer worker inside another worker — so registering from inside a nested
worker stalls the export with no error. `src/lib/capabilities.ts` calls it from the main thread
during the startup probe.

**H.264 has the same problem.** Chrome on Android uses hardware encoders and is fine; desktop
Linux Chrome frequently has no H.264 encoder at all. Probe with the real codec string
(`avc1.4d002a` for 720p30, `avc1.4d0034` for 1080p30 — never `"h264"`) before offering it.

| Profile | Video | Audio | Container | When |
| --- | --- | --- | --- | --- |
| Best | H.264 | AAC | MP4 | encoder supports both |
| Fallback | VP9 | Opus | WebM | no H.264 encoder |
| Never ship | — | — | — | a format dropdown that fails on click |

## 2. A preset is a promise about the codec, not just the container

This one bit the first working build, and it is the most dangerous bug in the export path
because it produces a *successful* export that is not what it says.

`Conversion` copies encoded packets whenever it can. Given a VP9 source and an MP4 output with
`audio: { codec: "aac" }` and no `video` option, mediabunny will copy the **VP9 track into an
MP4** — because MP4 is allowed to contain VP9. The export finishes in milliseconds, the file
plays, and the app says "MP4 · H.264". It is not H.264.

The fix is in `exportClip`: read the source track's codec with `getCodec()`, compare it to the
preset, and when they differ, name the codec explicitly so the conversion re-encodes:

```ts
const codecMismatch = sourceVideoCodec !== req.videoCodec;
video: wantsResize
  ? { codec: req.videoCodec, width, height, fit: "contain" }
  : codecMismatch ? { codec: req.videoCodec } : undefined,
```

Verified after the fix: exporting a 3 s VP9 clip as "MP4 · H.264 · 720p" produces bytes
containing `avc1` and `avcC` and **no** `vp09`, in 0.4 s. Before the fix the same export took
0.0 s and contained `vp09`.

The same rule applies to audio: only pass `audio: { codec }` when the source audio codec
differs, otherwise you turn a free copy into a resample for nothing.

## 3. `trim.start` and the copy path

Copy is what makes a ten-second cut take a second instead of a minute. Two things limit it:

- The output container must accept the source codec and the timestamps.
- Resizing, rotating or changing a codec forces a transcode by definition.

Mediabunny's docs note that setting `trim.start` to a non-default value currently forces a
transcode of both video and audio in the default configuration; the packet-copy path for
arbitrary trim ranges arrives via MP4 edit lists and the `copy` options. This repo passes
`copy: { mode: "preferred" }` and lets the library decide, then reports what actually happened
in the UI rather than promising a fast path it cannot guarantee.

Measured on a 3 s 640×360 VP9 clip in the test browser:

| Export | Result | Time |
| --- | --- | --- |
| WebM · VP9 (codec matches) | 313 KB, copied | 0.0 s |
| MP4 · H.264 (codec differs) | 233 KB, re-encoded | 0.4 s |
| MP4 · H.264, 0 → 1.5 s | 117 KB, exactly 1.50 s | 0.2 s |

## 4. 4K is a trap on a phone

4K export on Android is frequently unsupported for H.264 encode, and where it is supported it
heats the device and throttles within seconds. Default to 1080p. Offer 4K only when
`isConfigSupported` returns true *and* the source is at least 4K — upscaling a 1080p clip to 4K
produces a bigger file of the same picture.

Also: a 60-second 1080p30 timeline holds roughly 1.8 GB of raw frames if you buffer it. Stream
frames to the encoder as you draw them; never build an array of `VideoFrame`s first.

## 5. Supabase is gone; timelines live in Firestore

Supabase's free tier pauses a project after about a week without activity. An editor you open
once a month is exactly that shape of project, and the failure looks like a code bug.

Firestore does not pause, and Firebase Auth was already the sign-in gate. So this app uses
**Firebase Auth + Cloud Firestore only**: `projects/{projectId}` per project, timeline JSON
only, well under the 100 KB document guidance. Raw media never goes into Firestore — it stays
in OPFS/IndexedDB or in B2 behind presigned URLs.

`supabase/migrations/0001_apex_editor_projects.sql` has been removed from this repo so there is
one obvious source of truth for persistence.

## 6. Ownership is enforced by rules, not by the frontend

`VITE_OWNER_UID` is gone. It was a convenience check that looked like security: anything named
`VITE_` is compiled into the bundle and readable in dev tools.

The boundaries that actually hold:

- **Firestore:** `firestore.rules` requires a signed-in user, requires
  `request.resource.data.userId == request.auth.uid` on create, and refuses any update that
  changes `userId`. The wildcard rule at the end denies everything else, so a new collection is
  closed by default.
- **Storage:** the AI Router Worker checks the caller's Firebase ID token and refuses anyone who
  is not the owner before presigning. It also forces every key under `u/<uid>/`.
- **AI:** the same token check per request. An AI route with no auth spends your free allowance
  for strangers.

`userId` is written from the caller's own `uid` in `src/lib/firestore.ts`, but that is a
courtesy: the rules reject a forged value server-side.

## 7. Backblaze never touches the browser

The B2 application key opens a whole bucket. It lives in the Worker as a secret; the browser
gets short-lived presigned URLs — minutes, one object, one method.

## 8. Silence and beat detection are DSP, not AI

Both are exact measurements, not model outputs:

- **Silence:** scan PCM for windows below a threshold (say -42 dBFS) lasting longer than 300 ms.
  Web Audio gives you the samples; twenty lines, under a second for a ten-minute track.
- **Beats:** transient peaks in a low-passed signal, or an onset detector over the amplitude
  envelope.

An LLM cannot hear the audio. The right split: DSP produces the facts (gap ranges, beat
timestamps), then plain code turns them into edits.

## 9. AI timeline patches need a schema, a diff and a confirm

1. The model returns a **named action list** from a closed set (`splitClip`, `deleteRange`,
   `addKeyframe`, `setSpeed`, `addText`). Anything outside the set is rejected, not guessed.
2. Every patch is validated against a schema **before** it touches state.
3. Show the effect as a sentence — "split 7 clips, delete 42s, add 3 keyframes" — and require a
   click. Never auto-apply.
4. Apply the whole batch as **one** undo entry.
5. Log every applied patch with the prompt that caused it.

## 10. Build order

1. **Export path.** Load a file, keep ten seconds, encode MP4, download it. Test on the Android
   phone before anything else. Done — see `README.md`.
2. **Timeline state.** Normalised clips, an undo stack, a playhead clock. No UI polish.
3. **Compositor.** Draw the current frame for a given time; the only thing preview and exporter
   share, so it must be a pure function of `t`.
4. **Timeline UI.** Ruler, clips, drag, trim, split. This is where the weeks go.
5. **Persistence.** Save and load, then the B2 media bin.
6. **Captions, then copilot.**

Preview and export must render through the same code. If the preview uses DOM video elements
and the export uses a canvas, they will disagree, and you will spend a weekend discovering that
your captions are four frames out.

## 11. Known gaps in milestone 1

Honest list, so nothing looks finished that is not:

- **Bundle size.** A single 2.5 MB chunk (683 KB gzipped), because Firebase is imported
  statically. On a phone on a slow connection that is a few seconds of white screen. The fix is
  to keep the auth/Firestore imports behind `await import()` and only load them when the user
  signs in or saves. Not done yet.
- **No Tailwind.** The spec table says Tailwind; this build uses one plain CSS file. Fewer build
  moving parts for milestone 1. Worth revisiting when the timeline UI lands.
- **Firebase is untested against a real project.** There is no Firebase config in this
  environment, so the app runs in local mode and the save button is disabled. The sign-in flow,
  `firestore.rules` deployment and a real `setDoc` have not been exercised.
- **No automated tests.** Verification was done by driving the real export path in a browser and
  inspecting the produced bytes; that should become a test before the timeline lands.
- **One clip, one track.** The trim is `primary` track only, container-level trimming, no
  compositor. That is the milestone, not the editor.
