# Apex Editor — technical notes and corrections

Read this before writing code. Everything below is either a verified fact or a decision that
has to be made deliberately, and three of these would cost you days if you found them by
trial.

## 1. MP4 with AAC audio needs one extra package, and a capability check

The spec says "render crisp `.mp4` (H.264 + AAC) 100% client-side". That is achievable, but
not with `mediabunny` alone.

Verified current state of WebCodecs audio encoding:

- **Opus** — broadly supported for encoding, and the safe choice everywhere.
- **AAC** — *not* supported for encoding in Firefox on any platform, nor in any browser on
  desktop Linux. Safari supports it only from version 26. Chrome supports it on most
  platforms.

So an MP4 + AAC export will simply fail for a chunk of your users, including anyone on
Firefox. The fix is a package that ships with the muxer's ecosystem:

```
npm install mediabunny @mediabunny/aac-encoder
```

```ts
import { canEncodeAudio } from "mediabunny";
import { registerAacEncoder } from "@mediabunny/aac-encoder";

// use the browser's encoder when it exists, and a WASM AAC-LC encoder when it does not
if (!(await canEncodeAudio("aac"))) registerAacEncoder();
```

That polyfill is a size-optimised WASM build of FFmpeg's AAC encoder. With it registered,
MP4 + AAC works everywhere the muxer does.

**H.264 video encoding has the same problem.** Chrome on Android uses hardware encoders and
is fine; desktop Linux Chrome frequently has no H.264 encoder at all. Use
`VideoEncoder.isConfigSupported()` with the real codec string (`avc1.4d0034`, not `"h264"`)
before offering the option.

**The design that follows from this:** probe capabilities at startup, then show only the
profiles the device can actually produce.

| Profile | Video | Audio | Container | When |
| --- | --- | --- | --- | --- |
| Best | H.264 | AAC | MP4 | encoder supports both |
| Fallback | VP9 or AV1 | Opus | WebM | no H.264 or no AAC |
| Never ship | — | — | — | a format dropdown that fails on click |

## 2. 4K is a trap on a phone

4K export on Android is frequently unsupported for H.264 encode, and where it is supported
it heats the device and throttles within seconds. Default to 1080p. Offer 4K only when
`isConfigSupported` returns true *and* the source is at least 4K — upscaling a 1080p clip to
4K produces a bigger file of the same picture.

Also measure before trusting: a 60-second 1080p30 timeline holds roughly 1.8 GB of raw frames
if you buffer it. Stream frames to the encoder as you draw them; never build an array of
`VideoFrame`s first.

## 3. Supabase pauses a quiet project, and this is exactly a quiet project

The free tier pauses a project after about a week without activity. An editor you open once a
month will be dead every time you open it, with an error that looks like a code bug.

Two honest options:

1. **Keep Supabase and add a keepalive.** One scheduled Worker (you already have the cron
   pattern in `Automation`) that runs a trivial `select 1` daily. Cheap, and it keeps the
   project awake.
2. **Drop Supabase and use Firestore.** You are already using Firebase Auth, and Firestore's
   free tier has no pause. The timeline JSON is a document — this is what Firestore is for.
   Fewer vendors, one fewer key, one fewer failure mode.

Recommendation: option 2 unless you have a reason to prefer SQL. The migration below is
correct and ready either way.

## 4. `VITE_OWNER_UID` is not a security control

Anything named `VITE_` is compiled into the bundle and readable in the browser's dev tools.
Checking the signed-in UID against `VITE_OWNER_UID` stops nobody; it is a convenience check
so *you* do not open the editor in the wrong account.

The actual boundaries are:

- **Database:** row level security, `auth.uid() = user_id`, on every policy. That is what the
  migration is for.
- **Storage:** the Worker checks the caller's Firebase ID token and refuses anyone who is not
  the owner before it presigns anything.
- **AI router:** same check, per request. An AI route with no auth is a route that spends your
  free allowance for strangers.

Treat the owner UID as UI, the RLS policies and Worker checks as security.

## 5. Backblaze never touches the browser

The B2 application key opens a whole bucket. It must live in the Worker as a secret, and the
browser gets short-lived presigned URLs — five minutes, one object, one method. This is
already built in `Apex-Drive`; reuse that signing code rather than writing a second version.

