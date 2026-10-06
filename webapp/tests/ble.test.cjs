/* eslint-disable @typescript-eslint/no-require-imports -- Dependency-free Node CommonJS test harness. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

test("passive removal/refit observation suppresses retries and ends with bounded STOP", async () => {
  const h = harness({ deviceInfo: true, firmware: "RT02R_3.11.00_250611", hardware: "RT02R_V3.1" });
  await h.ring.scan();
  h.notify(packet(0x69, 6, 0, 75));
  h.ring.startPassiveObservation();
  const writes = h.writes.length;
  h.notify(packet(0x69, 6, 1));
  h.notify(packet(0x69, 6, 2));
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  await h.advance(95_000);
  await h.ring.refreshBattery(true);
  assert.equal(h.writes.length, writes);
  await assert.rejects(h.ring.retryMeasurement(), /Stop passive/);
  await assert.rejects(h.ring.setHeartRateMode("standard"), /Stop passive/);
  await assert.rejects(h.ring.startOpticalDiagnostic(), /Stop passive/);
  h.notify(packet(0x69, 6, 0, 77));
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.freshReadings.length, 2);
  await h.advance(25_000);
  assert.equal(h.writes.length, writes + 1);
  assert.equal(h.writes.at(-1).bytes[0], 0x6a);
  assert.equal(h.ring.diagnostics.measurementState, "paused");
  assert.equal(h.ring.diagnostics.passiveObservationEndsAt, 0);
  h.notify(packet(0x69, 6, 0, 78));
  assert.equal(h.freshReadings.length, 2);
  await h.advance(120_000);
  assert.equal(h.writes.length, writes + 1);
});

test("passive observation cancellation cannot stop a later connection", async () => {
  const h = harness({ deviceInfo: true, firmware: "RT02R_3.11.00_250611", hardware: "RT02R_V3.1" });
  await h.ring.scan();
  assert.throws(() => h.ring.startPassiveObservation(), /healthy realtime/);
  h.notify(packet(0x69, 6, 0, 75));
  h.ring.startPassiveObservation();
  await h.advance(20_000);
  await h.ring.disconnect();
  await h.ring.scan();
  const starts = h.ring.diagnostics.startsSent;
  for (let n = 0; n < 65; n++) { h.notify(packet(0x69, 6, 0, 77)); await h.advance(2_000); }
  assert.equal(h.ring.state, "connected");
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.ring.diagnostics.startsSent, starts);
  assert.equal(h.ring.diagnostics.passiveObservationEndsAt, 0);
});

test("a hung passive observation STOP closes GATT and cannot trigger a late restart", async () => {
  const h = harness({ deviceInfo: true, firmware: "RT02R_3.11.00_250611", hardware: "RT02R_V3.1" });
  await h.ring.scan();
  h.notify(packet(0x69, 6, 0, 75));
  h.ring.startPassiveObservation();
  const release = h.blockWrites();
  await h.advance(123_000);
  assert.equal(h.ring.state, "disconnected");
  assert.match(h.ring.diagnostics.lastError, /Observation STOP/);
  const writes = h.writes.length;
  release();
  await settle();
  await h.advance(120_000);
  assert.equal(h.writes.length, writes);
});

const protocolCode = compile("lib/ble/colmi-protocol.ts");
const managerCode = compile("lib/ble/ring-manager.ts");

function compile(file) {
  return ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function load(code, globals, dependencies = {}) {
  const context = { exports: {}, ...globals, require: (name) => dependencies[name] };
  vm.runInNewContext(code, context);
  return context.exports;
}

function packet(command, type, status = 0, value = 0) {
  const bytes = new Uint8Array(16);
  bytes.set([command, type, status, value]);
  bytes[15] = (command + type + status + value) & 255;
  return new DataView(bytes.buffer);
}

class Events {
  listeners = new Map();
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name) { for (const handler of [...(this.listeners.get(name) || [])]) handler({ target: this }); }
  count(name) { return this.listeners.get(name)?.size || 0; }
}

async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }

function harness({ deviceInfo = false, writeWithoutResponse = true, firmware = "3.01\0", hardware = "R02", ringName = null, deviceName = "Test ring", otherDevices = [] } = {}) {
  let now = 1_800_000_000_000;
  let lastRequest = null;
  let timerId = 0;
  let writeGate = null;
  let connectionGate = null;
  let writeError = null;
  let selectionError = null;
  let connectionFailures = 0;
  let selectionCount = 0;
  let connectCount = 0;
  const storage = new Map();
  let activeWrites = 0;
  let maximumWrites = 0;
  const timers = new Map();
  const writes = [];
  const freshReadings = [];
  const allData = [];
  const allDiagnostics = [];
  const device = new Events();
  const tx = new Events();
  tx.startNotifications = async () => tx;
  const rx = { properties: { writeWithoutResponse } };
  const performWrite = async (command) => {
    activeWrites++;
    maximumWrites = Math.max(maximumWrites, activeWrites);
    writes.push({ at: now, bytes: Array.from(new Uint8Array(command)) });
    try {
      if (writeGate) await writeGate;
      if (writeError) throw writeError;
    } finally { activeWrites--; }
  };
  rx.writeValueWithoutResponse = performWrite;
  rx.writeValueWithResponse = performWrite;
  const server = {
    connected: false,
    async connect() {
      connectCount++;
      if (connectionGate) await connectionGate;
      if (connectionFailures-- > 0) throw new Error("GATT temporarily unavailable");
      this.connected = true;
      return this;
    },
    disconnect() { this.connected = false; device.emit("gattserverdisconnected"); },
    async getPrimaryService(uuid) {
      if (uuid === "device_information") {
        if (!deviceInfo) throw new Error("Service absent");
        return { getCharacteristic: async (name) => ({ readValue: async () => {
          const bytes = new TextEncoder().encode(name === "firmware_revision_string" ? firmware : hardware);
          return new DataView(bytes.buffer);
        } }) };
      }
      return { getCharacteristic: async (uuid) => uuid === protocol.COLMI_TX_UUID ? tx : rx };
    },
  };
  device.name = deviceName;
  device.id = "test-ring-id";
  device.gatt = server;
  const globals = {
    Uint8Array, DataView, ArrayBuffer, TextDecoder, Error,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } },
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, at: now + delay, repeat: true }); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay, at: now + delay, repeat: false }); return id; },
    clearTimeout: (id) => timers.delete(id),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    navigator: { bluetooth: {
      requestDevice: async (options) => { selectionCount++; lastRequest = options; if (selectionError) throw selectionError; return device; },
      getDevices: async () => [...otherDevices, device],
    } },
  };
  const protocol = load(protocolCode, globals);
  const { RingConnection } = load(managerCode, globals, { "./colmi-protocol": protocol });
  const ring = new RingConnection(1, ringName);
  ring.onHeartRate = (reading) => freshReadings.push(reading);
  ring.onData = (data) => allData.push(data);
  ring.onDiagnostics = (data) => allDiagnostics.push(data);
  return {
    ring, protocol, device, tx, server, writes, freshReadings, allData, allDiagnostics, timers,
    get maximumWrites() { return maximumWrites; },
    get selectionCount() { return selectionCount; },
    get lastRequest() { return lastRequest; },
    get connectCount() { return connectCount; },
    storage,
    failConnections(count) { connectionFailures = count; },
    blockWrites() { let resolve; writeGate = new Promise((done) => { resolve = done; }); return () => { writeGate = null; resolve(); }; },
    blockConnections() { let resolve; connectionGate = new Promise((done) => { resolve = done; }); return () => { connectionGate = null; resolve(); }; },
    failWrites(error) { writeError = error; },
    allowFutureWrites() { writeGate = null; },
    failSelection(error) { selectionError = error; },
    setDeviceInfo(nextFirmware, nextHardware) { firmware = nextFirmware; hardware = nextHardware; },
    notify(view) { tx.value = view; tx.emit("characteristicvaluechanged"); },
    async advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timers.has(id)) {
          if (timer.repeat) timer.at += timer.delay;
          else timers.delete(id);
          timer.fn();
        }
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

test("connect subscribes, requests battery and starts immediately; begin is idempotent", async () => {
  const h = harness({ deviceInfo: true });
  assert.equal(await h.ring.scan(), true);
  await Promise.all([h.ring.beginMeasurement(), h.ring.beginMeasurement()]);
  assert.deepEqual(h.writes.map((w) => w.bytes.slice(0, 3)), [[3, 0, 0], [0x69, 1, 1]]);
  assert.equal(h.ring.diagnostics.firmware, "3.01");
  assert.equal(h.ring.diagnostics.hardware, "R02");
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
  assert.equal(h.ring.diagnostics.measurementState, "warming-up");
});

test("active samples never trigger CONTINUE; battery, calibration and repeated BPM are distinguished", async () => {
  const h = harness();
  await h.ring.scan();
  for (let index = 0; index < 10; index++) h.notify(packet(0x69, 1, 0, 0));
  await settle();
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  for (let index = 0; index < 10; index++) h.notify(packet(0x69, 1, 0, 73));
  h.notify(packet(3, 88));
  h.notify(new DataView(Uint8Array.from([0xa1, 2, 12, 3]).buffer));
  await settle();
  assert.equal(h.freshReadings.length, 10);
  assert.equal(h.ring.diagnostics.heartRateSamples, 10);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 1]);
  assert.equal(h.ring.data.batteryLevel, 88);
  assert.equal(h.ring.data.rawPpg, 780);
  assert.notEqual(h.freshReadings[0], h.freshReadings[1]);
});

test("healthy stream runs beyond 90 seconds without periodic START", async () => {
  const h = harness();
  await h.ring.scan();
  for (let index = 0; index < 50; index++) {
    h.notify(packet(0x69, 1, 0, 70 + index % 4));
    await h.advance(2_000);
  }
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.ring.diagnostics.restartCount, 0);
});

test("zero ACK warmup stays uninterrupted for 60 seconds then bounds START recovery", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 0));
  await h.advance(45_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  await h.advance(15_000);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  await h.advance(120_000);
  assert.equal(h.ring.diagnostics.startsSent, 3);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.ring.diagnostics.restartCount, 2);
  assert.equal(h.ring.diagnostics.measurementState, "error");
  assert.match(h.ring.diagnostics.lastError, /No fresh heart-rate/);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 1, 0]);
  await h.ring.retryMeasurement();
  assert.equal(h.ring.diagnostics.measurementState, "warming-up");
  assert.equal(h.ring.diagnostics.startsSent, 4);
});

test("stalled fresh HR gets one CONTINUE and sixty uninterrupted seconds before recovery", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 77));
  await h.advance(16_000);
  assert.equal(h.ring.diagnostics.measurementState, "warming-up");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 1);
  await h.advance(30_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 1);
  await h.advance(24_000);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.ring.diagnostics.measurementState, "warming-up");
  h.notify(packet(0x69, 1, 0, 81));
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.freshReadings.length, 2);
});

test("ongoing zero notifications after a valid reading do not trigger CONTINUE", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 75));
  for (let index = 0; index < 80; index++) {
    h.notify(packet(0x69, 1, 0, 0));
    await h.advance(500);
  }
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.ring.diagnostics.heartRateSamples, 1);
  assert.equal(h.ring.diagnostics.measurementState, "stale");
});

test("saved selection restores permission without starting sensors or opening chooser", async () => {
  const h = harness();
  h.storage.set("musical-box-ring-1", "test-ring-id");
  await h.ring.restoreSelectedDevice();
  assert.equal(h.ring.device, h.device);
  assert.equal(h.connectCount, 0);
  assert.equal(h.selectionCount, 0);
  assert.equal(await h.ring.connect(), true);
  await h.ring.disconnect();
  assert.equal(await h.ring.connect(), true);
  assert.equal(h.selectionCount, 0);
});

test("transient initial failure retries the selected ring without a second chooser", async () => {
  const h = harness();
  h.failConnections(1);
  assert.equal(await h.ring.scan(), false);
  await h.advance(1_000);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.connectCount, 2);
  assert.equal(h.selectionCount, 1);
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
});

test("unexpected loss automatically reconnects, clears old BPM and records fresh samples once", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 73));
  h.server.disconnect();
  assert.equal(h.ring.data.heartRate, null);
  await h.advance(1_000);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.selectionCount, 1);
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
  h.notify(packet(0x69, 1, 0, 74));
  assert.equal(h.freshReadings.length, 2);
});

test("unavailable ring has bounded retries and manual Disconnect cancels backoff", async () => {
  const h = harness();
  h.failConnections(10);
  await h.ring.scan();
  await h.advance(60_000);
  assert.equal(h.connectCount, 4);
  assert.equal(h.timers.size, 0);
  await h.ring.connect();
  await h.ring.disconnect();
  await h.advance(60_000);
  assert.equal(h.connectCount, 5);
  assert.equal(h.timers.size, 0);
});

test("hung connect times out; a late old completion cannot disconnect a new connection", async () => {
  const h = harness();
  const release = h.blockConnections();
  const first = h.ring.scan();
  await settle();
  await h.advance(20_000);
  assert.equal(await first, false);
  assert.equal(h.ring.state, "disconnected");
  assert.match(h.ring.diagnostics.lastError, /timed out/);
  // The old native promise remains pending while a newer attempt succeeds.
  const originalConnect = h.server.connect;
  h.server.connect = async function () { this.connected = true; return this; };
  assert.equal(await h.ring.connect(), true);
  release();
  await settle();
  assert.equal(h.server.connected, true);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  h.server.connect = originalConnect;
});

test("unexpected disconnect resets stale data and reconnect resumes with one listener", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 73));
  h.server.disconnect();
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.timers.size, 1); // One bounded reconnect is scheduled.
  assert.equal(h.tx.count("characteristicvaluechanged"), 0);
  assert.equal(await h.ring.connect(), true);
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  h.notify(packet(0x69, 1, 0, 74));
  assert.equal(h.freshReadings.length, 2);
  await h.ring.disconnect();
  const count = h.writes.length;
  await h.advance(120_000);
  assert.equal(h.writes.length, count);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.writes.at(-1).bytes, [0x6a, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6b]);
});

test("disconnect during in-flight CONTINUE serializes STOP and cannot recreate timers", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 70));
  const release = h.blockWrites();
  await h.advance(10_000);
  const disconnecting = h.ring.disconnect();
  await settle();
  assert.equal(h.writes.at(-1).bytes[2], 3);
  release();
  await disconnecting;
  await h.advance(100_000);
  assert.equal(h.maximumWrites, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ring.state, "disconnected");
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 1, 0]);
});

test("disconnect during deferred connect then rescan waits for old cleanup and starts a new connection", async () => {
  const h = harness();
  const release = h.blockConnections();
  const first = h.ring.scan();
  await settle();
  assert.equal(h.ring.state, "connecting");
  await h.ring.disconnect();
  const second = h.ring.scan();
  await settle();
  release();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.server.connected, true);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.tx.count("characteristicvaluechanged"), 1);
  assert.equal(h.device.count("gattserverdisconnected"), 1);
  assert.equal(h.timers.size, 1);
});

test("write failures and firmware errors remain visible without becoming HR samples", async () => {
  const h = harness({ writeWithoutResponse: false });
  await h.ring.scan();
  h.notify(packet(0x69, 1, 7, 73));
  assert.match(h.ring.diagnostics.lastError, /0x07/);
  assert.equal(h.freshReadings.length, 0);
  h.failWrites(new Error("GATT operation failed"));
  await h.ring.retryMeasurement();
  assert.match(h.ring.diagnostics.lastError, /START failed: GATT operation failed/);
  assert.equal(h.ring.diagnostics.measurementState, "error");
});

test("parser checks fixed framing/checksum, honors DataView offset, preserves valid HR extremes", () => {
  const { protocol } = harness();
  // Literal valid HR fixture: 0x69 + 0x01 + 73 = 0xb3.
  const fixture = Uint8Array.from([99, 99, 0x69, 1, 0, 73, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xb3, 99]);
  assert.equal(protocol.parseNotification(new DataView(fixture.buffer, 2, 16)).heartRate, 73);
  assert.equal(protocol.parseNotification(new DataView(fixture.buffer, 2, 4)).status, "invalid");
  fixture[17] = 0;
  assert.match(protocol.parseNotification(new DataView(fixture.buffer, 2, 16)).error, /checksum/);
  assert.equal(protocol.parseNotification(packet(0x69, 1, 0, 39)).heartRate, 39);
  assert.equal(protocol.parseNotification(packet(0x69, 1, 0, 201)).heartRate, 201);
  const warmup = packet(0x69, 1);
  warmup.setUint16(6, 1000, true);
  let sum = 0;
  for (let index = 0; index < 15; index++) sum += warmup.getUint8(index);
  warmup.setUint8(15, sum & 255);
  const parsed = protocol.parseNotification(warmup);
  assert.equal(parsed.status, "warming-up");
  assert.equal(parsed.rawPpg, undefined);
});

test("diagnostic trace is bounded and includes full offset notification packets", async () => {
  const h = harness();
  await h.ring.scan();
  for (let index = 0; index < 220; index++) h.notify(packet(3, 88));
  const report = JSON.parse(h.ring.getDebugReport());
  assert.equal(report.events.length, 200);
  assert.equal(report.diagnostics.packetsReceived, 220);
  assert.equal(report.events.at(-1).detail, "03 58 00 00 00 00 00 00 00 00 00 00 00 00 00 5b");
  assert.equal(h.freshReadings.length, 0);
  assert.notEqual(h.allDiagnostics.at(-1), h.ring.diagnostics);
});

test("legacy preference starts with action zero and recovery preserves the selected mode", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("legacy");
  assert.equal(h.writes.length, 0);
  assert.equal(h.ring.heartRateMode, "legacy");
  await h.ring.scan();
  assert.deepEqual(h.writes.at(-1).bytes, [0x69, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x6a]);
  await h.advance(60_000);
  assert.deepEqual(h.writes.at(-2).bytes.slice(0, 3), [0x6a, 1, 0]);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 0]);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(JSON.parse(h.ring.getDebugReport()).heartRateMode, "legacy");
  await assert.rejects(h.ring.setHeartRateMode("unsupported"), /Unsupported/);
});

test("switching modes queues STOP then waits two quiet seconds before its START", async () => {
  const h = harness();
  await h.ring.scan();
  const release = h.blockWrites();
  const switching = h.ring.setHeartRateMode("legacy");
  await settle();
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 1, 0]);
  await h.advance(2_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  release();
  await settle();
  await h.ring.beginMeasurement();
  await h.advance(1_999);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  await h.advance(1);
  await switching;
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 0]);
  assert.equal(h.maximumWrites, 1);
  const count = h.writes.length;
  await h.ring.setHeartRateMode("legacy");
  assert.equal(h.writes.length, count);
});

test("disconnect cancels a pending protocol switch without a late START or leaked timer", async () => {
  const h = harness();
  await h.ring.scan();
  const switching = h.ring.setHeartRateMode("legacy");
  await settle();
  await h.advance(1_000);
  await h.ring.disconnect();
  await switching;
  const count = h.writes.length;
  await h.advance(5_000);
  assert.equal(h.writes.length, count);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.ring.state, "disconnected");
});

test("failed CONTINUE attempts remain spaced ten seconds apart", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 75));
  h.failWrites(new Error("GATT operation failed"));
  await h.advance(20_000);
  const attempts = h.writes.filter((write) => write.bytes[0] === 0x69 && write.bytes[2] === 3);
  assert.deepEqual(attempts.map((write) => write.at - h.writes[0].at), [10_000, 20_000]);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.match(h.ring.diagnostics.lastError, /CONTINUE failed/);
});

test("disconnect bounds a hung native write and reconnect ignores the abandoned queue", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 75));
  const releaseOldWrite = h.blockWrites();
  await h.advance(10_000);
  let disconnected = false;
  const closing = h.ring.disconnect().then(() => { disconnected = true; });
  await settle();
  await h.advance(2_999);
  assert.equal(disconnected, false);
  assert.equal(h.server.connected, true);
  await h.advance(1);
  await closing;
  assert.equal(h.server.connected, false);
  assert.equal(h.timers.size, 0);
  assert.match(h.ring.diagnostics.lastError, /STOP timed out/);
  h.allowFutureWrites();
  assert.equal(await h.ring.scan(), true);
  const count = h.writes.length;
  releaseOldWrite();
  await settle();
  assert.equal(h.writes.length, count);
  assert.equal(h.server.connected, true);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.timers.size, 1);
});

test("opening a new device chooser clears the previous cancelled-scan error", async () => {
  const h = harness();
  h.failSelection(new Error("User cancelled the requestDevice chooser"));
  assert.equal(await h.ring.scan(), false);
  assert.equal(h.ring.diagnostics.lastError, "No ring was selected. Press Connect ring to try again.");
  assert.match(h.ring.getDebugReport(), /Device selection failed: User cancelled/);
  h.failSelection(null);
  const scanning = h.ring.scan();
  assert.equal(h.ring.state, "scanning");
  assert.equal(h.ring.diagnostics.lastError, null);
  assert.equal(h.ring.diagnostics.measurementState, "idle");
  assert.equal(await scanning, true);
});

test("a failed ring choice says what to do next", async () => {
  for (const [reason, shown] of [
    ["Bluetooth adapter not available.", /^Bluetooth seems to be off\./],
    ["GATT operation failed for unknown reason.", /^Could not reach the ring\./],
  ]) {
    const h = harness();
    h.failSelection(new Error(reason));
    assert.equal(await h.ring.scan(), false);
    assert.match(h.ring.diagnostics.lastError, shown);
    assert.match(h.ring.getDebugReport(), new RegExp(`Device selection failed: ${reason}`));
    assert.equal(h.ring.state, "disconnected");
  }
});

test("fresh HR after CONTINUE clears grace and enables another silence-triggered continuation", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 75));
  await h.advance(10_000);
  h.notify(packet(0x69, 1, 0, 0));
  await h.advance(25_000);
  assert.equal(h.ring.diagnostics.continuesSent, 1);
  h.notify(packet(0x69, 1, 0, 76));
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  await h.advance(12_000);
  assert.equal(h.ring.diagnostics.continuesSent, 2);
  assert.equal(h.ring.diagnostics.startsSent, 1);
});

test("HR during a pending CONTINUE write is not overwritten by a late warmup transition", async () => {
  const h = harness();
  await h.ring.scan();
  h.notify(packet(0x69, 1, 0, 75));
  const release = h.blockWrites();
  await h.advance(10_000);
  h.notify(packet(0x69, 1, 0, 76));
  release();
  await settle();
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  await h.advance(10_000);
  assert.equal(h.ring.diagnostics.continuesSent, 2);
});

test("realtime mode accepts checked 0x1e and 0x69/type6 readings without CONTINUE", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("realtime");
  await h.ring.scan();
  assert.deepEqual(h.writes.at(-1).bytes, [0x69, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70]);
  h.notify(packet(0x69, 1, 0, 77));
  h.notify(packet(0x69, 6, 0, 82));
  assert.equal(h.freshReadings.length, 1);
  assert.equal(h.ring.data.heartRate, 82);
  assert.equal(h.ring.diagnostics.lastError, null);
  for (let index = 0; index < 60; index++) {
    h.notify(packet(0x1e, 75 + index % 3));
    await h.advance(2_000);
  }
  assert.equal(h.freshReadings.length, 61);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(JSON.parse(h.ring.getDebugReport()).heartRateMode, "realtime");
  const corrupt = packet(0x1e, 80);
  corrupt.setUint8(15, 0);
  h.notify(corrupt);
  assert.equal(h.freshReadings.length, 61);
  assert.match(h.ring.diagnostics.lastError, /checksum/);
});

test("switching type 6 to type 1 stops the old type and ignores its trailing readings", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("realtime");
  await h.ring.scan();
  const switching = h.ring.setHeartRateMode("standard");
  await settle();
  assert.deepEqual(h.writes.at(-1).bytes, [0x6a, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x70]);
  await h.advance(2_000);
  await switching;
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 1]);
  h.notify(packet(0x1e, 75));
  assert.equal(h.freshReadings.length, 0);
  h.notify(packet(0x69, 1, 0, 76));
  assert.equal(h.freshReadings.length, 1);
  await h.ring.disconnect();
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 1, 0]);
});

test("realtime capture waits ninety seconds then stops without automatic restarts; manual retry works", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("realtime");
  await h.ring.scan();
  h.notify(packet(0x1e, 0));
  await h.advance(89_999);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.writes.length, 2);
  await h.advance(1);
  assert.equal(h.ring.diagnostics.measurementState, "error");
  assert.match(h.ring.diagnostics.lastError, /90 seconds/);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 6, 0]);
  assert.equal(h.ring.state, "connected");
  assert.equal(h.timers.size, 0);
  await h.advance(180_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  await h.ring.retryMeasurement();
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 6, 1]);
});

test("realtime timeout closes GATT if its STOP hangs beyond three seconds", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("realtime");
  await h.ring.scan();
  const release = h.blockWrites();
  await h.advance(90_000);
  assert.equal(h.ring.state, "connected");
  await h.advance(3_000);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.server.connected, false);
  assert.equal(h.timers.size, 0);
  assert.match(h.ring.diagnostics.lastError, /STOP did not complete/);
  release();
  await settle();
  assert.equal(h.ring.state, "disconnected");
});

test("captured R02 type6 frame uses generic 0x69 value, zero/error/checksum rules", () => {
  const { protocol } = harness();
  const bytes = Uint8Array.from([0x69, 0x06, 0x00, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xc1]);
  assert.equal(protocol.parseNotification(new DataView(bytes.buffer)).heartRate, 82);
  const zero = protocol.parseNotification(packet(0x69, 6, 0, 0));
  assert.equal(zero.status, "warming-up");
  assert.equal(zero.heartRate, undefined);
  const error = protocol.parseNotification(packet(0x69, 6, 7, 82));
  assert.equal(error.status, "error");
  assert.equal(error.errorCode, 7);
  assert.equal(error.heartRate, undefined);
  bytes[15] = 0;
  const invalid = protocol.parseNotification(new DataView(bytes.buffer));
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.heartRate, undefined);
});

test("continuous 0x69/type6 replies keep the stream alive beyond the 90-second timeout", async () => {
  const h = harness();
  await h.ring.setHeartRateMode("realtime");
  await h.ring.scan();
  await h.advance(19_000);
  for (let index = 0; index < 120; index++) {
    h.notify(packet(0x69, 6, 0, 81 + index % 4));
    await h.advance(1_000);
  }
  assert.equal(h.freshReadings.length, 120);
  assert.equal(h.ring.diagnostics.heartRateSamples, 120);
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
  assert.equal(h.writes.length, 2);
  assert.equal(h.ring.state, "connected");
});

test("only the two exact verified firmware/hardware pairs default to realtime before first START", async () => {
  const profiles = [
    ["RT02R_3.11.00_250611", "RT02R_V3.1"],
    ["R02_3.00.17_240903", "R02_V3.0"],
  ];
  for (const [firmware, hardware] of profiles) {
    const h = harness({ deviceInfo: true, firmware, hardware });
    await h.ring.scan();
    assert.equal(h.ring.heartRateMode, "realtime");
    assert.deepEqual(h.writes.map((write) => write.bytes.slice(0, 3)), [[3, 0, 0], [0x69, 6, 1]]);
  }
});

test("unknown or mismatched device information defaults to Standard", async () => {
  const profiles = [
    ["R02_3.00.17_240903", "RT02R_V3.1"],
    ["RT02R_3.11.00_250611", "unknown"],
    ["R02_3.00.18_240903", "R02_V3.0"],
  ];
  for (const [firmware, hardware] of profiles) {
    const h = harness({ deviceInfo: true, firmware, hardware });
    await h.ring.scan();
    assert.equal(h.ring.heartRateMode, "standard");
    assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 1]);
  }
});

test("explicit user mode wins over automatic profile selection, including same-value Standard", async () => {
  for (const mode of ["standard", "legacy", "realtime"]) {
    const h = harness({ deviceInfo: true, firmware: "R02_3.00.17_240903", hardware: "R02_V3.0" });
    await h.ring.setHeartRateMode(mode);
    await h.ring.scan();
    assert.equal(h.ring.heartRateMode, mode);
    const expected = mode === "realtime" ? [0x69, 6, 1] : mode === "legacy" ? [0x69, 1, 0] : [0x69, 1, 1];
    assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), expected);
  }
});

test("automatic realtime selection does not carry over when reconnecting an unverified device", async () => {
  const h = harness({ deviceInfo: true, firmware: "R02_3.00.17_240903", hardware: "R02_V3.0" });
  await h.ring.scan();
  assert.equal(h.ring.heartRateMode, "realtime");
  await h.ring.disconnect();
  h.setDeviceInfo("unknown", "unknown");
  await h.ring.scan();
  assert.equal(h.ring.heartRateMode, "standard");
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, 1, 1]);
});

function verifiedRing() {
  return harness({ deviceInfo: true, firmware: "R02_3.00.17_240903", hardware: "R02_V3.0" });
}

test("contact errors clear HR and the final error restarts immediately without a watchdog delay", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 0, 82));
  h.notify(packet(0x69, 6, 1, 82));
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.allData.at(-1).heartRate, null);
  assert.equal(h.ring.diagnostics.lastHeartRateAt, 0);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  assert.equal(h.ring.diagnostics.lastError, null);
  assert.equal(h.freshReadings.length, 1);
  assert.equal(h.ring.diagnostics.heartRateSamples, 1);
  await h.advance(2_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  h.notify(packet(0x69, 6, 2, 82));
  await settle();
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.deepEqual(h.writes.slice(-2).map((write) => write.bytes.slice(0, 3)), [[0x6a, 6, 0], [0x69, 6, 1]]);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  h.notify(packet(0x69, 6, 0, 0));
  await h.advance(88_000);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  h.notify(packet(0x69, 6, 0, 84));
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.ring.data.heartRate, 84);
  assert.equal(h.freshReadings.length, 2);
  assert.equal(h.ring.diagnostics.heartRateSamples, 2);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
});

test("final contact error alone restarts once and trailing errors cannot interrupt its writes", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  const release = h.blockWrites();
  h.notify(packet(0x69, 6, 2));
  await settle();
  for (const code of [1, 1, 2, 2]) h.notify(packet(0x69, 6, code));
  await h.advance(500);
  assert.equal(h.writes.at(-1).bytes[0], 0x6a);
  release();
  await settle();
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.ring.diagnostics.restartCount, 1);
  h.notify(packet(0x69, 6, 0, 80));
  await h.advance(10_000);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.maximumWrites, 1);
});

test("repeated preliminary contact errors retain the fallback when the final error is absent", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 1));
  await h.advance(2_000);
  h.notify(packet(0x69, 6, 1));
  await h.advance(1_999);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  await h.advance(1);
  assert.equal(h.ring.diagnostics.startsSent, 2);
});

test("a spontaneous fresh HR cancels contact retry without resetting the resumed stream", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 1));
  await h.advance(2_000);
  h.notify(packet(0x69, 6, 0, 81));
  await h.advance(10_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.writes.length, 2);
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.ring.data.heartRate, 81);
});

test("unknown realtime error cancels contact retry, stays visible, and ignores trailing HR until manual retry", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 1));
  await h.advance(2_000);
  h.notify(packet(0x69, 6, 7));
  await settle();
  assert.equal(h.ring.diagnostics.measurementState, "error");
  assert.match(h.ring.diagnostics.lastError, /0x07/);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 6, 0]);
  h.notify(packet(0x69, 6, 0, 85));
  await h.advance(200_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.freshReadings.length, 0);
  assert.equal(h.ring.diagnostics.measurementState, "error");
  assert.equal(h.timers.size, 0);
  await h.ring.retryMeasurement();
  h.notify(packet(0x69, 6, 0, 86));
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.equal(h.freshReadings.length, 1);
});

test("contact recovery is scoped to verified profiles and realtime type 6", async () => {
  const unknown = harness();
  await unknown.ring.setHeartRateMode("realtime");
  await unknown.ring.scan();
  unknown.notify(packet(0x69, 6, 1));
  await unknown.advance(200_000);
  assert.equal(unknown.ring.diagnostics.measurementState, "error");
  assert.match(unknown.ring.diagnostics.lastError, /0x01/);
  assert.equal(unknown.ring.diagnostics.startsSent, 1);
  const standard = verifiedRing();
  await standard.ring.setHeartRateMode("standard");
  await standard.ring.scan();
  standard.notify(packet(0x69, 1, 2));
  await standard.advance(10_000);
  assert.equal(standard.ring.diagnostics.measurementState, "error");
  assert.match(standard.ring.diagnostics.lastError, /0x02/);
  assert.equal(standard.ring.diagnostics.startsSent, 1);
});

test("verified realtime timeout waits for contact and gives each zero-only retry ninety seconds", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await h.advance(89_999);
  assert.equal(h.ring.diagnostics.measurementState, "warming-up");
  await h.advance(1);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  await h.advance(4_000);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  h.notify(packet(0x69, 6));
  await h.advance(89_999);
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.ring.diagnostics.measurementState, "waiting-for-contact");
  await h.advance(4_001);
  assert.equal(h.ring.diagnostics.startsSent, 3);
  assert.equal(h.ring.diagnostics.lastHeartRateAt, 0);
  assert.equal(h.ring.diagnostics.lastError, null);
  assert.equal(h.freshReadings.length, 0);
});

test("disconnect and mode switch cancel a scheduled contact retry", async () => {
  for (const action of ["disconnect", "switch"]) {
    const h = verifiedRing();
    await h.ring.scan();
    h.notify(packet(0x69, 6, 1));
    await h.advance(2_000);
    const operation = action === "disconnect" ? h.ring.disconnect() : h.ring.setHeartRateMode("standard");
    await settle();
    await h.advance(2_000);
    await operation;
    await h.advance(10_000);
    assert.equal(h.ring.diagnostics.startsSent, action === "disconnect" ? 1 : 2);
    assert.notEqual(h.ring.diagnostics.measurementState, "waiting-for-contact");
    const starts = h.writes.filter((write) => write.bytes[0] === 0x69 && write.bytes[2] === 1);
    assert.deepEqual(starts.map((write) => write.bytes[1]), action === "disconnect" ? [6] : [6, 1]);
  }
});

test("disconnect during contact STOP cancels its queued START and leaves no timers", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 1));
  const release = h.blockWrites();
  await h.advance(4_000);
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 6, 0]);
  const closing = h.ring.disconnect();
  await settle();
  release();
  await closing;
  await h.advance(100_000);
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.timers.size, 0);
  assert.equal(h.maximumWrites, 1);
});

test("hung contact recovery STOP closes the connection without sending START", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  const release = h.blockWrites();
  h.notify(packet(0x69, 6, 2));
  await h.advance(7_000);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.measurementState, "error");
  assert.match(h.ring.diagnostics.lastError, /Contact recovery STOP did not complete/);
  assert.equal(h.timers.size, 0);
  release();
  await settle();
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.ring.diagnostics.startsSent, 1);
});

async function startOptical(h, duration = 15_000) {
  const starting = h.ring.startOpticalDiagnostic(duration);
  await settle();
  await h.advance(2_000);
  await starting;
}

test("battery refresh is throttled, preserves HR freshness, and can be requested manually", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x03, 58));
  h.notify(packet(0x69, 6, 0, 82));
  const hrAt = h.ring.diagnostics.lastHeartRateAt;
  const batteryAt = h.ring.diagnostics.lastBatteryAt;
  await h.advance(59_000);
  await h.ring.refreshBattery();
  assert.equal(h.writes.filter(w => w.bytes[0] === 3).length, 1);
  await h.advance(1_000);
  await h.ring.refreshBattery();
  assert.equal(h.writes.filter(w => w.bytes[0] === 3).length, 2);
  h.notify(packet(0x03, 57));
  assert.equal(h.ring.data.batteryLevel, 57);
  assert.equal(h.ring.diagnostics.lastBatteryAt - batteryAt, 60_000);
  assert.equal(h.ring.diagnostics.lastHeartRateAt, hrAt);
  assert.equal(h.freshReadings.length, 1);
  await h.ring.refreshBattery(true);
  assert.equal(h.writes.filter(w => w.bytes[0] === 3).length, 3);
  assert.equal(h.ring.diagnostics.startsSent, 1);
});

test("bad battery responses and write failures do not invalidate a healthy HR stream", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x03, 58));
  h.notify(packet(0x69, 6, 0, 81));
  const batteryAt = h.ring.diagnostics.lastBatteryAt;
  h.notify(packet(0x03, 101));
  assert.equal(h.ring.diagnostics.lastBatteryAt, batteryAt);
  assert.equal(h.ring.data.batteryLevel, 58);
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.match(h.ring.diagnostics.batteryError, /Invalid battery/);
  h.failWrites(new Error("Battery query rejected"));
  await h.ring.refreshBattery(true);
  assert.equal(h.ring.diagnostics.measurementState, "measuring");
  assert.match(h.ring.diagnostics.batteryError, /Battery query rejected/);
  h.notify(packet(0x03, 57));
  assert.equal(h.ring.diagnostics.batteryError, null);
});

test("optical capture suppresses battery queries and allows them again while paused", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h);
  await h.ring.refreshBattery(true);
  assert.equal(h.writes.filter(w => w.bytes[0] === 3).length, 1);
  await h.advance(20_000);
  await h.ring.refreshBattery(true);
  assert.equal(h.writes.filter(w => w.bytes[0] === 3).length, 2);
  assert.equal(h.ring.diagnostics.measurementState, "paused");
  assert.equal(h.maximumWrites, 1);
});

test("hung battery requests are bounded and cannot emit a late HR START on initial connection", async () => {
  const h = verifiedRing();
  const release = h.blockWrites();
  const connecting = h.ring.scan();
  await settle();
  await settle();
  assert.equal(h.writes.at(-1)?.bytes[0], 0x03);
  await h.advance(3_000);
  assert.equal(await connecting, false);
  assert.equal(h.ring.state, "disconnected");
  assert.match(h.ring.diagnostics.lastError, /Battery request stalled/);
  release();
  await settle();
  assert.equal(h.ring.diagnostics.startsSent, 0);
  assert.equal(h.timers.size, 0);
});

function opticalWrites(h) {
  return h.writes.filter((write) => write.bytes[0] === 0xa1);
}

test("optical diagnostic validates duration, connection and exact device profile before any write", async () => {
  const h = verifiedRing();
  await assert.rejects(h.ring.startOpticalDiagnostic(), /Connect the ring/);
  await h.ring.scan();
  const count = h.writes.length;
  for (const duration of [0, 14_999, 20_000, 30_001, NaN]) {
    await assert.rejects(h.ring.startOpticalDiagnostic(duration), /only 15 or 30/);
  }
  assert.equal(h.writes.length, count);
  const unknown = harness({ deviceInfo: true, firmware: "R02_3.00.18_240903", hardware: "R02_V3.0" });
  await unknown.ring.scan();
  await assert.rejects(unknown.ring.startOpticalDiagnostic(), /verified hardware/);
  assert.equal(opticalWrites(unknown).length, 0);
});

test("newer profile cannot restart optical diagnostics after observed persistent sensor LEDs", async () => {
  const h = harness({ deviceInfo: true, firmware: "RT02R_3.11.00_250611", hardware: "RT02R_V3.1" });
  await h.ring.scan();
  const count = h.writes.length;
  await assert.rejects(h.ring.startOpticalDiagnostic(), /sensor LEDs active/);
  assert.equal(h.writes.length, count);
  assert.equal(h.ring.heartRateMode, "realtime");
  h.notify(packet(0x69, 6, 0, 83));
  assert.equal(h.freshReadings.length, 1);
});

test("optical preparation stops selected HR, waits two quiet seconds and sends only documented full frames", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  h.notify(packet(0x69, 6, 0, 83));
  const starting = h.ring.startOpticalDiagnostic();
  await settle();
  assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x6a, 6, 0]);
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.ring.diagnostics.measurementState, "optical-test");
  assert.equal(h.ring.diagnostics.opticalState, "preparing");
  await h.advance(100);
  h.notify(packet(0x69, 6, 0, 84)); // Brief in-flight HR remains trace-only.
  await h.advance(1_899);
  assert.equal(opticalWrites(h).length, 0);
  await h.advance(1);
  await starting;
  assert.deepEqual(h.writes.at(-1).bytes, [0xa1, 4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa9]);
  assert.equal(h.ring.diagnostics.opticalState, "capturing");
  assert.equal(h.ring.diagnostics.opticalEndsAt - h.writes.at(-1).at, 15_000);
  assert.equal(h.freshReadings.length, 1);
  assert.equal(h.maximumWrites, 1);
});

test("positive HR late in preparation aborts raw START and remains visible in the trace", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  const starting = h.ring.startOpticalDiagnostic();
  await settle();
  await h.advance(1_500);
  h.notify(packet(0x69, 6, 0, 84));
  await h.advance(500);
  await starting;
  assert.equal(opticalWrites(h).length, 0);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.ring.diagnostics.opticalState, "error");
  assert.match(h.ring.diagnostics.lastError, /continued after normal STOP/);
  assert.equal(h.freshReadings.length, 0);
  assert.equal(h.timers.size, 0);
  assert.ok(JSON.parse(h.ring.getDebugReport()).events.some((event) => event.detail.startsWith("69 06 00 54")));
});

test("optical packets preserve complete raw evidence and never enter physiological callbacks", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h);
  const dataCount = h.allData.length;
  const zero = packet(0xa1, 2);
  const corrupt = packet(0xa1, 2, 0x10, 0x20);
  corrupt.setUint8(15, 0);
  const offsetBytes = new Uint8Array(20);
  offsetBytes.set(new Uint8Array(packet(0xa1, 3, 2, 1).buffer), 2);
  h.notify(zero);
  h.notify(corrupt);
  h.notify(new DataView(offsetBytes.buffer, 2, 16));
  h.notify(new DataView(Uint8Array.from([0xa1, 2, 12, 3]).buffer));
  h.notify(packet(0x69, 6, 0, 87));
  h.notify(packet(0x69, 6, 1, 87));
  const report = JSON.parse(h.ring.getDebugReport());
  assert.equal(report.opticalDiagnostic.frames.length, 4);
  assert.deepEqual(report.opticalDiagnostic.frames.map((frame) => frame.checksumValid), [true, false, true, false]);
  assert.deepEqual(report.opticalDiagnostic.frames.map((frame) => frame.length), [16, 16, 16, 4]);
  assert.equal(report.opticalDiagnostic.frames[0].hex, "a1 02 00 00 00 00 00 00 00 00 00 00 00 00 00 a3");
  assert.equal(report.opticalDiagnostic.frames[2].hex.startsWith("a1 03 02 01"), true);
  assert.match(report.opticalDiagnostic.frames[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.diagnostics.opticalFramesReceived, 4);
  assert.equal(h.allData.length, dataCount);
  assert.equal(h.freshReadings.length, 0);
  assert.equal(h.ring.data.rawPpg, null);
  assert.equal(h.ring.data.accelX, null);
  assert.equal(h.ring.data.heartRate, null);
  assert.equal(h.ring.diagnostics.measurementState, "optical-test");
  assert.equal(h.ring.diagnostics.lastError, null);
});

test("optical duration is bounded, STOP gets five-second observation, and HR stays paused until Retry", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h);
  await h.advance(14_999);
  assert.equal(opticalWrites(h).length, 1);
  await h.advance(1);
  assert.deepEqual(h.writes.at(-1).bytes, [0xa1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xa3]);
  assert.equal(h.ring.diagnostics.opticalState, "stopping");
  await h.advance(2_000);
  h.notify(packet(0xa1, 2)); // Allowed delayed packet at the grace boundary.
  await h.advance(2_999);
  assert.equal(h.ring.diagnostics.opticalState, "stopping");
  await h.advance(1);
  assert.equal(h.ring.diagnostics.opticalState, "completed");
  assert.equal(h.ring.diagnostics.measurementState, "paused");
  const report = JSON.parse(h.ring.getDebugReport());
  assert.equal(report.opticalDiagnostic.stopSentAt - report.opticalDiagnostic.startedAt, 15_000);
  assert.equal(report.opticalDiagnostic.completedAt - report.opticalDiagnostic.stopSentAt, 5_000);
  const count = h.writes.length;
  await h.ring.beginMeasurement();
  await h.advance(120_000);
  assert.equal(h.writes.length, count);
  assert.equal(h.timers.size, 0);
  h.notify(packet(0x69, 6, 0, 87));
  assert.equal(h.freshReadings.length, 0);
  await h.ring.retryMeasurement();
  h.notify(packet(0x69, 6, 0, 88));
  assert.equal(h.ring.diagnostics.startsSent, 2);
  assert.equal(h.freshReadings.length, 1);
});

test("raw frames beyond STOP grace close GATT and retain report and readable error", async () => {
  for (const lateAt of [2_001, 6_000]) {
    const h = verifiedRing();
    await h.ring.scan();
    await startOptical(h);
    const stopping = h.ring.stopOpticalDiagnostic();
    await settle();
    await h.advance(lateAt);
    h.notify(packet(0xa1, 2));
    await stopping;
    assert.equal(h.ring.state, "disconnected");
    assert.equal(h.server.connected, false);
    assert.equal(h.ring.diagnostics.opticalState, "error");
    assert.match(h.ring.diagnostics.lastError, /continued after optical STOP/);
    assert.equal(h.timers.size, 0);
    assert.equal(JSON.parse(h.ring.getDebugReport()).opticalDiagnostic.frames.length, 1);
    assert.equal(h.freshReadings.length, 0);
  }
});

test("hung normal STOP aborts optical preparation at three seconds with no late raw START", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  const release = h.blockWrites();
  const starting = h.ring.startOpticalDiagnostic();
  await settle();
  await h.advance(2_999);
  assert.equal(h.ring.state, "connected");
  await h.advance(1);
  await starting;
  assert.equal(h.ring.state, "disconnected");
  assert.match(h.ring.diagnostics.lastError, /Normal measurement STOP did not complete/);
  release();
  await h.advance(60_000);
  assert.equal(opticalWrites(h).length, 0);
  assert.equal(h.timers.size, 0);
});

test("failed or hung raw STOP closes GATT within its bound and a late completion cannot resume", async () => {
  for (const failure of ["reject", "hang"]) {
    const h = verifiedRing();
    await h.ring.scan();
    await startOptical(h);
    let release = () => {};
    if (failure === "reject") h.failWrites(new Error("STOP rejected"));
    else release = h.blockWrites();
    const stopping = h.ring.stopOpticalDiagnostic();
    await settle();
    await h.advance(3_000);
    await stopping;
    assert.equal(h.ring.state, "disconnected");
    assert.equal(h.ring.diagnostics.opticalState, "error");
    assert.match(h.ring.diagnostics.lastError, /Optical STOP did not complete/);
    release();
    await h.advance(120_000);
    assert.equal(h.ring.diagnostics.startsSent, 1);
    assert.equal(opticalWrites(h).length, 2);
    assert.equal(h.timers.size, 0);
  }
});

test("stop and disconnect cancel the preparing quiet delay without any raw START", async () => {
  for (const action of ["stop", "disconnect"]) {
    const h = verifiedRing();
    await h.ring.scan();
    const starting = h.ring.startOpticalDiagnostic();
    await settle();
    await h.advance(1_000);
    const stopping = action === "stop" ? h.ring.stopOpticalDiagnostic() : h.ring.disconnect();
    await settle();
    await h.advance(5_000);
    await Promise.all([starting, stopping]);
    assert.deepEqual(opticalWrites(h).map((write) => write.bytes.slice(0, 3)), [[0xa1, 2, 0]]);
    assert.equal(h.ring.state, action === "stop" ? "connected" : "disconnected");
    assert.equal(h.ring.diagnostics.startsSent, 1);
    await h.advance(120_000);
    assert.equal(h.timers.size, 0);
  }
});

test("cancelling a pending optical START drains its native write before STOP without overlap", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  const starting = h.ring.startOpticalDiagnostic();
  await settle();
  const release = h.blockWrites();
  await h.advance(2_000);
  assert.deepEqual(opticalWrites(h).map((write) => write.bytes.slice(0, 3)), [[0xa1, 4, 4]]);
  const closing = h.ring.disconnect();
  await settle();
  assert.equal(opticalWrites(h).length, 1);
  release();
  await settle();
  assert.deepEqual(opticalWrites(h).map((write) => write.bytes.slice(0, 3)), [[0xa1, 4, 4], [0xa1, 2, 0]]);
  await h.advance(5_000);
  await Promise.all([starting, closing]);
  assert.equal(h.maximumWrites, 1);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.timers.size, 0);
});

test("Retry and mode changes await raw STOP confirmation before normal measurement START", async () => {
  for (const action of ["retry", "mode"]) {
    const h = verifiedRing();
    await h.ring.scan();
    await startOptical(h);
    const resuming = action === "retry" ? h.ring.retryMeasurement() : h.ring.setHeartRateMode("standard");
    await settle();
    await h.advance(4_999);
    assert.equal(h.ring.diagnostics.startsSent, 1);
    await h.advance(1);
    if (action === "mode") {
      assert.equal(h.ring.diagnostics.startsSent, 1);
      await h.advance(2_000);
    }
    await resuming;
    assert.equal(h.ring.diagnostics.startsSent, 2);
    assert.deepEqual(h.writes.at(-1).bytes.slice(0, 3), [0x69, action === "retry" ? 6 : 1, 1]);
    assert.equal(h.maximumWrites, 1);
  }
});

test("disconnect supersedes a Retry waiting for optical cleanup and forbids a late HR START", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h);
  const retrying = h.ring.retryMeasurement();
  await settle();
  const closing = h.ring.disconnect();
  await settle();
  await h.advance(5_000);
  await Promise.all([retrying, closing]);
  assert.equal(h.ring.state, "disconnected");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.timers.size, 0);
});

test("thirty-second optical capture caps retained frames at 512 while counting all zero frames", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h, 30_000);
  for (let index = 0; index < 520; index++) h.notify(packet(0xa1, index === 0 ? 3 : 2));
  const report = JSON.parse(h.ring.getDebugReport());
  assert.equal(report.opticalDiagnostic.frames.length, 512);
  assert.equal(report.opticalDiagnostic.frames[0].kind, 2);
  assert.equal(report.diagnostics.opticalFramesReceived, 520);
  assert.equal(report.opticalDiagnostic.durationMs, 30_000);
  await h.advance(29_999);
  assert.equal(h.ring.diagnostics.opticalState, "capturing");
  await h.advance(5_001);
  assert.equal(h.ring.diagnostics.opticalState, "completed");
  assert.equal(h.ring.diagnostics.startsSent, 1);
  assert.equal(h.ring.diagnostics.continuesSent, 0);
});

test("unexpected disconnect cancels optical capture timers and retains its incomplete report", async () => {
  const h = verifiedRing();
  await h.ring.scan();
  await startOptical(h);
  h.notify(packet(0xa1, 2));
  h.server.disconnect();
  const count = h.writes.length;
  await h.advance(120_000);
  assert.equal(h.writes.length, count);
  assert.equal(h.ring.diagnostics.opticalState, "error");
  assert.match(h.ring.diagnostics.lastError, /Bluetooth connection lost/);
  assert.equal(h.timers.size, 0);
  assert.equal(JSON.parse(h.ring.getDebugReport()).opticalDiagnostic.frames.length, 1);
});

test("a person's ring is the only one Chrome's chooser lists, unless any ring is asked for", async () => {
  const h = harness({ ringName: "R02_AF03", deviceName: "R02_AF03" });
  assert.equal(await h.ring.scan(), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.lastRequest.filters)), [{ name: "R02_AF03" }]);
  await h.ring.disconnect();
  assert.equal(await h.ring.scan(true), true);
  assert.ok(h.lastRequest.filters.some((filter) => filter.namePrefix === "R02"));
  // Without a name it lists every Colmi ring, as before
  const plain = harness();
  assert.equal(await plain.ring.scan(), true);
  assert.ok(plain.lastRequest.filters.some((filter) => filter.namePrefix === "R02"));
});

test("a remembered ring is found by its name, never the other person's", async () => {
  const other = { name: "R02_D7B0", id: "other-ring-id" };
  const h = harness({ ringName: "R02_AF03", deviceName: "R02_AF03", otherDevices: [other] });
  // Saved for this person by mistake earlier: passed over for the named ring
  h.storage.set("musical-box-ring-1", "other-ring-id");
  await h.ring.restoreSelectedDevice();
  assert.equal(h.ring.device, h.device);
  assert.equal(h.selectionCount, 0);
  assert.equal(h.connectCount, 0);
  // Only the other ring remembered: nothing is picked for this person
  const alone = harness({ ringName: "R02_AF03", deviceName: "R02_D7B0" });
  alone.storage.set("musical-box-ring-1", "test-ring-id");
  await alone.ring.restoreSelectedDevice();
  assert.equal(alone.ring.device, null);
});

test("a cancelled chooser names the ring to choose", async () => {
  const h = harness({ ringName: "R02_AF03", deviceName: "R02_AF03" });
  h.failSelection(new Error("User cancelled the requestDevice chooser"));
  assert.equal(await h.ring.scan(), false);
  assert.equal(h.ring.diagnostics.lastError, "R02_AF03 was not chosen. Make sure it is on and nearby, then press Connect R02_AF03 again.");
});
