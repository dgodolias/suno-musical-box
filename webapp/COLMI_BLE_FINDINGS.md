# Colmi BLE protocol: current evidence and historical notes

## Current correction — 2026-10-05

**Use this section and [the measurement audit](../docs/ring-measurement-audit.md) for implementation decisions. Everything under "Historical notes" below is retained as an unverified research log; contradictory claims there are not requirements or verified behavior.** The corrected `0x69/type6` parser and exact-profile selection now deliver roughly 1 Hz sensor-reported BPM from both rings simultaneously for more than three minutes. The user confirmed both worked. Automatic retry after refitting has also worked, but confirmed table tests produced false-positive BPM: continuous acquisition is demonstrated; reliable wear detection is not. Later session-storage work is separate and not yet accepted.

**User constraint: never flash, update, or replace ring firmware.** No flash, OTA, or firmware update has been attempted. Only application changes and measurement commands are in scope. The animated waveform remains unchanged.

**Local test pause:** Suno calls are disabled and must stay disabled until the user explicitly asks to resume. The ignored `.env.local` has `SUNO_DISABLED=true` and `NEXT_PUBLIC_SUNO_DISABLED=true`; no other secrets were changed. Generation and status guards run before body/parameter processing, network calls, or database access. Live localhost checks confirmed 423 with `Music generation paused for ring tests` for both `POST /api/generate` with `{}` and `GET /api/generate/ring-test-gate`. The UI displays the pause; Start collects ring data only.

### Hardware baseline supersedes the 10-sample assumption

On 2026-10-05, the first ring (`RT02R_V3.1`, firmware `RT02R_3.11.00_250611`) returned its first valid HR about 27 seconds after START, with incoming HR frames at approximately 2 Hz. In the initial implementation, every automatic CONTINUE after 10 valid samples was immediately followed by roughly 25 seconds of zero-valued frames. This repeatedly produced short valid bursts separated by warmup-like gaps. The timing is a strong correlation; the uninterrupted comparison is still needed before attributing causation or claiming a fix.

The second ring (`R02_V3.0`, firmware `R02_3.00.17_240903`) initially returned only zero-valued acknowledgements under repeated CONTINUE during warmup. **Experiment B superseded that initial result:** tested alone with uninterrupted warmup, both Standard and Legacy R02 produced HR, but only in short bursts. The user confirmed both rings were worn and had green LEDs; battery was reported at 100%. Later Standard captures had cumulative counts of 70/34 sensor samples and 6/4 CONTINUE commands, with one START and no recovery on either ring. Retained frames showed roughly 40-second sample gaps. This established recurring samples from both; corrected Realtime 6 later established sustained simultaneous streams. This summary intentionally omits raw personal traces and device identifiers.

In Standard mode, START at `12:13:55.760` produced its first valid HR at `12:14:21.286` (about 25.5 seconds later). Exactly 10 readings arrived at approximately 2 Hz, with values 84-88 BPM and the last at `12:14:25.558`, then silence. CONTINUE at `12:14:36.130` returned a zero acknowledgement; further CONTINUE at `12:14:47.773` and `12:15:00.021` produced no valid HR. STOP/START at `12:15:12.338` recovered another 10-reading burst beginning at `12:15:38.351`. Legacy R02 START at `12:16:51.283` also yielded 10 valid readings after about 25 seconds, then silence. These are session diagnostic times on 2026-10-05. Both variants can measure; no Legacy advantage or automatic Legacy firmware mapping is established.

### Type-6 hardware evidence supersedes the raw-only parser

Separate physical runs sent `69 06 01`, then `6A 06` after the initial diagnostic's false 90-second timeout. Neither interval contained CONTINUE or restart. Independent capture analysis verified frame length, checksum, error byte 2 equal to zero, and the measurement at byte 3:

