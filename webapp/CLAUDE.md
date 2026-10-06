@AGENTS.md

## Pages

- `/` — Musical Box: ring connection, session recording, song generation.
- `/syncwave` — full-screen heartbeat waves for a TV, opened by the SyncWave button on `/`: one wave per ring mirrored around a shared axis, each a range of ridges with solid flanks, both always travelling right, each BPM shown as a figure among the ridges (`components/waveform.tsx`). It follows the light/dark/cosmic colour mode, with its own switch that appears on mouse movement. Old `/syncwave/v1`–`v3` links redirect here (`next.config.ts`). It has no rings of its own: `/` broadcasts each ring's latest heart rate over a `BroadcastChannel` (`lib/heart-rate-channel.ts`), so both pages must be open in the same browser. `?mock` replays a recorded session from the database, on the live site too; `?mock=<session id>` picks one.