## 6. Silence and beat detection are DSP, not AI

The spec routes "cut all silent pauses" and beat detection toward the AI router. Do not.
Both are exact measurements:

- **Silence:** scan PCM for windows below a threshold (say -42 dBFS) lasting longer than
  300 ms. Web Audio gives you the samples; the loop is twenty lines and runs on any phone in
  under a second for a ten-minute track.
- **Beats:** find transient peaks in a low-passed signal, or run an onset detector over the
  amplitude envelope.

An LLM cannot hear the audio. Sending it a waveform and asking where the pauses are is slower,
costs tokens, and is wrong sometimes — which for an automatic cutter means deleting audio you
wanted.

The right split: the DSP produces the facts (list of gap ranges, list of beat timestamps),
then the model — or better, plain code — turns those facts into edits. One-click dead-air
removal then needs no AI at all.

## 7. AI timeline patches need a schema, a diff and a confirm

Section 3.2 has the copilot return JSON patches applied "cleanly to the Undo/Redo stack".
Applied cleanly is doing a lot of work in that sentence.

Rules that keep this safe:

1. The model returns a **named action list** from a closed set (`splitClip`, `deleteRange`,
   `addKeyframe`, `setSpeed`, `addText`). Anything outside the set is rejected, not guessed.
2. Every patch is validated against a schema **before** it touches state.
3. Show the effect as a sentence — "split 7 clips, delete 42s, add 3 keyframes" — and require
   a click. Never auto-apply.
4. Apply the whole batch as **one** undo entry, so one Ctrl+Z reverses the command rather than
   leaving the timeline half-edited.
5. Log every applied patch with the prompt that caused it.

This matches the copilot rules in `Apex/COPILOT.md`: the model proposes, the app disposes.

## 8. Captions: resample, cap, and say what happened

- Resample to 16 kHz mono before sending. Whisper does not need more, and it makes the upload
  roughly a twentieth of the size.
- Chunk long audio. A 40-minute podcast is one failed request; ten four-minute chunks are ten
  successes you can stitch, and one failure barely matters.
- Timestamps come back per segment; word-level timing is what makes kinetic captions work, so
  check the model you pick actually returns words, not just sentences.
- Keep the transcript. Re-running transcription because a caption style changed is waste.

## 9. Scope: this is a months-long build, so pick a version that ships

The specification describes CapCut. CapCut is built by a large team. A realistic first version
for one person, done properly:

**v1 — the one that finishes a video**

- One video track, one overlay track, one text/caption track, one audio track.
- Trim, split, delete, move, and speed on clips.
- Fade and cross-dissolve only.
- Canvas preview at 16:9 / 9:16 / 1:1, with scale and position.
- 1080p MP4 export with a progress bar and a real cancel button.
- Undo and redo.
- Save and load the timeline JSON.

**v2 — the one that feels like an editor**

- Keyframes, colour adjustment, more transitions, waveform display in the timeline.
- Magnetic snapping and ripple delete.
- Silence removal from the DSP pass.
- Captions from Whisper.

**v3 — the AI one**

- Timeline copilot with patch previews.
- Beat markers and auto-cut to the music.

Keyframes, ripple-magnetic editing and AI patching are each a project. Trying to land all
three at once is how the timeline ends up with a beautiful UI and a broken export button.

## 10. Build order

1. **Export path.** Load a file, keep ten seconds, encode MP4, download it. Test on your
   Android phone before anything else. Everything depends on this.
2. **Timeline state.** Normalised clips, an undo stack, and a playhead clock. No UI polish.
3. **Compositor.** Draw the current frame for a given time; this is the only thing the
   preview and the exporter share, so it must be a pure function of `t`.
4. **Timeline UI.** Ruler, clips, drag, trim, split. This is where the weeks go.
5. **Persistence.** Save and load, then the B2 media bin.
6. **Captions, then copilot.**

A note worth keeping: preview and export must render through the same code. If the preview
uses DOM video elements and the export uses a canvas, they will disagree, and you will spend a
weekend discovering that your captions are four frames out.
