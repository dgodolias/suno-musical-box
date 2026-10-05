/* eslint-disable @typescript-eslint/no-require-imports -- Node's dependency-free CommonJS test harness. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function loadModule(file, dependencies = {}, globals = {}) {
  const source = readFileSync(path.join(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, console: { error() {} }, ...globals };
  context.require = (name) => {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  };
  vm.runInNewContext(output, context, { filename: file });
  return context.exports;
}

// Exercise the real page callbacks with a deterministic clock and no browser,
// network, database, or music-generation service.
function pageHarness({ sunoDisabled = false } = {}) {
  let now = 1_800_000_000_000;
  let nextTimer = 1;
  let hookIndex = 0;
  let dirty = false;
  let tree;
  let nextSession = 1;
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const requests = [];
  const uploadResponses = [];
  const generationResponses = [];
  const pollResponses = [];
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useRef(value) {
      const index = hookIndex++;
      return hooks[index] ??= { current: value };
    },
    useState(value) {
      const index = hookIndex++;
      hooks[index] ??= { value };
      return [hooks[index].value, (update) => {
        const next = typeof update === "function" ? update(hooks[index].value) : update;
        if (!Object.is(hooks[index].value, next)) dirty = true;
        hooks[index].value = next;
      }];
    },
    useCallback(callback, deps) {
      const index = hookIndex++;
      if (!equalDeps(hooks[index]?.deps, deps)) hooks[index] = { callback, deps };
      return hooks[index].callback;
    },
    useEffect(effect, deps) {
      const index = hookIndex++;
      if (!equalDeps(hooks[index]?.deps, deps)) effects.push(() => {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps, cleanup: effect() };
      });
    },
    useSyncExternalStore() { hookIndex++; return false; },
  };
  class Clock extends Date { static now() { return now; } }
  const jsx = (type, props) => ({ type, props });
  const biometrics = loadModule("lib/biometrics.ts");
  const Home = loadModule("app/page.tsx", {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/ui/button": { Button: "Button" },
    "@/components/ring-card": { default: "RingCard" },
    "@/components/session-panel": { default: "SessionPanel" },
    "@/components/music-player": { default: "MusicPlayer" },
    "next/image": { default: "Image" },
    "@/components/floating-icons": { default: "FloatingIcons" },
    "@/components/theme-toggle": { default: "ThemeToggle" },
    "@/lib/biometrics": biometrics,
    "@/lib/prompt-builder": { buildPrompt: () => ({ prompt: "genres", style: "genres" }) },
  }, {
    Date: Clock,
    process: { env: { NEXT_PUBLIC_SUNO_DISABLED: String(sunoDisabled), NODE_ENV: "test" } },
    AbortController,
    setInterval(callback, interval) {
      const id = nextTimer++;
      timers.set(id, { callback, interval, next: now + interval });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, interval: null, next: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options = {}) {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body, signal: options.signal });
      if (url === "/api/readings") {
        const response = uploadResponses.length ? uploadResponses.shift() : { ok: true };
        if (!options.signal) return await response;
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(new Error("Upload aborted"));
          options.signal.addEventListener("abort", onAbort, { once: true });
        });
        try { return await Promise.race([response, aborted]); }
        finally { options.signal.removeEventListener("abort", onAbort); }
      }
      if (url === "/api/sessions") return { ok: true, json: async () => body.action ? {} : { sessionId: nextSession++ } };
      if (url === "/api/generate") return generationResponses.length ? await generationResponses.shift() : { ok: true, json: async () => ({}) };
      if (url.startsWith("/api/generate/")) return pollResponses.length ? await pollResponses.shift() : { ok: true, json: async () => ({ status: "pending" }) };
      throw new Error(`Unexpected URL: ${url}`);
    },
  }).default;
  function render() {
    do {
      dirty = false;
      hookIndex = 0;
      tree = Home();
      for (const effect of effects.splice(0)) effect();
    } while (dirty);
  }
  function find(type, predicate = () => true, node = tree) {
    if (!node || typeof node !== "object") return null;
    if (node.type === type && predicate(node.props)) return node.props;
    for (const child of [node.props?.children].flat(Infinity)) {
      if (child === undefined || child === null) continue;
      const result = find(type, predicate, child);
      if (result) return result;
    }
    return null;
  }
  async function settle() {
    for (let i = 0; i < 12; i++) { await Promise.resolve(); if (dirty) render(); }
  }
  render();
  return {
    requests, uploadResponses, generationResponses, pollResponses,
    get now() { return now; },
    uploads: () => requests.filter((r) => r.url === "/api/readings"),
    generations: () => requests.filter((r) => r.url === "/api/generate"),
    session: () => find("SessionPanel"),
    player: () => find("MusicPlayer"),
    banner: () => find("div", (props) => props.role === "status"),
    async start() {
      await find("Button", (props) => props.children === "Start Session").onClick();
      await settle();
    },
    async stop() {
      const promise = find("Button", (props) => props.children === "Stop").onClick();
      await settle();
      await promise;
      await settle();
    },
    reading(personId, heartRate, timestamp = now) {
      find("RingCard", (props) => props.personId === personId).onData(personId, {
        heartRate, lastUpdate: timestamp, spo2: null, rawPpg: null,
        accelX: null, accelY: null, accelZ: null, batteryLevel: null, isCharging: false,
      });
    },
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.next <= end).sort((a, b) => a[1].next - b[1].next)[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.next;
        if (timer.interval === null) timers.delete(id);
        else timer.next += timer.interval;
        timer.callback();
        await settle();
      }
      now = end;
      await settle();
    },
    settle,
  };
}

test("sparse samples upload once; pre-session data is excluded and sensor time is preserved", async () => {
  const page = pageHarness();
  page.reading(1, 50);
  await page.start();
  await page.advance(1000);
  const measuredAt = page.now - 500;
  page.reading(1, 80, measuredAt);
  await page.advance(29000);
  assert.equal(page.uploads().length, 1);
  assert.equal(page.uploads()[0].body.readings.length, 1);
  assert.equal(page.uploads()[0].body.readings[0].timestamp, measuredAt);
  assert.equal(page.generations().length, 1);
  assert.equal(page.generations()[0].body.snapshot, null);
  page.reading(1, 100);
  await page.advance(10000);
  assert.equal(page.uploads().length, 1, "finished collection must not silently restart");
  assert.equal(page.generations().length, 1);
});

test("bursts above ten samples are preserved and successful batches are not resent", async () => {
  const page = pageHarness();
  await page.start();
  for (let i = 0; i < 30; i++) page.reading(i % 2 + 1, 70 + i);
  await page.advance(10000);
  assert.equal(page.uploads().length, 1);
  assert.equal(page.uploads()[0].body.readings.length, 30);
});

test("failed HTTP batches are retained, wait for cooldown, and keep their original session", async () => {
  const page = pageHarness();
  page.uploadResponses.push({ ok: false, status: 503 });
  await page.start();
  page.reading(1, 70);
  await page.advance(5000);
  await page.stop();
  await page.start();
  page.reading(2, 90);
  await page.advance(10000);
  assert.deepEqual(page.uploads().map((r) => r.body.sessionId), [1, 2]);
  await page.advance(5000);
  assert.deepEqual(page.uploads().map((r) => r.body.sessionId), [1, 2, 1]);
  assert.equal(page.uploads()[2].body.readings[0].heartRate, 70);
});

test("samples arriving during an upload remain queued after its acknowledgement", async () => {
  const page = pageHarness();
  let finish;
  page.uploadResponses.push(new Promise((resolve) => { finish = resolve; }));
  await page.start();
  page.reading(1, 70);
  await page.advance(5000);
  page.reading(1, 85);
  await page.advance(5000);
  assert.equal(page.uploads().length, 1, "in-flight upload cannot be duplicated");
  finish({ ok: true });
  await page.settle();
  await page.advance(5000);
  assert.deepEqual(page.uploads().map((r) => r.body.readings.map((reading) => reading.heartRate)), [[70], [85]]);
});

test("a hung upload aborts, releases the worker, and retries its retained samples after cooldown", async () => {
  const page = pageHarness();
  page.uploadResponses.push(new Promise(() => {}));
  await page.start();
  page.reading(1, 70);
  await page.advance(19000);
  page.reading(1, 85);
  assert.equal(page.uploads().length, 1);
  assert.equal(page.uploads()[0].signal.aborted, false);
  await page.advance(1000);
  assert.equal(page.uploads()[0].signal.aborted, true);
  await page.advance(15000);
  assert.equal(page.uploads().length, 2);
  assert.deepEqual(page.uploads()[1].body.readings.map((reading) => reading.heartRate), [70, 85]);
  await page.advance(10000);
  assert.equal(page.uploads().length, 2);
});

test("a stopped session's in-flight song response cannot stop or update a newer session", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "old-task" }) });
  let finishPoll;
  page.pollResponses.push(new Promise((resolve) => { finishPoll = resolve; }));
  await page.start();
  await page.advance(40000);
  assert.equal(page.requests.filter((request) => request.url === "/api/generate/old-task").length, 1);
  await page.stop();
  await page.start();
  finishPoll({ ok: true, json: async () => ({ status: "ready", audioUrl: "https://test.invalid/old-song.mp3" }) });
  await page.settle();
  assert.equal(page.session().isActive, true);
  assert.equal(page.session().status, "Collecting biometric data...");
  assert.equal(page.player().currentSong, null);
  const progress = page.player().generationProgress;
  await page.advance(1000);
  assert.equal(page.player().generationProgress, progress, "cancelled progress animation cannot update newer state");
  await page.advance(29000);
  assert.equal(page.generations().length, 2, "new session reaches its own generation window");
  assert.equal(page.generations()[1].body.sessionId, 2);
});

test("a late generation submission response cannot start polling after its session was stopped", async () => {
  const page = pageHarness();
  let finishGeneration;
  page.generationResponses.push(new Promise((resolve) => { finishGeneration = resolve; }));
  await page.start();
  await page.advance(30000);
  await page.stop();
  await page.start();
  finishGeneration({ ok: true, json: async () => ({ taskId: "cancelled-task" }) });
  await page.settle();
  await page.advance(10000);
  assert.equal(page.session().status, "Collecting biometric data...");
  assert.equal(page.requests.some((request) => request.url === "/api/generate/cancelled-task"), false);
});

test("ring-test mode collects readings without any generation or polling request", async () => {
  const page = pageHarness({ sunoDisabled: true });
  assert.equal(page.banner().children, "Music generation paused for ring tests");
  await page.start();
  page.reading(1, 80);
  await page.advance(40000);
  assert.equal(page.uploads().length, 1);
  assert.equal(page.requests.some((request) => request.url.startsWith("/api/generate")), false);
  assert.equal(page.session().isActive, false);
  assert.equal(page.player().generationStatus, "Music generation paused for ring tests");
  await page.start();
  assert.equal(page.session().isActive, true, "ring collection can be started again");
});

test("server pause response stops a stale client's active music poll", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "paused-task" }) });
  page.pollResponses.push({ ok: false, status: 423 });
  await page.start();
  await page.advance(70000);
  assert.equal(page.requests.filter((request) => request.url === "/api/generate/paused-task").length, 1);
  assert.equal(page.session().isActive, false);
  assert.equal(page.player().generationStatus, "Music generation paused for ring tests");
  assert.equal(page.player().generationProgress, 0);
});

test("both disabled Suno routes return 423 before body/params, network, or database work", async () => {
  const forbidden = () => { throw new Error("Disabled Suno route attempted a side effect"); };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/db": { insertSong: forbidden, updateSongAudio: forbidden },
  };
  const globals = { process: { env: { SUNO_DISABLED: "true" } }, fetch: forbidden };
  const generate = loadModule("app/api/generate/route.ts", dependencies, globals);
  const status = loadModule("app/api/generate/[taskId]/route.ts", dependencies, globals);
  const post = await generate.POST({ json: forbidden });
  const get = await status.GET({}, { params: { then: forbidden } });
  assert.equal(post.status, 423);
  assert.equal(get.status, 423);
  assert.equal(post.body.error, "Music generation paused for ring tests");
  assert.equal(get.body.error, post.body.error);
});

test("snapshot uses only the current window and never substitutes a missing person", async () => {
  const page = pageHarness();
  await page.start();
  for (let i = 0; i < 10; i++) page.reading(1, 55);
  await page.stop();
  await page.start();
  for (let i = 0; i < 5; i++) {
    page.reading(1, 100);
    page.reading(2, 80);
  }
  page.reading(1, 40, page.now - 1);
  await page.advance(30000);
  const snapshot = page.generations()[0].body.snapshot;
  assert.equal(snapshot.person1.avgHr, 100);
  assert.equal(snapshot.person2.avgHr, 80);
  assert.equal(snapshot.person1.sampleCount, 5);
});

test("one measured person does not create a fabricated two-person snapshot", async () => {
  const page = pageHarness();
  await page.start();
  for (let i = 0; i < 8; i++) page.reading(1, 80 + i);
  await page.advance(30000);
  assert.equal(page.generations()[0].body.snapshot, null);
  assert.equal(page.uploads()[0].body.readings.length, 8, "individual readings are still saved");
});

test("readings API rejects missing acquisition time before reaching the database", async () => {
  const inserted = [];
  const route = loadModule("app/api/readings/route.ts", {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/db": { insertReadings: async (...args) => { inserted.push(args); return args[1].length; } },
  });
  const invalid = await route.POST({ json: async () => ({ sessionId: 1, readings: [{ personId: 1 }] }) });
  assert.equal(invalid.status, 400);
  assert.equal(inserted.length, 0);
  const valid = await route.POST({ json: async () => ({ sessionId: 1, readings: [{ personId: 1, timestamp: 1_800_000_000_000 }] }) });
  assert.equal(valid.status, 200);
  assert.equal(inserted[0][1][0].timestamp, 1_800_000_000_000);
});

test("database writes sensor timestamps in one atomic batch", async () => {
  const transactions = [];
  const sql = (strings, ...values) => ({ statement: strings.join("?"), values });
  sql.transaction = async (queries) => { transactions.push(queries); };
  const db = loadModule("lib/db.ts", { "@neondatabase/serverless": { neon: () => sql } }, { process: { env: {} } });
  const timestamp = 1_800_000_000_000;
  const sample = { personId: 1, timestamp, heartRate: 80, spo2: null, temperature: null, hrv: null, rawPpg: null, accelX: null, accelY: null, accelZ: null };
  assert.equal(await db.insertReadings(7, [sample, { ...sample, personId: 2 }]), 2);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].length, 2);
  assert.match(transactions[0][0].statement, /person_id, timestamp, heart_rate/);
  assert.equal(transactions[0][0].values[2], new Date(timestamp).toISOString());
});
