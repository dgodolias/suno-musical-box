# Full session recording verification

Implemented on 2026-10-05. Each fresh participant reading receives a stable sample UUID, session UUID and its original acquisition timestamp. IndexedDB retains samples until the database acknowledges those exact IDs. Unavailable sensor fields remain null. The initial 30 seconds supplies the music snapshot; recording continues until song readiness or explicit Stop. With Suno disabled, Stop ends recording.

New Session retires the finished recording, resets genres, player and session counters, and preserves the mounted ring cards and their Bluetooth connections. Pending older samples retain their own session identity and continue retrying. Reload restores recording identity and durable data, but does not repeat an uncertain paid music request. Closing or sleeping the browser cannot collect new BLE data; pending local writes, storage eviction and device loss remain limits.

## Verified

- 87 automated tests passed: 57 BLE, 30 recording/outbox/API tests. Coverage includes recording beyond 30 seconds, song-ready completion, reset without replacing ring refs, reload, delayed parent creation, in-flight uploads, partial acknowledgements, local write failures and both Suno guards.
- TypeScript, scoped ESLint and production webpack build passed.
- Additive migration applied to the existing database: nullable client UUID columns and unique indexes; legacy numeric IDs and schema preserved.
- Real database/API replay test: repeated creation uses one parent, duplicate samples stay unique, conflicting sample contents are not acknowledged, timestamps and null values are preserved, repeated end keeps the original end time.
- Both generation endpoints returned 423 while paused. No song request was sent to Suno.
- Chrome mock recording ran for 60 seconds: 60 observations for each participant, 120 distinct database sample IDs, including observations after 30 seconds. UI displayed Saved and restored the finished session after reload.
- Real-ring session ran for 150 seconds: 152 observations for participant 1 and 19 for participant 2, exactly matching database counts and distinct sample IDs. Participant 2 lost BLE just before recording began and was manually reconnected during the same session; its new measurements joined that session without fabricating the missing interval. HRV and SpO2 remained null. The unexplained BLE loss was an observed transport event with no preceding app STOP, not a demonstrated storage fault.
- New Session reset the real session to Ready while both rings continued receiving HR; counters continued increasing and the newer session did not issue another sensor START.
- The second real recording used a different database session ID and retained 36 participant-1 and 37 participant-2 observations. Both ring diagnostics still showed one START, zero CONTINUE and zero recoveries across the reset. Private diagnostic files: `new-session-connected-person-1.json` and `new-session-connected-person-2.json`.

## Authorized testing-data cleanup

After both browser test tabs showed Ready with no pending uploads, and all four new test sessions had acknowledged end times, the three application tables were truncated together without CASCADE or sequence reset. Removed 67 sessions, 8,883 readings and 46 song records. Immediate verification returned zero rows in each table and confirmed all three tables remain. All test browser recordings were stopped and retired first, preventing their outboxes from recreating deleted testing data.

Battery estimation and reliable off-body detection are separate unresolved hardware/protocol investigations, documented in `ring-measurement-audit.md`.
