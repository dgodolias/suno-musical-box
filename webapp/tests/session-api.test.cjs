/* eslint-disable @typescript-eslint/no-require-imports -- Dependency-free Node CommonJS tests. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const CLIENT_ID = "a4b67213-d2a5-4e79-9ce7-18f192eca032";
const SAMPLE_ID = "19e64105-7239-4b11-b0a1-056fd708e616";
const OTHER_SAMPLE = "a7d0c590-4aab-4544-9f60-a06af9675e10";
const STARTED_AT = 1_800_000_000_123;
const json = (value) => JSON.parse(JSON.stringify(value));
const request = (body) => ({ json: async () => body });

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, ...globals, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

function routes(overrides = {}) {
  const calls = [];
  const db = {
    async createSession(...args) { calls.push(["create", ...args]); return 42; },
    async endSession(...args) { calls.push(["end", ...args]); return true; },
    async insertReadings(...args) {
      calls.push(["readings", ...args]);
      const acknowledgedSampleIds = [...new Set(args[1].map((reading) => reading.sampleId))];
      return { count: acknowledgedSampleIds.length, acknowledgedSampleIds };
    },
    ...overrides,
  };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/db": db,
  };
  return {
    calls,
    sessions: load("app/api/sessions/route.ts", dependencies),
    readings: load("app/api/readings/route.ts", dependencies),
  };
}

function database() {
  const queries = [];
  const transactions = [];
  const directResults = [];
  const transactionResults = [];
  const sql = (strings, ...values) => {
    const query = {
      statement: strings.join("?"), values,
      then(resolve, reject) {
        queries.push(query);
        return Promise.resolve(directResults.shift() || []).then(resolve, reject);
      },
    };
    return query;
  };
  sql.transaction = async (batch) => {
    transactions.push(batch);
    const result = transactionResults.shift();
    if (result instanceof Error) throw result;
    return result || batch.map(() => []);
  };
  return {
    queries, transactions, directResults, transactionResults,
    db: load("lib/db.ts", { "@neondatabase/serverless": { neon: () => sql } }, { process: { env: {} } }),
  };
}

test("session creation retries keep a stable UUID and original acquisition timestamp", async () => {
  const h = routes();
  const body = { clientSessionId: CLIENT_ID, startedAt: STARTED_AT, notes: "Two rings" };
  const first = await h.sessions.POST(request(body));
  const retry = await h.sessions.POST(request(body));
  assert.equal(first.status, 200);
  assert.deepEqual(json(first.body), { sessionId: 42, clientSessionId: CLIENT_ID });
  assert.deepEqual(json(retry.body), json(first.body));
  assert.deepEqual(json(h.calls), [
    ["create", CLIENT_ID, STARTED_AT, "Two rings"],
    ["create", CLIENT_ID, STARTED_AT, "Two rings"],
  ]);
  const storage = database();
  storage.directResults.push([{ id: 42 }], [{ id: 42 }]);
  assert.equal(await storage.db.createSession(CLIENT_ID, STARTED_AT, "Two rings"), 42);
  assert.equal(await storage.db.createSession(CLIENT_ID, STARTED_AT + 10_000, "Retry"), 42);
  const query = storage.queries[0];
  assert.match(query.statement, /ON CONFLICT \(client_session_id\) DO UPDATE/);
  assert.match(query.statement, /SET client_session_id = EXCLUDED.client_session_id/);
  assert.doesNotMatch(query.statement, /SET (started_at|notes)|NOW\(\)/);
  assert.equal(query.values[1], new Date(STARTED_AT).toISOString());
});

test("ending binds both session IDs, preserves supplied time and rejects mismatches", async () => {
  const endedAt = STARTED_AT + 125_456;
  const h = routes();
  assert.equal((await h.sessions.POST(request({ action: "end", sessionId: 42, clientSessionId: CLIENT_ID, endedAt }))).status, 200);
  assert.deepEqual(json(h.calls[0]), ["end", 42, CLIENT_ID, endedAt]);
  const mismatch = routes({ endSession: async () => false });
  assert.equal((await mismatch.sessions.POST(request({ action: "end", sessionId: 43, clientSessionId: CLIENT_ID, endedAt }))).status, 409);
  const storage = database();
  storage.directResults.push([{ id: 42 }], []);
  assert.equal(await storage.db.endSession(42, CLIENT_ID, endedAt), true);
  assert.equal(await storage.db.endSession(43, CLIENT_ID, endedAt), false);
  assert.match(storage.queries[0].statement, /COALESCE\(ended_at,/);
  assert.match(storage.queries[0].statement, /WHERE id = \? AND client_session_id = \?/);
  assert.match(storage.queries[0].statement, /started_at <= \?/);
  assert.doesNotMatch(storage.queries[0].statement, /NOW\(\)/);
  assert.deepEqual(storage.queries[0].values, [new Date(endedAt).toISOString(), 42, CLIENT_ID, new Date(endedAt).toISOString()]);
});

test("session API rejects malformed JSON, invalid IDs, timestamps, actions, and notes before DB", async () => {
  const h = routes();
  const bodies = [
    null, [], "session", {}, { clientSessionId: "bad", startedAt: STARTED_AT },
    { clientSessionId: CLIENT_ID, startedAt: "1800000000000" },
    { clientSessionId: CLIENT_ID, startedAt: 9e15 },
    { clientSessionId: CLIENT_ID, startedAt: STARTED_AT, notes: 8 },
    { clientSessionId: CLIENT_ID, startedAt: STARTED_AT, notes: "x".repeat(10_001) },
    { clientSessionId: CLIENT_ID, startedAt: STARTED_AT, action: "delete" },
    { clientSessionId: CLIENT_ID, action: "end", sessionId: 0, endedAt: STARTED_AT },
    { clientSessionId: CLIENT_ID, action: "end", sessionId: 42, endedAt: -1 },
  ];
  for (const body of bodies) assert.equal((await h.sessions.POST(request(body))).status, 400);
  assert.equal((await h.sessions.POST({ json: async () => { throw new SyntaxError("Bad JSON"); } })).status, 400);
  assert.equal(h.calls.length, 0);
});

test("readings retain timestamp and absent metrics as null and acknowledge duplicates", async () => {
  const h = routes();
  const sample = { sampleId: SAMPLE_ID, personId: 1, timestamp: STARTED_AT + 17, heartRate: 79 };
  const first = await h.readings.POST(request({ sessionId: 42, readings: [sample, sample] }));
  const retry = await h.readings.POST(request({ sessionId: 42, readings: [sample] }));
  assert.deepEqual(json(first.body), { count: 1, acknowledgedSampleIds: [SAMPLE_ID] });
  assert.deepEqual(json(retry.body), json(first.body));
  assert.deepEqual(json(h.calls[0][2][0]), {
    ...sample, spo2: null, temperature: null, hrv: null, rawPpg: null, accelX: null, accelY: null, accelZ: null,
  });
});

test("readings reject malformed records and nonfinite/wrong-type sensors before any insert", async () => {
  const h = routes();
  const sample = { sampleId: SAMPLE_ID, personId: 1, timestamp: STARTED_AT, heartRate: 80 };
  const invalid = [
    null, [], { ...sample, sampleId: undefined }, { ...sample, sampleId: "not-a-uuid" },
    { ...sample, personId: 3 }, { ...sample, timestamp: NaN }, { ...sample, timestamp: 9e15 },
    { ...sample, timestamp: STARTED_AT + 0.5 }, { ...sample, heartRate: "80" },
    { ...sample, temperature: Infinity }, { ...sample, accelX: {} }, { ...sample, hrv: false },
  ];
  for (const bad of invalid) {
    assert.equal((await h.readings.POST(request({ sessionId: 42, readings: [sample, bad] }))).status, 400);
  }
  for (const body of [null, [], {}, { sessionId: "42", readings: [sample] }, { sessionId: 42, readings: [] }, { sessionId: 42, readings: Array(1001).fill(sample) }]) {
    assert.equal((await h.readings.POST(request(body))).status, 400);
  }
  assert.equal((await h.readings.POST({ json: async () => { throw new SyntaxError("Bad JSON"); } })).status, 400);
  assert.equal(h.calls.length, 0);
});

test("readings atomically acknowledge only retries with the same complete observation", async () => {
  const h = database();
  const sample = { sampleId: SAMPLE_ID, personId: 1, timestamp: STARTED_AT, heartRate: 80,
    spo2: null, temperature: null, hrv: null, rawPpg: null, accelX: null, accelY: null, accelZ: null };
  const other = { ...sample, sampleId: OTHER_SAMPLE, personId: 2 };
  h.transactionResults.push([[{ client_sample_id: SAMPLE_ID }], [{ client_sample_id: OTHER_SAMPLE }]]);
  const first = await h.db.insertReadings(42, [sample, other]);
  h.transactionResults.push([[{ client_sample_id: SAMPLE_ID }], [{ client_sample_id: OTHER_SAMPLE }]]);
  const retry = await h.db.insertReadings(42, [sample, other]);
  assert.deepEqual(json(first), { count: 2, acknowledgedSampleIds: [SAMPLE_ID, OTHER_SAMPLE] });
  assert.deepEqual(json(retry), json(first));
  assert.equal(h.transactions.length, 2);
  assert.equal(h.queries.length, 0, "inserts must not execute outside transaction");
  assert.equal(h.transactions[0].length, 2);
  for (const query of h.transactions[0]) {
    assert.match(query.statement, /ON CONFLICT \(client_sample_id\) DO UPDATE/);
    assert.match(query.statement, /SET client_sample_id = biometric_readings.client_sample_id/);
    for (const field of ["session_id", "person_id", "timestamp"]) {
      assert.ok(query.statement.includes(`biometric_readings.${field} = EXCLUDED.${field}`));
    }
    for (const field of ["heart_rate", "spo2", "temperature", "hrv", "raw_ppg", "accel_x", "accel_y", "accel_z"]) {
      assert.ok(query.statement.includes(`biometric_readings.${field} IS NOT DISTINCT FROM EXCLUDED.${field}`));
    }
    assert.match(query.statement, /RETURNING client_sample_id/);
    assert.equal(query.values[3], new Date(STARTED_AT).toISOString());
  }
});

test("failed batches cannot acknowledge samples and another session's UUID is not acknowledged", async () => {
  const h = database();
  const sample = { sampleId: SAMPLE_ID, personId: 1, timestamp: STARTED_AT, heartRate: 80,
    spo2: null, temperature: null, hrv: null, rawPpg: null, accelX: null, accelY: null, accelZ: null };
  h.transactionResults.push(new Error("transaction failed"));
  await assert.rejects(h.db.insertReadings(42, [sample]), /transaction failed/);
  h.transactionResults.push([[]]);
  assert.deepEqual(json(await h.db.insertReadings(43, [sample])), { count: 0, acknowledgedSampleIds: [] });
  const api = routes({ insertReadings: async () => { throw new Error("storage offline"); } });
  await assert.rejects(api.readings.POST(request({ sessionId: 42, readings: [sample] })), /storage offline/);
});

test("a batch cannot reuse one sample ID for another participant, timestamp or sensor value", async () => {
  const h = routes();
  const sample = { sampleId: SAMPLE_ID, personId: 1, timestamp: STARTED_AT, heartRate: 80 };
  for (const change of [
    { personId: 2 }, { timestamp: STARTED_AT + 1 }, { heartRate: 81 }, { spo2: 97 },
    { temperature: 33 }, { hrv: 50 }, { rawPpg: 4 }, { accelX: 0 }, { accelY: 0 }, { accelZ: 1 },
  ]) {
    const result = await h.readings.POST(request({ sessionId: 42, readings: [sample, { ...sample, ...change }] }));
    assert.equal(result.status, 409);
  }
  assert.equal(h.calls.length, 0);
  const same = await h.readings.POST(request({ sessionId: 42, readings: [sample, { ...sample, spo2: null }] }));
  assert.equal(same.status, 200);
  assert.equal(h.calls[0][2].length, 1, "identical IDs are normalized and submitted once");
});
