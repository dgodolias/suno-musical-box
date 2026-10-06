# Ring measurement audit

Date: 2026-10-05. Scope: maintain live HR measurements and make their freshness observable. The animated waveform stays unchanged; it is not a raw physiological trace.

> Later on 2026-10-05, at the user's request, that waveform was replaced: the session panel no longer shows one, and the `/syncwave` page draws two ribbons from each ring's latest BPM. The statements below about the wave describe the state at the time of this audit.

**User constraint: never flash, update, or replace either ring's firmware.** No firmware flash, OTA, or update has been attempted. Work is limited to the browser application and measurement commands.

**Local test pause:** Suno calls are disabled and must remain disabled until the user explicitly requests resumption. The ignored `.env.local` contains `SUNO_DISABLED=true` and `NEXT_PUBLIC_SUNO_DISABLED=true`; no other secrets were changed. Server guards reject generation and status polling with HTTP 423 before body/parameter processing, network calls, or database access. The UI shows the pause and Start collects ring data only. Live localhost checks confirmed that both `POST /api/generate` with `{}` and `GET /api/generate/ring-test-gate` return 423 with `Music generation paused for ring tests`.

## Findings and selected correction

**Latest physical evidence:** after correcting the `0x69/type6` parser and automatically selecting Realtime 6 for the two exact tested profiles, both rings streamed sensor-reported BPM together for more than three minutes, at roughly one frame per second. The user confirmed both worked. Automatic retry after measurement errors also resumed after refitting, but a separate confirmed table test produced false-positive BPM. Continuous acquisition is demonstrated; reliable wear detection is not. This is realtime HR, not PhoneSport. Full session storage and New Session are now verified separately; unresolved wear detection prevents declaring the whole project complete.

The original browser client requested type-1 HR repeatedly with START. The first correction then copied a 10-sample continuation rule from RingCLI. **The first physical-device baseline contradicts using that rule universally:** CONTINUE was repeatedly followed by long gaps in valid readings on the newer ring. A retained BPM value does not prove that new measurements are arriving, and a successful GATT write does not prove the ring resumed acquisition.

