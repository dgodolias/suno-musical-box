/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS regression harness. */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { IDBFactory } = require("fake-indexeddb");

function harness() {
  const source = readFileSync(path.join(__dirname, "../lib/recording-outbox.ts"), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, indexedDB: new IDBFactory(), AbortController, setTimeout, clearTimeout, console };
  vm.runInNewContext(output, context);
  return context.exports;
}

function session(overrides = {}) {
  return {
    clientSessionId: randomUUID(), serverSessionId: null, startedAt: 1_800_000_000_000,
    endedAt: null, endAcknowledged: false, notes: "Unit test", genre1: null, genre2: null,
    generationAttempted: false, retired: false, person1Count: 0, person2Count: 0, acknowledgedCount: 0,
    ...overrides,
  };
}

function sample(overrides = {}) {
  return {
    sampleId: randomUUID(), personId: 1, timestamp: 1_800_000_001_000,
    heartRate: 70, spo2: null, temperature: null, hrv: null, rawPpg: null,
    accelX: null, accelY: null, accelZ: null, ...overrides,
  };
}

function server() {
  const sessions = new Map();
  const samples = new Map();
  const requests = [];
  const loseNext = new Set();
  return {
    sessions, samples, requests, loseNext,
    async fetch(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      let response;
      if (url === "/api/sessions" && body.action === "end") {
        const row = sessions.get(body.clientSessionId);
        assert.equal(row.sessionId, body.sessionId);
        row.endedAt ??= body.endedAt;
        response = { ok: true };
      } else if (url === "/api/sessions") {
        if (!sessions.has(body.clientSessionId)) sessions.set(body.clientSessionId, { ...body, sessionId: sessions.size + 1 });
        response = sessions.get(body.clientSessionId);
      } else if (url === "/api/readings") {
        for (const reading of body.readings) if (!samples.has(reading.sampleId)) samples.set(reading.sampleId, { ...reading, sessionId: body.sessionId });
        response = { acknowledgedSampleIds: body.readings.map((reading) => reading.sampleId) };
      } else throw new Error("Unexpected endpoint");
      if (loseNext.delete(body.action === "end" ? "end" : url)) throw new Error("Response lost after commit");
      return { ok: true, json: async () => response };
    },
  };
}

test("IndexedDB atomically counts samples, idempotent acknowledgements, and independent participants", async () => {
  const { IndexedDbRecordingStorage } = harness();
  const storage = new IndexedDbRecordingStorage();
  await storage.open();
  const parent = session();
  await storage.createSession(parent);
  const samples = Array.from({ length: 40 }, (_, index) => ({ ...sample({ personId: index % 2 + 1 }), clientSessionId: parent.clientSessionId, uploaded: 0 }));
  await Promise.all(samples.map((reading) => storage.addReading(reading)));
  await storage.addReading(samples[0]);
  await storage.acknowledge(parent.clientSessionId, samples.map((reading) => reading.sampleId));
  await storage.acknowledge(parent.clientSessionId, [samples[0].sampleId, samples[0].sampleId]);
  const saved = await storage.getSession(parent.clientSessionId);
  assert.equal(saved.person1Count, 20);
  assert.equal(saved.person2Count, 20);
  assert.equal(saved.acknowledgedCount, 40);
  assert.equal((await storage.readings(parent.clientSessionId, true)).length, 0);
  assert.equal((await storage.readings(parent.clientSessionId, false)).length, 40);
});

test("IndexedDB rejects reused sample identity and samples outside their session", async () => {
  const { IndexedDbRecordingStorage } = harness();
  const storage = new IndexedDbRecordingStorage();
  await storage.open();
  const first = session({ endedAt: 1_800_000_002_000 });
  const second = session();
  await storage.createSession(first);
  await storage.createSession(second);
  const reading = { ...sample(), clientSessionId: first.clientSessionId, uploaded: 0 };
  await storage.addReading(reading);
  await assert.rejects(storage.addReading({ ...reading, clientSessionId: second.clientSessionId }));
  await assert.rejects(storage.addReading({ ...reading, heartRate: 90 }));
  await assert.rejects(storage.addReading({ ...reading, sampleId: randomUUID(), timestamp: first.startedAt - 1 }));
  await assert.rejects(storage.addReading({ ...reading, sampleId: randomUUID(), timestamp: first.endedAt + 1 }));
  assert.equal((await storage.getSession(first.clientSessionId)).person1Count, 1);
  assert.equal((await storage.getSession(second.clientSessionId)).person1Count, 0);
});

