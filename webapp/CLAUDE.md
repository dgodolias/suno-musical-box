@AGENTS.md

## Pages

- `/` — Musical Box: ring connection, session recording, song generation.
- `/syncwave/v1`, `/syncwave/v2`, `/syncwave/v3` — full-screen heartbeat waves for a TV, in three designs: v1 draws a ribbon of strands per ring (`components/waveform-v1.tsx`), v2 one wave per ring mirrored around a shared axis (`components/waveform-v2.tsx`), v3 gives v2 depth (ranges of ridges with solid flanks, sparks), shows each BPM as a figure among the ridges, keeps both waves travelling right and follows the light/dark/cosmic colour mode, with its own switch that appears on mouse movement (`components/waveform-v3.tsx`). `/syncwave` redirects to the current one (`next.config.ts`). They have no rings of their own: `/` broadcasts each ring's latest heart rate over a `BroadcastChannel` (`lib/heart-rate-channel.ts`), so both pages must be open in the same browser. `?mock` on any of them replays a recorded session from the database, on the live site too; `?mock=<session id>` picks one.