The retained Standard flow uses type-1 START (`69 01 01`), STOP (`6A 01`), and a bounded watchdog. CONTINUE (`69 01 03`) is allowed only after at least 10 seconds without an HR notification and only once the current measurement has produced a valid HR sample. After that one continuation, allow **60 seconds of grace before bounded recovery**, rather than repeatedly continuing during reacquisition. **No count-triggered CONTINUE and no CONTINUE during the initial 60-second warmup.** These are prefixes; command-channel packets are 16 bytes with zero padding and a sum-modulo-256 checksum. [RingCLI's implementation](https://github.com/smittytone/RingCLI/blob/main/lib/ble/ble.go) and [packet builders](https://github.com/smittytone/RingCLI/blob/main/lib/colmi/packet.go) remain useful command references. This strategy improves handling of the batched mode; the type-6 evidence below is the stronger path to sustained readings on the two tested units.

New valid packets count as samples even when BPM is unchanged. Diagnostics should show the count, age of the last valid HR sample, recent commands/errors, and available hardware/firmware identifiers. Battery or raw-sensor packets must not make old HR look fresh. Invalid frames must not become measurements. Disconnect/reconnect must retire the previous stream's listeners, timers, queued writes, and stale values.

| Verified software problem | Change |
| --- | --- |
| START resent every 45 seconds, including healthy streams | Leave healthy streams alone; continue only after notification silence following valid HR, and restart only after prolonged stalls. |
| Initial correction sent CONTINUE after every 10 valid samples | Remove the count trigger after observing repeated zero-valued gaps immediately after those commands. An uninterrupted newer-ring comparison remains pending. |
| Repeated CONTINUE every roughly 10 seconds followed an older-ring burst | Send one continuation, then leave a 60-second reacquisition grace period before bounded recovery. Later Standard captures obtained repeated bursts without recovery, but still had approximately 40-second sample gaps. |
| Realtime 6 parser treated every `69 06` frame as an acknowledgement | Decode byte 3 as HR when type 6 is selected, error byte 2 is zero, checksum is valid, and BPM passes validation. Corrected UI and dual streams are verified below. |
| Cached HR prevented acquisition restarting after a disconnect | Clear stale values and cancel obsolete connection/measurement work. |
| Battery/calibration traffic could be recorded as fresh copies of old HR | Separate fresh-HR observations from display state updates. |
| Uploading the last ten samples every five seconds duplicated sparse data and dropped bursts | Queue unsent observations per session; retain failures and preserve acquisition timestamps. |
| Session snapshots mixed older sessions or duplicated one person's data as both people | Restrict observations to the current 30-second window; require both people for a combined snapshot. |
| BPM stayed visible indefinitely without a freshness indicator | Show sample count, sample age, stale/error/warmup state, and reset disconnected BPM. |

The animated wave remains byte-for-byte unchanged. It is intentionally decorative and driven by the difference between the two latest BPM values. No synthetic BPM fluctuations were added.

## Hardware baseline A — observed, not acceptance

The user confirmed both rings were worn, both green LEDs were active, and battery was reported at 100%. Diagnostics showed traffic from both during the same period. The following is a summary only; raw personal packets and device identifiers are not included in this audit.

| Unit | Observed behavior with the first correction |
| --- | --- |
| `RT02R_V3.1`, firmware `RT02R_3.11.00_250611` | First valid HR approximately 27 seconds after START. HR frames arrived at about 2 Hz. Each CONTINUE after 10 valid samples was immediately followed by approximately 25 seconds of zero-valued frames, then another short valid burst. |
| `R02_V3.0`, firmware `R02_3.00.17_240903` | Single zero-valued acknowledgement after START/CONTINUE; no valid HR observed while the earlier implementation sent repeated CONTINUE during warmup. |

The first-ring timing suggests commands may be disturbing acquisition, but the type-1 baseline alone does not establish causation. The older ring's initial zero-only result was superseded by experiment B below. Green LEDs establish sensor activity, not valid HR. Packet frequency is not necessarily the frequency of independent physiological estimates. Experiment C establishes separate type-6 streams; experiment D establishes sustained simultaneous streams after the parser correction.

## Hardware experiment B: older ring alone

With uninterrupted initial warmup, `R02_V3.0 / R02_3.00.17_240903` produced valid HR in both **Standard** (`69 01 01`) and **Legacy R02** (`69 01 00`). Times below are the session's diagnostic timestamps on 2026-10-05; this is a summary, not a raw packet log.

| Event | Observed result |
| --- | --- |
| Standard START at `12:13:55.760` | First valid HR at `12:14:21.286`, about 25.5 seconds later. Exactly 10 valid readings arrived at approximately 2 Hz, with values 84-88 BPM; the last arrived at `12:14:25.558`, then notifications stopped. |
| CONTINUE at `12:14:36.130` | Zero-valued acknowledgement. Further CONTINUE at `12:14:47.773` and `12:15:00.021` produced no valid HR in that interval. |
| STOP/START recovery at `12:15:12.338` | Another 10-reading burst began at `12:15:38.351`, about 26 seconds later. |
| Legacy R02 START at `12:16:51.283` | Also produced 10 valid readings after about 25 seconds, then silence. |

This establishes that both START variants can obtain measurements on the older ring. It does **not** establish a Legacy R02 advantage or justify automatic selection of Legacy. Later Standard captures with continuation grace showed repeated bursts in the same dual-connected session: the newer ring's report had 70 cumulative samples, 1 START, 6 CONTINUE and 0 recoveries; the older had 34 samples, 1 START, 4 CONTINUE and 0 recoveries. The newer report's bounded 200-event buffer retained only its last 30 positive frames, in three 10-frame bursts (median gap 0.483 s, maximum 39.635 s). All 34 older-ring frames were retained (median gap 0.507 s, maximum 39.204 s). Retained frames had valid checksums. This verifies recurring measurements from both with grace, but not sustained continuous acquisition.

The manual Standard / Legacy comparison issues STOP, waits 2 seconds, then sends the selected START. The zero-action variant follows [Gadgetbridge's `onHeartRateTest()`](https://github.com/Freeyourgadget/Gadgetbridge/blob/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/colmi/ColmiR0xDeviceSupport.java), with `3.00.17` among its [tested firmware versions](https://gadgetbridge.org/gadgets/wearables/colmi/).

## Hardware experiment C: type-6 stream on each ring

Independent analysis of the two local diagnostic captures isolated the interval after `69 06 01`, verified 16-byte checksums, required error byte 2 to be zero, and read the positive measurement at byte 3. No raw personal captures, device names, or device identifiers are included here. These runs occurred separately; timestamps in this section are UTC on 2026-10-05.

| Measurement | Older `R02_V3.0 / R02_3.00.17_240903` | Newer `RT02R_V3.1 / RT02R_3.11.00_250611` |
| --- | --- | --- |
| Type-6 START | `12:53:49.658` | `12:57:00.070` |
| First positive HR | `12:54:08.901` (19.243 s warmup) | `12:57:15.124` (15.054 s warmup) |
| Positive HR frames | 72 | 76 |
| BPM range | 80-89 | 75-84 |
| First-to-last positive span | 70.470 s | 75.002 s |
| Median / maximum gap | 0.970 s / 1.455 s | 0.966 s / 3.229 s |
| Type-6 frames / checksum failures | 73 / 0 | 77 / 0 |
| STOP `6A 06` | `12:55:19.693` | `12:58:30.117` |
| Post-STOP observation | No further type-6 HR through report generation 65.490 s later | One trailing frame 9 ms after STOP; no later type-6 HR through report generation 88.366 s later |

Only START and STOP were sent during each type-6 interval: **no CONTINUE or restart was needed during these captures**. The older ring's final positive frame arrived 322 ms before STOP; the newer ring's final positive frame was the trailing frame noted above. The 90-second diagnostic timeout was caused by the app ignoring incoming `69 06` values, not by a lack of ring data. Existing UI sample counters include earlier type-1 readings and cannot be used to count these type-6 captures.

Interpretation combines the [documented type-6 HR enum](https://colmi.puxtril.com/commands/#data-request), the generic response layout, and the observed device behavior. Current Gadgetbridge's [exact `0x69` dispatch](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/yawell/ring/YawellRingDeviceSupport.java#L355) calls its [HR parser](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L142) without a subtype filter; that parser uses byte 2 as error and byte 3 as BPM. [Tahnok's generic parser](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/real_time.html#parse_real_time_reading) corroborates those offsets, although its enum omits type 6. Puxtril does not publish a generic `DataResponse` structure, and its `0x1E` cross-reference does not prove that every type-6 implementation must reply on `0x1E`.

The packet streams and bounded STOP observations are verified on these two exact revisions. They do not establish physiological accuracy, indefinite connection stability, or support for another firmware. The parser correction and automatic selection are now implemented only for these exact hardware/firmware pairs; other revisions retain Standard unless manually changed.

## Hardware experiment D: corrected simultaneous streams

Two checkpoints per participant were merged and deduplicated by timestamp, direction and detail to overcome the 200-event report limit. UTC timestamps are from 2026-10-05. Counts below mean structurally valid sensor reports, not independently validated physiological measurements.

| Measurement | Newer `RT02R_V3.1` | Older `R02_V3.0` |
| --- | --- | --- |
| Healthy interval START | `13:08:50.563` | Manual retry at `13:09:21.480`, after intentional removal |
| First / last positive frame | `13:09:06.669` / `13:12:46.724` | `13:09:39.938` / `13:12:47.065` |
| Positive frames / span | 221 / 220.055 s | 189 / 187.127 s after retry; 213 cumulative including 24 before removal |
| Median / maximum gap | 0.9705 s / 2.823 s | 0.9675 s / 2.808 s |
| Sensor-reported BPM range | 76-102 | 74-89 |
| Checksum failures | 0 | 0 |
| Commands during the healthy interval | One START; no CONTINUE or recovery | One START; no CONTINUE or further recovery |

Both reported measuring with no current error and a last-sample age below 1.3 seconds at the final checkpoints. Their overlapping positive streams span more than three minutes. The user confirmed both worked. The older ring's earlier retry was **manual**; experiment D does not prove automatic recovery after removal.

## Hardware experiment E: removal, refitting and off-body limitation

Intentional removal of each ring was associated with `69 06` errors 1/2. For example, the newer ring emitted four status-1 frames beginning `13:15:10.650`, then status 2 at `13:15:12.102`, while the older ring continued measuring. The new retry path clears the displayed value to `--`, retains the BLE connection and retries acquisition after the error. The user subsequently confirmed automatic return after refitting one ring, with approximately 15 seconds of sensor warmup after START.

**Off-body false positives were reproduced twice.** In the older ring's first table capture, automatic START at `13:20:06.033` was followed by 45 checksum-valid, status-zero reports of 88-90 BPM from `13:20:25.366` through `13:21:08.948`. Bytes 4-14 were all zero, and the same packet patterns also occurred while worn. The user confirmed the ring was on the table. These frames cannot be distinguished from worn HR by the current packet fields. A later off-body attempt produced no HR and correctly left `--`; that clean attempt does not invalidate the failure.

A second controlled wear/remove trial reproduced it on the same older revision. Removal produced status 1 at `13:29:03.856` and status 2 at `13:29:05.270`; automatic START at `13:29:07.878` was followed by 61 status-zero sensor reports of 87-89 BPM from `13:29:27.092` through `13:30:26.866`, again while the user confirmed the ring was on the table. Thus restarting the green LED after removal is caused by the app's retry command, not a verified detection of refitting. Reliable wear detection and the final recovery policy remain unresolved. Deeper research into raw optical quality or a combination of signals is requested; no such method is implemented or verified.

No verified dedicated worn/refitted flag was found for these exact revisions in the reviewed primary sources. [Gadgetbridge's HR handler](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L142) treats status 1 as worn incorrectly and status 2 as temporary/missing data. Status zero permits HR parsing; it is not affirmative proof of contact. A zero-valued START response likewise does not establish contact. [Puxtril's command catalog](https://colmi.puxtril.com/commands/) has no documented wear/contact command.

The R08-only [SDK-derived event table](https://github.com/MRziyi/Halo-Ring/blob/main/Doc/09-r08-ble-protocol-spec.md#52-sub-id-table) identifies `73/2A` as a touch-disabled settings echo/charging-dock event and `73/3F` as ECG electrode state. Neither is a verified on-finger signal for these rings. No speculative contact commands were sent. Automatic acquisition retry must not be described as reliable automatic wear detection, and sensor BPM must not be used as proof that the ring is being worn.

## Why sports mode is not the default fix

Four flows must remain distinct:

| Flow | Evidence | Decision |
| --- | --- | --- |
| Type-1 HR (`69 01 ...`) | Newer-ring gaps followed count-triggered CONTINUE; older-ring Standard and Legacy both yielded 10-reading bursts after uninterrupted warmup. | Retained Standard/Legacy batched modes with one silence-triggered continuation followed by 60-second grace. |
| Type-6 realtime HR (`69 06 ...`) | Both exact local revisions produced roughly 1 Hz streams, including more than three minutes together; bounded STOP observations above. | Corrected parser and exact-profile selection implemented. Keep contact-inference limitations explicit. |
| Standalone realtime HR (`1E 01` / `1E 03` / `1E 02`) | Implemented in current Gadgetbridge; response BPM at byte 1. | Separate source-backed candidate; not exercised on the user's rings and not needed to explain experiment C. |
| PhoneSport (`77` start/stop, `78` notifications) | Separate implemented protocol, with captured R08 session traffic. The apparent HR field remains unverified in the detailed report. | Requires its own parser and device evidence before use. |

[The protocol reference](https://colmi.puxtril.com/commands/#data-request) defines the HR types and actions. [Halo-Ring's PhoneSport report](https://github.com/MRziyi/Halo-Ring/blob/main/Doc/09-r08-ble-protocol-spec.md#48-phone-sport-session-0x77--0x78) documents `77 01 <sportType>` / `77 04 <sportType>` and observed `78` frames on `RT08_V3.1 / RT08_3.10.46_250621`; its [Kotlin implementation](https://github.com/MRziyi/Halo-Ring/blob/main/app-project/core/src/main/kotlin/com/halo/ring/core/ble/R08Protocol.kt) corroborates those builders. A session timer that advances each second does not prove fresh BPM each second. Evidence from R08 cannot establish behavior on our R02/R03 rings.

The [current Python protocol module](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/real_time.html) contains both `69/type/3` and the legacy `1E/33` constant; [its client](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/client.html) stops after six valid values without continuing. This resolves the contradictory claims in the historical findings file.

[Gadgetbridge](https://gadgetbridge.org/gadgets/wearables/colmi/) warns that the same marketed ring names can use different hardware and companion apps. [RingCLI](https://github.com/smittytone/RingCLI#important-note-on-firmware-variants) also records different R02/RY02 firmware. Always attach hardware and firmware revisions to conclusions.

## Explicit Realtime 6 diagnostic

The **Realtime 6** option sends START `69 06 01` and STOP `6A 06`. Switching modes stops the previous measurement type, waits 2 seconds, and starts the selected type. A healthy Realtime 6 stream receives **no CONTINUE or repeated START**. On the two exact tested profiles, errors 1/2 or 90 seconds without fresh HR clear the live value and schedule acquisition retry. The current retry delay is 3 seconds, plus watchdog scheduling and the bounded STOP/START operation; measured turnaround can be about 4 seconds before sensor warmup. Repeated errors must not keep postponing the first scheduled retry. Unknown profiles retain the diagnostic timeout/STOP/manual-retry path. This retry state is not a verified contact detector.

The initial implementation accepted only documented `0x1E` responses and retained `0x69/type6` as raw diagnostics. Experiment C showed that this missed the actual response on both rings. The correction accepts `0x69/type6` only when Realtime 6 is selected, with error byte 2 zero, valid checksum, and a nonzero unsigned BPM byte at offset 3, preserving packet source and freshness. This is packet validation, not a physiological plausibility or contact check. The [realtime-HR reference](https://colmi.puxtril.com/commands/#realtime-heart-rate) still supports parsing `0x1E` with HR at byte 1; it does not make `0x69/type6` invalid.

[RingCLI's constants](https://github.com/smittytone/RingCLI/blob/main/lib/colmi/commands.go) name type 6 continuous, and its poll loop avoids further continuation writes for that type. However, its actual [HR parser](https://github.com/smittytone/RingCLI/blob/main/lib/colmi/heartrate.go) and [CLI command](https://github.com/smittytone/RingCLI/blob/main/commands/data/heart.go) use type 1. Its stop warning is not universal: the local bounded tests above stopped both streams, allowing one trailing packet on the newer ring. Automatic selection matches the exact tested hardware and firmware; PhoneSport remains separate and unverified.

Current Gadgetbridge additionally implements standalone `0x1E`: [enable/disable and continuation](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/yawell/ring/YawellRingDeviceSupport.java#L358), and [byte-1 parsing](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L183). Its continuation is numeric `03`, every 30 received `0x1E` packets while enabled, including zero-valued packets. The earlier GitHub Colmi source was an older implementation; its absence of that mode does not describe current Gadgetbridge.

## Validation status

| Check | Status |
| --- | --- |
| Source research and firmware distinctions | Complete; references above. |
| Automated regression suite | Latest completed gate: `npm test` 52/52 pass, including parser/profile and automatic acquisition retry changes. Later session-storage changes need their own gate. |
| Browser | Corrected UI, automatic profile selection and simultaneous type-6 streams beyond three minutes verified. Removal clears the value and refitting resumed automatically in one trial; reliable off-body rejection failed in another. |
| TypeScript | Latest `npx tsc --noEmit --incremental false` gate passed. |
| ESLint | Latest scoped ESLint for changed TypeScript/TSX/tests passed. Earlier full `npm run lint` had 0 errors and one pre-existing unused-expression warning in `components/music-player.tsx:112`. |
| Production build | Latest `npm run build` passed after automatic retry changes. |
| Local Suno pause | Verified: generation POST and status GET both return 423 on localhost. Guards run before body/parameter processing, network calls, or database access. Keep disabled until the user asks to resume. |
| Continuous measurement on the user's physical rings | Experiments C/D verify separate captures and more than three minutes of simultaneous sensor-reported BPM. Physiological accuracy and indefinite stability are not established. |
| Older ring alone: Standard then Legacy R02 | Both produced 10-reading bursts after about 25 seconds. No Legacy advantage demonstrated. |
| Single CONTINUE plus 60-second grace | Recurring Standard bursts observed without recovery; approximately 40-second sample gaps remained. |
| Newer ring: uninterrupted type-6 stream | Corrected run: 221 sensor samples over 220.055 seconds, one START and no CONTINUE/recovery. |
| Simultaneous sensor samples from both rings | Verified for more than three minutes in the merged experiment-D captures. |
| Realtime 6 stop behavior | Verified in bounded separate captures; one 9 ms trailing packet after newer-ring STOP. |
| Removal/refit and off-body rejection | Automatic refit recovery observed on the newer ring; table false-positive reproduced twice on the older ring. Reliable wear detection is not accepted. |
| PhoneSport efficacy on the user's rings | Not tested or implemented as an acquisition mode. |

Passing software checks verifies command handling and state transitions, not optical sensor performance or support in a particular firmware.

Run the regression suite from `webapp` with `npm test`. The latest completed gate passed 87 tests. The suite does not contact Bluetooth hardware, Neon, or Suno; software results do not complete hardware checks. Full per-participant session storage, New Session while retaining BLE, and authorized testing-data cleanup are now completed; see [session verification](session-recording-verification.md).

## Remaining limits

- Upload queues are in memory. A reload loses unacknowledged data. Atomic database batches prevent partial inserts, but a lost HTTP acknowledgement after a successful commit can still cause duplicates on retry; server-side idempotency is a separate change.
- The existing HRV calculation is a proxy derived from sampled integer BPM; it is not measured beat-to-beat HRV. Missing SpO2/temperature are still replaced by defaults in the existing aggregate model. This work does not validate or redesign those metrics, which are not used to choose the song.
- Bluetooth writes acknowledged by the browser do not establish that this firmware implements CONTINUE as expected. The device trace is the deciding evidence.
- Status-zero sensor-reported BPM can occur off-body. No verified packet field currently distinguishes the captured false-positive readings from worn readings. Automatic retry does not establish contact.

## Remaining hardware experiments and acceptance checklist

Use **Connect ring** only for acquisition checks; no **Start Session** is needed. Suno generation and polling are locally blocked, and Start currently collects data only. Leave the pause enabled until the user explicitly asks to resume music generation. Keep the browser tab visible. Close or disconnect QRing and other clients that could already hold a BLE connection.

1. Connect one ring while wearing it normally. Record its displayed name, hardware/firmware revision if available, battery, and selected diagnostic mode. Allow the full initial warmup without CONTINUE; capture any error rather than assuming zero means success.
2. After the first valid value, leave the connection running for **at least three minutes**. Confirm that valid sample count passes 10 and keeps increasing **without a count-triggered command**. Record count, last-HR age, actual notification gaps, and any continuation/recovery events. A stable number such as 72 BPM is acceptable if new valid samples and timestamps keep arriving. Compare valid-sample gaps with baseline A; do not call the fix successful solely because a short burst appears.
3. Use **Show report** to inspect diagnostics and **Copy diagnostics** to save the trace. Capture another copy if values stop updating. Note the elapsed time and whether the ring was worn, moved, or disconnected. Do not use waveform motion as evidence of incoming samples.
4. Disconnect, reconnect, and repeat. Confirm a new warmup/freshness state rather than a stale prior BPM presented as live. Check that sampling does not accelerate from duplicate listeners and that no old-session retry writes appear after disconnection.
5. Repeat on the second ring, then connect both. Confirm each ring has independent counts, last-sample age, and recovery behavior. Disconnecting one should not stop the other.
6. Briefly remove and refit a ring. Confirm missing/invalid readings become visibly stale and recovery is observable. Do not count zero/error packets as valid samples. Save diagnostics before and after.

The sustained-stream portion is now demonstrated by experiment D. Remaining checks concern removal/refit reliability, off-body false positives, longer stability and regressions after further changes. No particular BPM variation or fixed sample rate is required. Record the user's known wear state separately; the sensor output alone cannot certify that state.

## Optional protocol A/B after the baseline

### Pending optical-quality investigation

[Edge Impulse's stock COLMI collector](https://github.com/edgeimpulse/example-data-collection-colmi-r02) provides a primary-source lead for raw optical acquisition. A [first-hand report for the newer revision](https://github.com/atc1441/ATC_RF03_Ring/issues/40) is another compatibility lead. Raw acquisition and a reliable on-finger classifier are not yet verified on the two local rings. Published raw STOP recipes differ across hardware families, so establish exact-revision start/stop behavior before any bounded experiment. No raw-mode command or firmware operation was sent during these tests. Raw data is a candidate for further investigation, not a demonstrated fix for table readings.

### Isolated optical diagnostic (after checkpoint `798091f`)

On the next user-confirmed setup (size 9 worn, size 11 on the table), the older ring again produced 32 status-zero positive HR frames, 85–87 BPM, from 13:54:26.060Z through 13:54:56.904Z on 2026-10-05. This followed a single initial type-6 START at 13:54:10.281Z, with no CONTINUE or recovery. Thus an off-body false positive does not require the automatic retry loop; initial acquisition can also produce it. Private trace: `optical-pre-table-person-2.json`. The browser still held an older controller instance; no raw command was sent before a full reload and reconnection request.

The diagnostic UI offers a bounded 15- or 30-second capture on the two exact known hardware/firmware profiles. It pauses ordinary measurement and retries, sends the selected HR STOP, waits for a quiet interval, and sends UART-only `A1 04 04`. Cleanup sends `A1 02` and observes for five seconds. A failed STOP or raw notifications more than two seconds after STOP closes the BLE connection. Normal HR remains paused until **Retry measurement**. No OTA service, firmware operation, health-logging setting, or unit setting is involved.

The full report retains timestamped raw frames, zero values, checksum validity and packet subtype in a separate bounded trace. Raw values do not become BPM, SpO2 percentages, contact classifications or session observations. `A1/02` field names and big-endian pair interpretations are research hypotheses, pending comparison on the local devices. The [original ATC writer](https://github.com/atc1441/atc1441.github.io/blob/main/ATC_RF03_Writer.html), [Edge Impulse collector](https://github.com/edgeimpulse/example-data-collection-colmi-r02/blob/main/ring.py) and [RT02R protocol notes](https://github.com/Nosh118/colmi-ring-tools/blob/main/docs/protocol.md) corroborate the stock diagnostic commands; this is not yet physical verification of these exact units.

Required hardware sequence: establish 15-second capture and STOP behavior on one ring; only then collect labeled worn-still, worn-moving, table and refitted blocks. Repeat any apparent separator across surfaces and lighting before using it to reject or admit measurements. Packet extrema do not establish a known aggregation window or validated signal-quality metric. Do not infer pulse timing from approximately 1 Hz snapshots or treat a positive raw number as proof of contact. Raw-plus-HR coexistence is a separate untested experiment.

Software gate for this diagnostic: 66/66 total tests pass (52 BLE, 14 existing recording/API tests), TypeScript and scoped ESLint pass, production build passes. No contact classifier has been accepted.

First physical raw trial, older ring on the table: START completed at 13:57:34.543Z on 2026-10-05; automatic STOP completed at 13:57:49.667Z and observation ended at 13:57:54.669Z. The trace has 48 valid 16-byte A1 frames, 16 each of subtypes 1/2/3. One trailing frame per subtype arrived within 284 ms of STOP; none arrived after the two-second grace. HR stayed paused with its sample count unchanged during the capture; the worn newer ring continued fresh HR updates. The older ring's bounded raw start/stop lifecycle is therefore physically verified once. Private trace: `optical-table-15s-person-2.json`.

For this table capture, A1/02 began with a zero then nonzero values near 11,662, while candidate maximum/minimum/difference fields stayed fixed at 11,770/11,590/180. Their arithmetic is consistent, but the fixed extrema do not establish a sliding quality window. Optical byte 10 was 1 on the table, so that value alone cannot prove skin contact. Each channel arrived approximately once per second. Subsequent worn comparisons and the newer-ring shutdown failure are documented below.

Worn older-ring comparison after the laptop reopened: 90 valid raw frames during the 30-second capture starting 16:53:16.891Z on 2026-10-05. STOP completed at 16:53:47.053Z and the five-second observation completed without a late-stream error. Subtype-2 extrema/difference were still exactly 11,770/11,590/180, while current values mostly fell below that supposed minimum (11,453–11,560 after the first retained value; the last frame was zero). Subtype-1 current values were mostly 174–182, while its other fields stayed 164/109/131. The first raw pair reproduced the prior table values after almost three hours. These observations rule out treating these fields as verified contemporaneous quality bounds; stable bytes 10–14 did not distinguish the two labels. The following trials repeat the table capture under the current conditions.

The next two older-ring captures (`optical-table-repeat-30s-person-2.json`, `optical-box-30s-person-2.json`) each produced 90 frames and completed STOP observation successfully. After the first retained frame, subtype-1 current values were 126–127 on the table and 135 on the ring's box; subtype-2 current values were 11,681–11,690 and 11,718–11,731 respectively. The user identified the latter surface as the box, not paper; its color/material was not established. These are single labeled captures and do not validate thresholds across users, surfaces or lighting. After the worn capture, the user removed the ring and confirmed its green light was off while the app was paused, before the repeated table capture began.

### Newer-ring optical shutdown failure

The repeated older-ring worn capture (`optical-worn-repeat-30s-person-2.json`) produced 90 frames. The first newer-ring worn optical capture (`optical-worn-15s-person-1.json`) produced 45 frames, and its A1 notifications stopped after the documented raw STOP. However, the user then observed the newer ring continuing to flash red and green despite the completed packet observation. A subsequent ordinary Disconnect, including type-6 STOP, did not extinguish those lights. Placing the ring on its charger stopped the flashing; the user confirmed it stayed off for 15 seconds after removal from the charger, disconnected and on the table.

**Notification cessation does not establish sensor shutdown.** Optical diagnostics are now blocked for `RT02R_V3.1`, independently of the verified continuous-HR profile. The new regression verifies no raw command is sent for that profile. No newer-ring off-body optical trial was performed. The UI now describes capture completion and asks the operator to check the lights, rather than claiming physical sensor shutdown. No firmware change, factory reset, log-setting change or alternative speculative opcode was used.

The newer worn capture had different scales and fixed metadata: subtype-1 current values mainly 112–129, fixed fields 139/46/93; subtype-2 mostly 5,881–5,984 with outliers, fixed fields 6,885/6,275/610. Subtype-2 byte 10 was zero while worn, unlike the older ring's one in both worn and table captures. Neither a shared numeric threshold nor that byte is validated as a wear detector. All raw evidence remains diagnostic-only.

### Battery freshness and laptop sleep

The user reports the older ring displayed 99% for hours before the laptop closed and reported 58% on reconnect about three hours later. Code inspection confirmed battery opcode `03` was requested only during connection, without periodic refresh or displayed reading age. Thus the original 99% was not a continuously refreshed measurement, and the two observations cannot establish when discharge occurred. The new 58% is a device-reported value, not an application estimate. Do not claim a battery fault or that the device remained active during sleep without evidence. The earlier simultaneous BLE loss is now explained by the user's laptop closure. Abrupt host sleep cannot be assumed to deliver an asynchronous STOP.

The connected card now requests battery approximately once per minute through the existing per-ring write queue, and diagnostics offer **Refresh battery**. Each valid battery response sets its own acquisition timestamp; the UI shows its age. Requests are skipped during optical capture/cleanup. Invalid battery packets and failed battery queries retain the previous battery value/age and do not invalidate HR or create HR observations. A hung battery write is bounded to three seconds and closes the stalled GATT connection; a late completion cannot start an abandoned connection's HR stream. The updated gate passes 71 tests, TypeScript and scoped ESLint. Physical periodic-refresh verification is documented below.

Physical periodic-refresh verification passed on both worn rings on 2026-10-05. Reports `battery-continuous-verification-person-1.json` and `battery-continuous-verification-person-2.json` are retained privately. Three consecutive automatic requests approximately 60 seconds apart received valid responses on each ring. The newer ring repeatedly returned `03 64 00 ... 67` (100%, not charging) at 17:13:41.430Z, 17:14:41.783Z and 17:15:42.621Z. The user reports that its display has remained at 100% after hours of use. These fresh responses establish that the current 100% originates in the device rather than a stale UI value; they do not establish actual remaining capacity or the reason for the unchanged estimate. The brief charger intervention earlier in this test is an additional confounder for discharge comparisons.

The older ring returned 53%, 53%, then 52%; an unsolicited `73 0c 34` also preceded its queried 52% response. That unsolicited format is recorded but not yet parsed by the app. During the retained roughly three-minute event windows, both HR streams continued with maximum gaps of 1.317 seconds and 1.439 seconds respectively. Both had one START, zero CONTINUEs, zero restarts and no battery errors. Thus battery refresh did not interrupt continuous HR in this trial. No firmware operation was performed.

Battery decoding investigation after the user questioned firmware differences: [the RT02R/RT02CR 3.1 client](https://github.com/Nosh118/colmi-ring-tools/blob/main/site/src/ringBle.ts), `probeBattery`, sends opcode `03` and reads percentage directly from byte 1, matching our parser. Its charging decoder accepts any nonzero byte 2, whereas ours currently checks 1; every captured battery response in this comparison has byte 2 equal to zero, so this difference cannot explain the 100%. [An exact-profile stock-firmware report](https://github.com/atc1441/ATC_RF03_Ring/issues/40) also reports working standard battery commands. Neither source establishes the accuracy of this individual ring's battery gauge.

An offline audit of retained reports found seven unique battery responses for the newer unit through 17:15Z, all 100%; the earliest was 11:59:01.918Z (14:59 Athens), before the later charger intervention. This is sparse evidence, not continuous monitoring of the intervening hours. A later live report, `battery-firmware-audit-person-1.json`, adds fresh identical responses at 17:21:45.974Z, 17:22:46.331Z and 17:23:46.572Z. Replaying the literal `03 64 00 ... 67` through our actual parser returns 100%, not charging, with a valid checksum; `64` is hexadecimal for decimal 100. No alternate byte containing a plausible percentage is present. The older unit's query responses and unsolicited battery events continued decreasing. There is currently no evidence for changing percentage decoding on the newer profile; an independent QRing comparison has been requested to distinguish application/protocol differences from device-reported gauge behavior. Root cause remains unresolved. No firmware or reset commands were sent.

### Session and database requirements completed

Full per-participant session recording and New Session are implemented and verified against the real rings and existing database. New Session preserves both Bluetooth connections. The authorized testing-data cleanup removed all 67 sessions, 8,883 readings and 46 song rows while retaining schema and sequences, after test uploads finished. See [session-recording-verification.md](session-recording-verification.md) for the automated, browser and real-database evidence. Suno remains paused; song-ready behavior is verified by automated tests, not a paid song generation.

### Further measurement comparisons

### Faster contact recovery — 2026-10-06

The verified type-6 profiles now trigger their existing bounded STOP/START immediately on error 2, which ended the captured removal error sequences. Repeated error-1 frames retain the original fallback deadline if error 2 is absent. Known contact errors received during an in-flight recovery no longer cancel that recovery or enqueue another restart. Passive observation still suppresses all recovery commands. This changes restart scheduling, not the firmware's acquisition algorithm or off-body validation.

Physical validation on size 9: first error 1 at 09:19:25.067Z, final error 2 at 09:19:26.493Z, STOP at 09:19:26.513Z and START at 09:19:26.530Z. START followed the final error by 37 ms; the previous three-second deadline checked every two seconds would have waited until approximately 09:19:29.067Z (about 2.54 seconds later). First fresh BPM arrived at 09:19:42.713Z, 16.183 seconds after START, followed by a continuing stream with one recovery and no CONTINUE. The user estimated 10–12 seconds from physical refitting; that instant was not instrumented and is distinct from command-to-first-sample latency. Private trace: `fast-contact-recovery-size9-2026-10-06.json`. Size 11 was charging and was not physically retested. All 93 current tests, TypeScript and scoped lint passed. Firmware and raw optical mode were not changed.

Newer-ring passive comparison: only size 9 (`R02_AF03`, `RT02R_V3.1` / `RT02R_3.11.00_250611`) was connected. The user explicitly confirmed both rings off, then both worn; size 11 was disconnected before observation. Four error-1 frames beginning 18:02:08.237Z were followed by error 2 at 18:02:10.409Z. HR count stayed at 64 with no recovery commands. Refit confirmation was recorded at 18:03:04.787Z; no HR resumed during the following approximately 49 seconds before the bounded STOP at 18:03:54.247Z. An unsolicited `73/12` frame near refit is not a validated contact flag; this format was also present in earlier traces. No START, CONTINUE or battery query was sent during observation. Private evidence: `passive-size9-confirmed-both-off.json`, `passive-size9-confirmed-refit-complete.json`, `passive-size9-labels.json`. Manual Retry followed while worn. Together, the two corrected trials do not support disabling retries as a sufficient solution for rapid automatic refit recovery. Neither trial establishes a reliable general wear classifier. Final automated suite: 90/90 tests pass; TypeScript, scoped lint and production webpack build passed.

Correctly labeled passive repeat: only size 11 was connected. The user explicitly confirmed both rings on the table, then both worn, removing ambiguity about which ring moved. Observation ran from 17:56:00.761Z to bounded STOP at 17:58:00.960Z. Four error-1 frames from 17:56:17.444Z preceded error 2 at 17:56:19.064Z. HR count remained 101 throughout the off-body interval and through the approximately 21 seconds remaining after refit confirmation. No automatic START/CONTINUE or battery queries occurred during observation. There was no quick spontaneous refit recovery within this window; a longer recovery time is not ruled out. This single run cannot prove reliable off-body rejection across surfaces. Private traces: `passive-size11-confirmed-both-off.json`, `passive-size11-confirmed-refit-complete.json`. Manual Retry was issued after expiry while the ring was worn.

A bounded **Observe without retries (120s)** diagnostic now isolates native firmware behavior after removal/refitting. It can start only on an already healthy verified realtime profile, sends no START or raw command, suppresses automatic retries and battery queries, and keeps incoming error/HR frames in the normal report. Contact errors clear displayed HR without issuing recovery commands. At 120 seconds (or manual Stop observation) it sends the normal HR STOP and stays paused until manual Retry; a hung STOP closes GATT. Disconnect cancels the timer, and mode changes, optical captures and retries are blocked while observing. Software regressions cover error/refit packets without intervening writes, timeout, reconnect cancellation and hung STOP. This is an experiment, not an accepted wear detector.

**Invalidated physical labels:** During the passive trial beginning 17:52:16.583Z on 2026-10-05, the connected device was size 11. It emitted four error-1 frames and one error-2 frame, then no further HR before bounded STOP at 17:54:16.665Z. No recovery command was sent during observation. Initially the user reported removing/refitting size 11, but subsequently corrected this: size 11 remained worn and they had removed size 9 instead. Therefore this trial is NOT evidence of size-11 removal, off-body rejection, or failed spontaneous refit recovery. Those earlier conclusions are withdrawn. The capture only establishes errors and subsequent silence while the user now reports size 11 worn; cause is unresolved. The files retain their original historical names but their wear labels are invalid: `passive-size11-table.json`, `passive-size11-refit-complete.json`. The corrected single-ring repeat is documented above. The user explicitly confirmed the mix-up applied only to this immediately preceding passive trial; earlier labeled trials are not withdrawn.

The corrected Realtime 6 UI and three-minute dual-ring run have passed the sustained-stream check. Preserve that behavior while separately investigating off-body reliability and testing later storage/session changes. Standard versus Legacy already produced the same short-burst pattern; further batched-mode comparisons are optional unless type 6 fails on a different revision.

Do not change measurement modes during a healthy type-6 stream. If a comparison with standalone `0x1E` or QRing becomes necessary, perform it as a separate coordinated run with one client connected. The observed type-6 response is already `0x69/type6`; no additional `0x1E` command is needed to produce the captured stream.

PhoneSport requires a separate implementation and validation of notification fields against an independent contemporaneous HR reading before labeling any field BPM. **Do not flash, OTA-update, or otherwise change firmware.** A sports tick must not be assumed to be a physiological sample.

The superseded research remains in [COLMI_BLE_FINDINGS.md](../webapp/COLMI_BLE_FINDINGS.md), clearly labeled historical. Its old opcode tables and copy-paste packets are not authoritative.