| Exact hardware / firmware | Positive HR frames | Timing | STOP observation |
| --- | --- | --- | --- |
| `R02_V3.0 / R02_3.00.17_240903` | 72; 80-89 BPM; zero checksum failures | Warmup 19.243 s; positive span 70.470 s; median gap 0.970 s, maximum 1.455 s | No further type-6 HR through report generation 65.490 s after STOP. |
| `RT02R_V3.1 / RT02R_3.11.00_250611` | 76; 75-84 BPM; zero checksum failures | Warmup 15.054 s; positive span 75.002 s; median gap 0.966 s, maximum 3.229 s | One trailing frame 9 ms after STOP; no later type-6 HR through report generation 88.366 s afterward. |

The old UI counters did not include these values; its timeout was a parser defect, not absent incoming data. The detailed UTC timeline is in [experiment C](../docs/ring-measurement-audit.md#hardware-experiment-c-type-6-stream-on-each-ring). These observations establish bounded continuous streams and stopping on the two exact revisions, not indefinite stability or physiological accuracy. No raw personal captures or device identifiers are committed.

After correction, merged and deduplicated checkpoints established simultaneous streams for more than three minutes. The newer ring produced **221 sensor samples over 220.055 s** (median gap 0.9705 s, maximum 2.823 s), with one START and no CONTINUE/recovery. The older ring produced **189 samples over 187.127 s** after manual retry (median gap 0.9675 s, maximum 2.808 s), again with no further command during the healthy interval. Its cumulative total of 213 includes 24 before intentional removal. Both final reports were measuring without a current error and had sample age below 1.3 seconds. See [experiment D](../docs/ring-measurement-audit.md#hardware-experiment-d-corrected-simultaneous-streams). Counts refer to structurally valid sensor reports, not independently validated physiology; that run's recovery was manual.

### Removal/refit: acquisition retry is not reliable wear detection

Intentional removal of either ring produced `69 06` errors 1/2. The new retry path clears the displayed BPM to `--`, preserves the connection and retries acquisition. Automatic return after refitting the newer ring was physically observed after approximately 15 seconds of sensor warmup. However, an older-ring table capture recorded **45 status-zero sensor reports of 88-90 BPM** after automatic START at `13:20:06.033`, while the user confirmed it was off-body. The positive interval was `13:20:25.366`–`13:21:08.948` UTC; bytes 4-14 were zero and packet patterns matched worn readings. A later off-body start stayed correctly empty, but a second controlled wear/remove trial reproduced the failure: START at `13:29:07.878` yielded **61 reports of 87-89 BPM** from `13:29:27.092` through `13:30:26.866` while on the table. Reliable automatic wear detection is therefore **not accepted**; recovery policy and deeper raw-optical/combined-signal research remain unresolved. Green LEDs restarting in these trials reflect app retries, not proof of refitting.

No dedicated worn/refitted signal is verified for these revisions. [Current Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L142) treats status 1 as worn incorrectly and status 2 as temporary/missing data. Neither status zero, a zero-valued START response, nor positive BPM proves skin contact. The [command catalog](https://colmi.puxtril.com/commands/) supplies no wear/contact command. R08's [SDK-derived `73/2A` event](https://github.com/MRziyi/Halo-Ring/blob/main/Doc/09-r08-ble-protocol-spec.md#52-sub-id-table) is a touch-disabled settings echo/charger event, not verified on-finger detection; `73/3F` is ECG electrode state. No speculative contact commands were sent.

### Measurement selection and retained Standard flow

Automatic Realtime 6 selection is restricted to the exact tested hardware/firmware pairs above and was verified after reconnect. Other revisions retain the Standard flow. Standard uses type-1 START `69 01 01` and STOP `6A 01`. **Do not send CONTINUE merely because 10 samples arrived.** CONTINUE `69 01 03` is reserved for at least 10 seconds of HR-notification silence, and only after at least one valid HR sample in the current measurement. After that one continuation, leave **60 seconds of grace before bounded recovery** instead of repeatedly continuing during reacquisition. Initial warmup also gets 60 seconds without CONTINUE. A healthy stream is left alone. These are packet prefixes, not complete BLE frames: zero-pad to 15 bytes and append `sum(bytes[0..14]) & 0xFF`. Packet arrival frequency does not establish the rate of independent physiological estimates.

A manual diagnostic choice, **Standard** versus **Legacy R02**, remains available. Standard starts with `69 01 01`; Legacy R02 starts with `69 01 00`. Switching issues STOP, waits 2 seconds, then issues the selected START and leaves warmup uninterrupted. The zero-action variant is used by [Gadgetbridge's `onHeartRateTest()`](https://github.com/Freeyourgadget/Gadgetbridge/blob/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/colmi/ColmiR0xDeviceSupport.java), whose [supported firmware list](https://gadgetbridge.org/gadgets/wearables/colmi/) includes `3.00.17`. The local comparison found no Legacy benefit; no automatic Legacy or sports fallback is enabled. The new exact-profile type-6 choice is justified by the separate captures above.

- [RingCLI's polling implementation](https://github.com/smittytone/RingCLI/blob/main/lib/ble/ble.go) requests continuation after 10 type-1 readings; its [packet builders](https://github.com/smittytone/RingCLI/blob/main/lib/colmi/packet.go) support the command prefixes. The live baseline above invalidates treating its batch rule as a universal requirement.
- [The Colmi protocol reference](https://colmi.puxtril.com/commands/#data-request) defines type 1 as HeartRate, type 6 as RealtimeHeartRate, and actions 1/2/3/4 as start/pause/continue/stop. Type 5 is HealthCheck, not a documented stress value.
- [Current Python `real_time.py`](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/real_time.html) contains both `get_continue_packet()` (`69/type/3`) and a legacy `CONTINUE_HEART_RATE_PACKET` (`1E/33`, ASCII `"3"`). Its [current client](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/client.html) collects six values and stops; it does not call either continuation path. The older claim that all Python clients use the same continuation sequence is unsupported.
- A repeated numeric BPM is still a new measurement when a new valid packet arrives. Preserve sample counts and receive timestamps independently of value changes. Zero/error packets and unrelated battery/accelerometer traffic must not refresh the last valid HR timestamp.

### Validation status after type-6 parser and exact-profile correction

Latest completed regression gate: **52/52 pass**, including parser/profile and acquisition-retry changes. TypeScript (`npx tsc --noEmit --incremental false`), production build and scoped lint for changed TypeScript/TSX/tests also passed. The earlier full `npm run lint` reported **0 errors** and one pre-existing unused-expression warning in `components/music-player.tsx:112`. Both local API pause checks returned 423 as described above. Later storage/session changes require a new gate.

Corrected UI counts, automatic profile selection and more than three minutes of simultaneous streams are verified. The earlier browser blockage is superseded. Automatic acquisition retry worked after refitting but failed reliable off-body rejection twice; do not equate sensor-positive packets with wearing the ring. Standalone `0x1E` remains untested. Full per-participant session time-series storage, a new session after track reset while retaining BLE, and test-data cleanup were requested but are **deferred and not implemented** in this checkpoint. See [the audit checklist](../docs/ring-measurement-audit.md#remaining-hardware-experiments-and-acceptance-checklist). Use **Connect ring**, then **Show report** / **Copy diagnostics** for acquisition checks; no Start Session is needed. Suno stays blocked until the user asks to resume.

### Continuous HR and sports are distinct

Type 6 is a documented measurement type, not a camera action. [RingCLI's constants](https://github.com/smittytone/RingCLI/blob/main/lib/colmi/commands.go) call it continuous HR but warn about stopping. Our bounded captures now establish working `69 06` streams and stopping on both exact local revisions, with one trailing newer-ring packet. On a different R08 firmware, `RT08_3.10.46_250621`, [Halo-Ring](https://github.com/MRziyi/Halo-Ring/blob/main/Doc/09-r08-ble-protocol-spec.md) did not obtain the expected stream. Neither that failure nor our success generalizes to every ring.

**Realtime 6** uses START `69 06 01`, STOP `6A 06`, with **no CONTINUE or repeated START during healthy streams**. Mode switching stops the previous type, waits 2 seconds, then starts the selected type. On the two exact tested profiles, errors 1/2 or 90 seconds without fresh HR clear the displayed value and currently schedule retry after 3 seconds plus watchdog/STOP timing (around 4 seconds before sensor warmup in the captured case). Other profiles retain timeout/STOP/manual retry. This is acquisition recovery, not a dedicated wear detector, and its policy remains under review after confirmed off-body false positives.

The corrected response path accepts `0x69/type6` only in the selected realtime mode, requires error byte 2 to be zero and a valid checksum, and validates byte-3 BPM. This follows the generic structure used by current Gadgetbridge's [unfiltered `0x69` dispatch](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/yawell/ring/YawellRingDeviceSupport.java#L355) and [byte-3 HR parser](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L142), combined with the type-6 enum and actual traces. [Tahnok's generic parser](https://tahnok.github.io/colmi_r02_client/colmi_r02_client/real_time.html#parse_real_time_reading) corroborates the offsets but excludes type 6 from its enum. Puxtril has no generic `DataResponse` structure; its [documented `0x1E` response](https://colmi.puxtril.com/commands/#realtime-heart-rate), with HR at byte 1, is not proof that every type-6 response uses `0x1E`.

Current Gadgetbridge also implements **standalone `0x1E` realtime HR**, separately from type 6: numeric `1E 01` start, `1E 03` continuation every 30 received `0x1E` packets while enabled, and `1E 02` stop. See its [current Codeberg implementation](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/service/devices/yawell/ring/YawellRingDeviceSupport.java#L358) and [byte-1 parser](https://codeberg.org/Freeyourgadget/Gadgetbridge/src/branch/master/app/src/main/java/nodomain/freeyourgadget/gadgetbridge/devices/yawell/ring/YawellRingPacketHandler.java#L183). Earlier claims based on the old GitHub Colmi mirror that Gadgetbridge lacks realtime HR are superseded. Standalone `0x1E` has not been tested on our rings, and no such command was required for the captured `69 06` streams.

Phone-sport is a separate protocol: `77 01 <sportType>` starts a session, `77 04 <sportType>` stops it, and `78` carries notifications. [Halo-Ring documents captured R08 traffic and firmware-specific layouts](https://github.com/MRziyi/Halo-Ring/blob/main/Doc/09-r08-ble-protocol-spec.md#48-phone-sport-session-0x77--0x78), with matching [Kotlin builders](https://github.com/MRziyi/Halo-Ring/blob/main/app-project/core/src/main/kotlin/com/halo/ring/core/ble/R08Protocol.kt). Its roughly per-second session ticks do **not** establish per-second fresh BPM: the HR-looking field remains an open interpretation in the detailed report. This mode needs separate parsing and validation on our devices before use.

### Corrections to older claims

- `0x1E` is documented as realtime heart rate; it is not established here as HRV history. [The command reference](https://colmi.puxtril.com/commands/) documents HRV history at `0x39` and periodic HR settings at `0x16`. Do not use the historical command tables below as an opcode catalog.
- The 16-byte frame rule applies to the primary command channel. The secondary Big Data channel has [a different framing protocol](https://colmi.puxtril.com/bigdata/). It is not inherently "the raw sensor service"; the original research log conflates these paths.
- Nonzero bytes outside the HR value field are not a second BPM reading. The historical claim that bytes 6–7 are universally raw PPG, with a fixed mutually exclusive relationship to BPM, is not established across firmware. Preserve raw frames for investigation instead of assigning undocumented semantics.
- Hardware and firmware vary even within the same marketed model. [RingCLI records R02/RY02 variants](https://github.com/smittytone/RingCLI#important-note-on-firmware-variants); [Gadgetbridge explicitly scopes support to QRing-compatible hardware](https://gadgetbridge.org/gadgets/wearables/colmi/). Record GATT hardware (`0x2A27`) and firmware (`0x2A26`) revisions where available. Do not assume R02, R03 and R06 are identical.
- Charging behavior, warmup times, LED meanings, initialization requirements, and raw-sensor layouts in the old log are device-specific or unverified. Do not treat its absolute statements, completeness claims, or novelty claims as evidence.
- Integer BPM samples are not beat-to-beat intervals. Their variation must not be represented as validated physiological HRV/RMSSD.

## Historical notes — retained, unverified, superseded by the correction above

The following is the original research log. It contains contradictory conclusions and incorrect packet/opcode examples. It is preserved for traceability, not for copying commands or deciding implementation behavior.

### Original title: Colmi R02 BLE Protocol — Complete Research Findings

## BLE Service & Characteristics

| UUID | Purpose |
|------|---------|
| `6e40fff0-b5a3-f393-e0a9-e50e24dcca9e` | Primary UART service |
| `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | RX (write commands to ring) |
| `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | TX (receive notifications from ring) |
| `de5bf728-d711-4e47-af26-65e3012a5dc7` | Secondary data service (raw sensors) |

## Packet Format (ALL packets)
- **16 bytes fixed**
- byte[0] = command ID
- bytes[1-14] = payload (14 bytes)
- byte[15] = checksum = `sum(bytes[0..14]) & 0xFF`

## Commands

| Command | Dec | Hex | Purpose |
|---------|-----|-----|---------|
| START_REAL_TIME | 105 | 0x69 | Start/continue real-time measurement |
| STOP_REAL_TIME | 106 | 0x6A | Stop real-time measurement |
| RAW_SENSOR | 161 | 0xA1 | Raw sensor streaming (PPG, accel, SpO2) |
| HR_LOG_READ | 21 | 0x15 | Read stored HR history |

## Action Values (byte[2] in CMD 0x69 payload)
- 1 = START
- 2 = PAUSE  
- 3 = CONTINUE (CRITICAL: must send every ~10 readings to keep stream alive)
- 4 = STOP

## Reading Types (byte[1] in CMD 0x69 payload)
- 1 = HEART_RATE (batch mode)
- 2 = BLOOD_PRESSURE
- 3 = SPO2
- 4 = FATIGUE
- 5 = STRESS
- 6 = HEART_RATE (continuous mode — stopping is unreliable)
- 10 = HRV

---

## Real-Time Heart Rate — CORRECT Protocol

### Step 1: START
```
Send: [0x69, 0x01, 0x01, 0x00 × 12, checksum]
       cmd   type  START  padding       
```
Checksum = `(0x69 + 0x01 + 0x01) & 0xFF` = `0x6B`

### Step 2: WAIT for data (2-30 seconds)
Ring responds with notifications:
```
Response: [0x69, 0x01, 0x00, HR_VALUE, 0x00 × 10, checksum]
           cmd   type  err   HR(bpm)   padding
```
- byte[3] = 0 means sensor still calibrating (NORMAL, keep waiting)
- byte[3] = 40-200 means valid HR reading

### Step 3: CONTINUE (every ~10 readings or ~30 seconds)
```
Send: [0x69, 0x01, 0x03, 0x00 × 12, checksum]
       cmd   type  CONT   padding
```
**CRITICAL**: This is the SAME command (0x69), NOT 0x1e!
The RingCLI source confirms: `COMMAND_START_REAL_TIME = 0x69` with `ACTION_CONTINUE = 0x03`

### Step 4: STOP
```
Send: [0x6A, 0x01, 0x00 × 13, checksum]
       cmd   type   padding
```

---

## When byte[3] = 0 with bytes[6-7] non-zero

Pattern observed:
```
69 01 00 00 00 00 2c 02 00 00 00 00 00 00 00 98  ← byte[3]=0, bytes[6-7]=0x2c,0x02
69 01 00 58 00 00 00 00 00 00 00 00 00 00 00 c2  ← byte[3]=0x58=88, bytes[6-7]=0
```

**Finding**: bytes[6-7] contain raw PPG sensor data WHILE the ring is calibrating.
Once HR locks on (byte[3] > 0), bytes[6-7] become 0. They are MUTUALLY EXCLUSIVE.
**bytes[6-7] are NOT usable as HR values.**

---

## Raw Sensor Streaming (0xA1) — Alternative data path

### Enable raw sensors:
```
Send: [0xA1, 0x04, 0x00 × 13, checksum]
```

### Disable raw sensors:
```
Send: [0xA1, 0x02, 0x00 × 13, checksum]
```

### Response subtypes:
| Subtype (byte[1]) | Data |
|-------------------|------|
| 0x01 | Raw SpO2: `(byte[2]<<8)\|byte[3]`, max=byte[5], min=byte[7] |
| 0x02 | Raw PPG: `(byte[2]<<8)\|byte[3]`, max=`(byte[4]<<8)\|byte[5]`, min=`(byte[6]<<8)\|byte[7]` |
| 0x03 | Accelerometer: Y=`(byte[2]<<4)\|(byte[3]&0xF)`, Z=`(byte[4]<<4)\|(byte[5]&0xF)`, X=`(byte[6]<<4)\|(byte[7]&0xF)` (12-bit each) |

---

## LED Behavior
- **Green flashing** = HR measurement active (PPG green LED sensor)
- **Red solid** = SpO2 mode or charging
- **Red flashing** = charging
- **Green solid** = fully charged
- **No LED** = battery dead or sleeping
- LED stays on when skin detected, off when removed from finger

## Charging
- Battery: 17mAh polymer lithium
- Charge time: < 1 hour
- Must reach green LED (full) before first use from factory
- Ring auto-shuts down at critical battery — must charge to wake

## Warmup Timing
- 2-5 seconds: sensor starts, LED activates
- 5-15 seconds: first zero readings (byte[3]=0, bytes[6-7] active)
- 15-30 seconds: HR locks on (byte[3] > 0)
- Some rings/positions take up to 60 seconds

## Finger Position
- Sensor on PALM-FACING side (not nail side)
- Snug fit required
- Index or middle finger best
- Don't move during measurement
- Thumb/pinky = poor contact, unreliable

## Two BLE Services
Some rings expose a secondary service:
- `de5bf728-d711-4e47-af26-65e3012a5dc7` (for raw sensor data)
- Used by Edge Impulse and smartringmidi projects
- May need to be listed in `optionalServices` for Web Bluetooth

---

## Source References
| Project | URL | Language | Gets HR? |
|---------|-----|----------|----------|
| colmi_r02_client | github.com/tahnok/colmi_r02_client | Python | Yes (cmd 0x69) |
| RingCLI | github.com/smittytone/RingCLI | Go | Yes (cmd 0x69) |
| smartringmidi | github.com/mrfloydst/smartringmidi | JS/Web BLE | No (only accel via 0xA1) |
| Edge Impulse | github.com/edgeimpulse/example-data-collection-colmi-r02 | Python | No (raw PPG/accel via 0xA1) |
| Gadgetbridge | codeberg.org/Freeyourgadget/Gadgetbridge | Java | Yes (cmd 0x69) |

## Key Correction
**CONTINUE is NOT command 0x1e.** It is command **0x69 with action byte=0x03**.
The 0x1e (30) command exists in some documentation but RingCLI and colmi_r02_client both use 0x69 for continue.

---

## Edge Cases & Troubleshooting

### Web Bluetooth Specific
- **writeValue vs writeValueWithoutResponse**: Ring uses write-and-notify pattern. `writeValueWithoutResponse()` may be more reliable than `writeValue()` — avoids timeout delays
- **Race condition**: Add 100-200ms delay after `startNotifications()` before sending START command. If command sent before notifications are truly enabled, ring responds but browser misses it
- **MTU**: 16-byte packets fit within default ATT_MTU (20 bytes payload). Not an issue

### Two BLE Services
- Primary (`6e40fff0...`): Real-time HR/SpO2 via cmd 0x69 — **use this for HR**
- Secondary (`de5bf728...`): Raw sensor data via cmd 0xA1 — only for PPG/accel
- **Subscribe to primary only for HR**. Subscribing to both may cause packet interleaving

### Firmware Versions
- R02, R03, R06 are identical hardware — same firmware
- Versions: `3.00.06`, `3.00.10`, `3.00.17_240903`, `RY02_3.00.33_250117`
- Check via Device Info Service UUID `180a`, Firmware Revision `00002a26...`
- Newer firmware (`3.00.17+`) supports HRV sync

### Battery
- No low-battery warning — ring dies suddenly
- Check with command `0x03`: byte[1]=level(0-100), byte[2]=charging status
- Poll every 5 minutes to detect low battery before sudden death

### Why HR Stays at Zero — Complete Checklist
1. **Missing CONTINUE**: Must send `[0x69, 0x01, 0x03, ...]` every ~30s
2. **Notifications not enabled**: `startNotifications()` failed silently
3. **Race condition**: Command sent before notifications ready (add 200ms delay)
4. **Sensor calibrating**: First 15-30s return zeros — this is NORMAL
5. **Poor finger contact**: Sensor not touching palm-side of finger
6. **Battery dead**: Ring shut down without warning
7. **Reading wrong bytes**: Only byte[3] is HR, bytes[6-7] are raw PPG (NOT HR)
8. **Wrong write method**: Try `writeValueWithoutResponse()` if `writeValue()` hangs

### Gadgetbridge Insights
- Colmi pulse interval: 2000ms (not default 1000ms)
- Multiple packets may arrive in same second — buffer 2-3s
- Ring sends data inconsistently (sometimes fast, sometimes slow)

### Official App Behavior
- No special initialization handshake needed
- Just: connect → enable notifications → send START → read responses
- LED goes green = measurement active
- If LED doesn't go green after START, ring isn't measuring

---

## Additional Commands

### Battery Level (0x03)
```
Request:  [0x03, 0x00 × 14, 0x03]
Response: [0x03, battery_level(0-100), charging_status(0/1), ...]
```
Poll every 5 min. Ring dies without warning. < 15% = charge immediately.

### Time Sync (0x01)
```
Request: [0x01, YY, MM, DD, HH, mm, SS, 0x00..., checksum]
         BCD-encoded datetime (year mod 2000)
```

### Device Info (Standard BLE Service 0x180A)
```
0x2A24 = Model Number ("R02")
0x2A25 = Serial Number  
0x2A26 = Firmware Revision ("3.00.17_240903")
0x2A29 = Manufacturer ("Colmi")
```

### Raw Sensor 0xA1 — Detailed Parsing

**Subtype 0x02 (PPG raw):**
```
PPG = (byte[2] << 8) | byte[3]
max = (byte[4] << 8) | byte[5]  
min = (byte[6] << 8) | byte[7]
```

**Subtype 0x03 (Accelerometer, 12-bit two's complement):**
```javascript
Y = (byte[2] << 4) | (byte[3] & 0xF)  // 12-bit
Z = (byte[4] << 4) | (byte[5] & 0xF)
X = (byte[6] << 4) | (byte[7] & 0xF)
// Convert to signed: if val > 2047 → val - 4096
// Convert to G: val / 512
```

### Firmware Versions
| Version | HR(0x69) | Raw(0xA1) | HRV(0x1E) |
|---------|----------|-----------|-----------|
| 3.00.06 | Yes | Slow | No |
| 3.00.17 | Yes | Faster | Yes |
| 3.00.33 | Yes | Faster | Yes |

### Web Bluetooth Critical Fixes
```typescript
// 1. Add event listener BEFORE startNotifications (prevents missed notifications)
txChar.addEventListener("characteristicvaluechanged", handler);
await txChar.startNotifications();
await new Promise(r => setTimeout(r, 200)); // let CCCD write complete

// 2. Use explicit write methods (writeValue is DEPRECATED)
await rxChar.writeValueWithResponse(startCmd);        // for START/STOP
await rxChar.writeValueWithoutResponse(continueCmd);  // for CONTINUE polling

// 3. Check characteristic properties before choosing write method
if (rxChar.properties.writeWithoutResponse) {
  await rxChar.writeValueWithoutResponse(cmd);
} else {
  await rxChar.writeValueWithResponse(cmd);
}
```

### Dual Device Connection
- Chrome supports multiple simultaneous BLE connections ✅
- Each ring needs separate RingConnection instance ✅
- Queue writes sequentially (don't parallelize GATT operations)
- Add 200ms+ between requestDevice() calls for stability

### Notification Reliability
- NOT guaranteed ordered in Web Bluetooth
- CAN be lost during startNotifications() async setup
- Chrome does NOT forcibly disconnect idle connections
- Ring stops after ~10 readings without CONTINUE (device-side timeout)

### Our Implementation is FIRST
No public JavaScript/TypeScript Colmi R02 Web Bluetooth client exists.
Our ring-manager.ts is the most advanced working Web Bluetooth client for Colmi R02.

### Complete Command Reference
| Cmd | Hex | Purpose |
|-----|-----|---------|
| 0x01 | SET_TIME | BCD datetime sync |
| 0x03 | BATTERY | Level + charging status |
| 0x04 | ACTIVITY | Steps/calories/distance |
| 0x05 | SLEEP | Duration + quality |
| 0x69 | RT_START | Start real-time HR (action: 1=START, 3=CONTINUE) |
| 0x6A | RT_STOP | Stop real-time HR |
| 0xA1 | RAW_SENSOR | PPG/Accel streaming (0x04=enable, 0x02=disable) |
| 0x0D | HR_INTERVAL | Set HR log frequency |
| 0x1E | HRV | HRV history (firmware 3.00.17+, param=daysAgo 0-6) |

---

## Round 5 Findings

### Official App Analysis
- **Wireshark dissector exists**: codeberg.org/Freeyourgadget/Gadgetbridge-tools
- **No hidden handshake**: official QRing app uses same sequence as us (connect → notify → START)
- Our implementation is correct

### HRV Command (0x1E) — Clarified
- NOT a real-time command — returns **historical** HRV data in 30-minute intervals
- Parameter: `daysAgo` (0-6), not a measurement trigger
- Requires firmware **3.00.17+**
- For real-time HRV: must compute from HR intervals (RMSSD) ourselves

### Continuous HR Mode (Type 6)
- **Likely does NOT exist** as a real-time streaming mode
- 0x06 may be an action/camera command, not HR type
- All working implementations use **Type 1 + CONTINUE** polling
- "Stopping is tricky" comment in RingCLI = Type 6 may be unstable/untested

### Error Codes (byte[2])
- `0x00` = success
- Non-zero = error (specific codes NOT documented)
- When byte[2]≠0 during HR: skip reading, sensor error
- When byte[2]=0 AND byte[3]=0: sensor calibrating (normal)

### Model Differences
- **R02 = R03 = R06**: identical hardware + firmware + protocol
- **R09**: same protocol + temperature sensor + gesture support
- Only rings using QRing app are compatible

### Sleep/Wake Behavior
- Ring stays BLE-connected during sleep
- Auto-reconnects on wake
- No special wake command needed
- BLE advertisement intervals during sleep: unknown

### What We Still Don't Know
- Exact BLE advertisement timing (sleep vs wake)
- Error code meanings beyond 0x00
- Whether Type 6 continuous mode is real
- Firmware OTA update protocol details

---

## Round 6 — Practical Testing Guide

### Charging
- Dead to full: **30-45 minutes** (17mAh battery)
- Red flashing = charging, Green solid = full
- **BLE works while charging** — can test without wearing
- Must reach green LED before first use from factory

### Testing HR Without Wearing
- Press finger on sensor while ring on table — works!
- Hold ring against palm/wrist — works!
- Sensor just needs skin contact on inner side
- Best: index/middle finger, snug, palm-facing side, don't move

### Debugging with nRF Connect App
1. Install nRF Connect (Android/iOS)
2. Scan → connect to "R02_xxxx"
3. Subscribe to TX: `6e400003-b5a3-f393-e0a9-e50e24dcca9e`
4. Write to RX: `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
5. Send START HR: `69 01 01 00 00 00 00 00 00 00 00 00 00 00 00 6B`
6. Watch notifications — byte[3] should show HR after 15-30s
7. **This is the fastest way to verify protocol correctness**

### Official QRing App
- Can coexist with our app but **NOT connect simultaneously**
- Test with QRing first to verify ring works → then disconnect → use our app
- No hidden handshake — ring responds identically to any app

### Ring Stops Responding — Checklist
1. Battery dead? → Charge (ring dies without warning)
2. Sleeping? → Touch/move ring to wake
3. BLE claimed by another app? → Close QRing/other BLE apps
4. Firmware stuck? → Full charge cycle (charge to green, remove, retry)

### nRF Connect Test Packets (copy-paste ready)
```
START HR:    69010100000000000000000000000006B
CONTINUE HR: 69010300000000000000000000000006D
STOP HR:     6A01000000000000000000000000006B
BATTERY:     03000000000000000000000000000003
```
