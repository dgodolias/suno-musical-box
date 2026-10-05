@AGENTS.md

## Pages

- `/` — Musical Box: ring connection, session recording, song generation.
- `/syncwave/v1`, `/syncwave/v2` — full-screen heartbeat waves for a TV, nothing else on screen, in two designs: v1 draws a ribbon of strands per ring (`components/waveform-v1.tsx`), v2 one wave per ring mirrored around a shared axis (`components/waveform-v2.tsx`). `/syncwave` redirects to the current one (`next.config.ts`). They have no rings of their own: `/` broadcasts each ring's latest heart rate over a `BroadcastChannel` (`lib/heart-rate-channel.ts`), so both pages must be open in the same browser. `?mock` on either (dev only) replays a recorded session from the database; `?mock=<session id>` picks one.
