# Ring measurement audit

Date: 2026-10-05. Scope: maintain live HR measurements and make their freshness observable. The animated waveform stays unchanged; it is not a raw physiological trace.

**User constraint: never flash, update, or replace either ring's firmware.** No firmware flash, OTA, or update has been attempted. Work is limited to the browser application and measurement commands.

**Local test pause:** Suno calls are disabled and must remain disabled until the user explicitly requests resumption. The ignored `.env.local` contains `SUNO_DISABLED=true` and `NEXT_PUBLIC_SUNO_DISABLED=true`; no other secrets were changed. Server guards reject generation and status polling with HTTP 423 before body/parameter processing, network calls, or database access. The UI shows the pause and Start collects ring data only. Live localhost checks confirmed that both `POST /api/generate` with `{}` and `GET /api/generate/ring-test-gate` return 423 with `Music generation paused for ring tests`.

## Findings and selected correction

**Latest physical evidence:** after correcting the `0x69/type6` parser and automatically selecting Realtime 6 for the two exact tested profiles, both rings streamed sensor-reported BPM together for more than three minutes, at roughly one frame per second. The user confirmed both worked. Automatic retry after measurement errors also resumed after refitting, but a separate confirmed table test produced false-positive BPM. Continuous acquisition is demonstrated; reliable wear detection is not. This is realtime HR, not PhoneSport. Further session-storage work is pending and this audit does not declare the whole project complete.

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

Run the regression suite from `webapp` with `npm test`. The latest completed gate passed 52 tests. The suite does not contact Bluetooth hardware, Neon, or Suno; software results do not complete hardware checks. Full per-participant session time-series storage, a fresh session after a track reset while keeping BLE connections, and final test-data cleanup were requested but are **deferred and not implemented** in this checkpoint.

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

### Deferred session and database requirements

- Persist the full per-participant session time series in the existing application database, independently of the first 30-second song snapshot window.
- Offer a new-session action after completion/song readiness that resets session/music state while keeping both BLE connections alive.
- After implementation and validation, delete the existing testing data from the configured Suno application database while preserving its schema. The user explicitly authorized this final cleanup; it has not been executed. Read-only inspection found exactly three application tables: `sessions`, `biometric_readings`, and `generated_songs`.
- Drain or clear test upload queues before cleanup so pending retries cannot recreate deleted testing data.

### Further measurement comparisons

The corrected Realtime 6 UI and three-minute dual-ring run have passed the sustained-stream check. Preserve that behavior while separately investigating off-body reliability and testing later storage/session changes. Standard versus Legacy already produced the same short-burst pattern; further batched-mode comparisons are optional unless type 6 fails on a different revision.

Do not change measurement modes during a healthy type-6 stream. If a comparison with standalone `0x1E` or QRing becomes necessary, perform it as a separate coordinated run with one client connected. The observed type-6 response is already `0x69/type6`; no additional `0x1E` command is needed to produce the captured stream.

PhoneSport requires a separate implementation and validation of notification fields against an independent contemporaneous HR reading before labeling any field BPM. **Do not flash, OTA-update, or otherwise change firmware.** A sports tick must not be assumed to be a physiological sample.

The superseded research remains in [COLMI_BLE_FINDINGS.md](../webapp/COLMI_BLE_FINDINGS.md), clearly labeled historical. Its old opcode tables and copy-paste packets are not authoritative.
