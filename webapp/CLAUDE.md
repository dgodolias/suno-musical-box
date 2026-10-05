@AGENTS.md

## Pages

- `/` — Musical Box: ring connection, session recording, song generation.
- `/syncwave` — full-screen heartbeat waves for a TV, nothing else on screen. It has no rings of its own: `/` broadcasts each ring's latest heart rate over a `BroadcastChannel` (`lib/heart-rate-channel.ts`), so both pages must be open in the same browser. `/syncwave?mock` (dev only) replays a recorded session from the database; `?mock=<session id>` picks one.