test("lost create/sample/end responses survive a new outbox instance without duplicate rows", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const api = server();
  const parent = session();
  const reading = sample();
  let now = parent.startedAt;
  let storage = new IndexedDbRecordingStorage();
  let worker = new RecordingOutbox(storage, api.fetch, () => now);
  await worker.initialize();
  await worker.createSession(parent);
  await worker.append(parent.clientSessionId, reading);
  api.loseNext.add("/api/sessions");
  await worker.flush();
  assert.equal(api.sessions.size, 1);
  assert.equal((await storage.getSession(parent.clientSessionId)).serverSessionId, null);
  storage = new IndexedDbRecordingStorage();
  worker = new RecordingOutbox(storage, api.fetch, () => now);
  await worker.initialize();
  api.loseNext.add("/api/readings");
  await worker.flush();
  assert.equal(api.samples.size, 1);
  assert.equal((await storage.getSession(parent.clientSessionId)).acknowledgedCount, 0);
  await worker.updateSession(parent.clientSessionId, { endedAt: reading.timestamp + 500 });
  now += 15000;
  api.loseNext.add("end");
  await worker.flush();
  assert.equal(api.samples.size, 1);
  assert.equal((await storage.getSession(parent.clientSessionId)).endAcknowledged, false);
  now += 15000;
  await worker.flush();
  const saved = await storage.getSession(parent.clientSessionId);
  assert.equal(saved.acknowledgedCount, 1);
  assert.equal(saved.endAcknowledged, true);
  assert.equal(api.sessions.get(parent.clientSessionId).endedAt, reading.timestamp + 500);
  assert.equal(api.samples.get(reading.sampleId).timestamp, reading.timestamp);
  assert.equal(api.sessions.size, 1);
  assert.equal(api.samples.size, 1);
});

test("more than one batch uploads every actual field and pruning waits for end acknowledgement", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const storage = new IndexedDbRecordingStorage();
  const api = server();
  const worker = new RecordingOutbox(storage, api.fetch);
  await worker.initialize();
  const parent = session();
  await worker.createSession(parent);
  for (let index = 0; index < 510; index++) {
    await worker.append(parent.clientSessionId, sample({ personId: index % 2 + 1, rawPpg: index, timestamp: parent.startedAt + index }));
  }
  await worker.flush();
  assert.deepEqual(api.requests.filter((request) => request.url === "/api/readings").map((request) => request.body.readings.length), [250, 250, 10]);
  assert.equal(api.samples.size, 510);
  await worker.retire(parent.clientSessionId);
  assert.ok(await storage.getSession(parent.clientSessionId), "an open session cannot be pruned");
  await worker.updateSession(parent.clientSessionId, { endedAt: parent.startedAt + 1000 });
  await worker.flush();
  assert.equal(await storage.getSession(parent.clientSessionId), undefined);
  assert.equal((await storage.readings(parent.clientSessionId, false)).length, 0);
  assert.equal(api.samples.size, 510, "retirement deletes only the acknowledged local cache");
});

test("partial acknowledgements retain only unacknowledged IDs and respect retry cooldown", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const storage = new IndexedDbRecordingStorage();
  const api = server();
  let now = 1_800_000_000_000;
  let firstBatch = true;
  const worker = new RecordingOutbox(storage, async (url, options) => {
    const response = await api.fetch(url, options);
    if (url === "/api/readings" && firstBatch) {
      firstBatch = false;
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ acknowledgedSampleIds: [body.readings[0].sampleId] }) };
    }
    return response;
  }, () => now);
  await worker.initialize();
  const parent = session();
  await worker.createSession(parent);
  await worker.append(parent.clientSessionId, sample());
  await worker.append(parent.clientSessionId, sample({ personId: 2 }));
  await worker.flush();
  assert.equal((await storage.getSession(parent.clientSessionId)).acknowledgedCount, 1);
  await worker.flush();
  assert.equal(api.requests.filter((request) => request.url === "/api/readings").length, 1);
  now += 15000;
  await worker.flush();
  assert.equal(api.requests.filter((request) => request.url === "/api/readings")[1].body.readings.length, 1);
  assert.equal((await storage.getSession(parent.clientSessionId)).acknowledgedCount, 2);
});

