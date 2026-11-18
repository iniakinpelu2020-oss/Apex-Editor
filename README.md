# Apex Editor

A browser-based multi-track video editor for the Apex suite, with AI captions and a timeline
copilot. Zero server render cost.

**Status: specification only. No app code yet.** This repo holds the plan, the database
migration and the decisions that have to be made before the first component is written.

## Why it is only a spec

This is the largest thing on the whole Apex list — a React + TypeScript application, a
WebCodecs export pipeline, an auth gate, a database and an AI router integration. A working
version is a project measured in months, not a single file. Writing it in one sitting would
produce a convincing-looking editor that cannot reliably finish and export one video, which
is worse than an honest plan.

## What is in here

- `SPEC.md` — the product: tracks, timeline, canvas, export, AI features, layout.
- `NOTES.md` — the technical corrections and build order. Read this before writing code;
  three of the assumptions in the original spec would have cost days.
- `supabase/migrations/0001_apex_editor_projects.sql` — the project table with row level
  security, ready to paste into the Supabase SQL editor.
- `.env.example` — every variable the app needs, and which ones are public.

## The one hard rule

No secrets in the frontend. Every `VITE_` variable is compiled into the JavaScript bundle and
is readable by anyone who opens the site. Backblaze keys, Supabase service keys and AI router
tokens live in the Worker as secrets, never here.

## Suggested first build

Not the timeline. The export path — load a video, cut ten seconds, encode and download an
MP4. If that does not work on your phone, nothing else matters, and every later feature
depends on it.
