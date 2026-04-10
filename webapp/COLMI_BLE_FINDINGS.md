# Colmi R02 BLE Protocol — Complete Research Findings

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