test("an observation failing local persistence during upload prevents premature end/pruning", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const storage = new IndexedDbRecordingStorage();
  const api = server();
  let finishUpload;
  let beganUpload;
  const started = new Promise((resolve) => { beganUpload = resolve; });
  const worker = new RecordingOutbox(storage, async (url, options) => {
    const response = await api.fetch(url, options);
    if (url === "/api/readings" && !finishUpload) {
      beganUpload();
      await new Promise((resolve) => { finishUpload = resolve; });
    }
    return response;
  });
  await worker.initialize();
  const parent = session();
  await worker.createSession(parent);
  await worker.append(parent.clientSessionId, sample());
  const uploading = worker.flush();
  await started;
  const originalAdd = storage.addReading.bind(storage);
  storage.addReading = async () => { throw new Error("Temporary quota failure"); };
  await worker.append(parent.clientSessionId, sample({ personId: 2 }));
  await worker.updateSession(parent.clientSessionId, { endedAt: parent.startedAt + 2000 });
  await worker.retire(parent.clientSessionId);
  finishUpload();
  await uploading;
  assert.ok(await storage.getSession(parent.clientSessionId));
  assert.equal(api.requests.some((request) => request.body.action === "end"), false);
  storage.addReading = originalAdd;
  await worker.flush();
  assert.equal(api.samples.size, 2);
  assert.equal(await storage.getSession(parent.clientSessionId), undefined);
});

test("reload during an in-flight upload cannot duplicate rows or acknowledgement counts", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const api = server();
  let finish;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  const firstStorage = new IndexedDbRecordingStorage();
  const first = new RecordingOutbox(firstStorage, async (url, options) => {
    const response = await api.fetch(url, options);
    if (url === "/api/readings") {
      began();
      await new Promise((resolve) => { finish = resolve; });
    }
    return response;
  });
  await first.initialize();
  const parent = session();
  await first.createSession(parent);
  await first.append(parent.clientSessionId, sample());
  const pending = first.flush();
  await started;
  const secondStorage = new IndexedDbRecordingStorage();
  const second = new RecordingOutbox(secondStorage, api.fetch);
  await second.initialize();
  await second.append(parent.clientSessionId, sample({ personId: 2 }));
  await second.flush();
  finish();
  await pending;
  assert.equal(api.samples.size, 2);
  assert.equal((await secondStorage.getSession(parent.clientSessionId)).acknowledgedCount, 2);
  assert.equal((await secondStorage.readings(parent.clientSessionId, true)).length, 0);
});

test("a malformed successful end response cannot mark the session saved or prune local data", async () => {
  const { IndexedDbRecordingStorage, RecordingOutbox } = harness();
  const storage = new IndexedDbRecordingStorage();
  const api = server();
  let now = 1_800_000_000_000;
  let malformed = true;
  const worker = new RecordingOutbox(storage, async (url, options) => {
    const response = await api.fetch(url, options);
    if (JSON.parse(options.body).action === "end" && malformed) return { ok: true, json: async () => ({}) };
    return response;
  }, () => now);
  await worker.initialize();
  const parent = session({ endedAt: now + 2000, retired: true });
  await worker.createSession(parent);
  await worker.append(parent.clientSessionId, sample());
  await worker.flush();
  assert.equal((await storage.getSession(parent.clientSessionId)).endAcknowledged, false);
  assert.equal((await storage.readings(parent.clientSessionId, false)).length, 1);
  malformed = false;
  now += 15000;
  await worker.flush();
  assert.equal(await storage.getSession(parent.clientSessionId), undefined);
  assert.equal(api.samples.size, 1);
});
