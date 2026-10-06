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

class MemoryStorage {
  constructor() { this.sessions = new Map(); this.samples = new Map(); this.failWrites = false; }
  async open() {}
  async listSessions() { return [...this.sessions.values()].map((row) => ({ ...row })); }
  async getSession(id) { const row = this.sessions.get(id); return row && { ...row }; }
  async createSession(row) { if (this.failWrites) throw new Error("Storage full"); this.sessions.set(row.clientSessionId, { ...row }); }
  async updateSession(id, patch) {
    if (this.failWrites) throw new Error("Storage full");
    this.sessions.set(id, { ...this.sessions.get(id), ...patch });
  }
  async addReading(row) {
    if (this.failWrites) throw new Error("Storage full");
    if (this.samples.has(row.sampleId)) return;
    const session = this.sessions.get(row.clientSessionId);
    assert.ok(session);
    this.samples.set(row.sampleId, { ...row });
    session[row.personId === 1 ? "person1Count" : "person2Count"]++;
  }
  async readings(id, pendingOnly, limit) {
    return [...this.samples.values()].filter((row) => row.clientSessionId === id && (!pendingOnly || !row.uploaded)).slice(0, limit).map((row) => ({ ...row }));
  }
  async acknowledge(id, ids) {
    for (const sampleId of new Set(ids)) {
      const row = this.samples.get(sampleId);
      if (row?.clientSessionId === id && !row.uploaded) { row.uploaded = 1; this.sessions.get(id).acknowledgedCount++; }
    }
  }
  async prune(id) {
    const session = this.sessions.get(id);
    if (!session?.retired || !session.endAcknowledged || session.acknowledgedCount !== session.person1Count + session.person2Count) return;
    this.sessions.delete(id);
    for (const [sampleId, row] of this.samples) if (row.clientSessionId === id) this.samples.delete(sampleId);
  }
}

// Exercise the real page callbacks with a deterministic clock and no browser,
// network, database, or music-generation service.
function pageHarness({ mockSuno = false, mockBiometrics = false, demo = false, storage = new MemoryStorage(), tabStorage = new Map(), initialNow = 1_800_000_000_000 } = {}) {
  let now = initialNow;
  let nextTimer = 1;
  let hookIndex = 0;
  let dirty = false;
  let tree;
  let nextSession = 1;
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const windowListeners = new Map();
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
    useSyncExternalStore() { hookIndex++; return demo; },
  };
  class Clock extends Date { static now() { return now; } }
  // The SyncWave display's side of the channel: what the page broadcast
  const broadcasts = [];
  const channels = new Set();
  class TestChannel {
    constructor() { this.onmessage = null; channels.add(this); }
    postMessage(message) { broadcasts.push(structuredClone(message)); }
    close() { channels.delete(this); }
  }
  const jsx = (type, props, key) => ({ type, props: { ...props, key } });
  const uuid = require("node:crypto").randomUUID;
  const biometrics = loadModule("lib/biometrics.ts");
  const dependencies = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/components/ui/button": { Button: "Button" },
    "@/components/ring-card": { default: "RingCard" },
    "@/components/session-panel": { default: "SessionPanel" },
    "@/components/music-player": { default: "MusicPlayer" },
    "next/image": { default: "Image" },
    "@/components/floating-icons": { default: "FloatingIcons" },
    "@/components/theme-toggle": { default: "ThemeToggle" },
    "lucide-react": { Tv: "Tv" },
    "@/lib/heart-rate-channel": loadModule("lib/heart-rate-channel.ts"),
    "@/lib/biometrics": biometrics,
    "@/lib/prompt-builder": { buildPrompt: () => ({ prompt: "genres", style: "genres" }) },
  };
  const globals = {
    Date: Clock,
    window: {
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      removeEventListener: (name) => windowListeners.delete(name),
    },
    crypto: { randomUUID: uuid },
    BroadcastChannel: TestChannel,
    sessionStorage: { getItem: (key) => tabStorage.get(key) ?? null, setItem: (key, value) => tabStorage.set(key, value), removeItem: (key) => tabStorage.delete(key) },
    process: { env: { USE_MOCK_SUNO: String(mockSuno), USE_MOCK_BIOMETRICS: String(mockBiometrics), NEXT_PUBLIC_SUNO_DISABLED: "true", NODE_ENV: "test" } },
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
        const response = uploadResponses.length ? uploadResponses.shift() : { ok: true, json: async () => ({ acknowledgedSampleIds: body.readings.map((reading) => reading.sampleId) }) };
        if (!options.signal) return await response;
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(new Error("Upload aborted"));
          options.signal.addEventListener("abort", onAbort, { once: true });
        });
        try { return await Promise.race([response, aborted]); }
        finally { options.signal.removeEventListener("abort", onAbort); }
      }
      if (url === "/api/sessions") return { ok: true, json: async () => body.action ? { ok: true } : { sessionId: nextSession++, clientSessionId: body.clientSessionId } };
      if (url === "/api/generate") return generationResponses.length ? await generationResponses.shift() : { ok: true, json: async () => ({}) };
      if (url.startsWith("/api/generate/")) return pollResponses.length ? await pollResponses.shift() : { ok: true, json: async () => ({ status: "pending" }) };
      throw new Error(`Unexpected URL: ${url}`);
    },
  };
  const outboxModule = loadModule("lib/recording-outbox.ts", {}, globals);
  const outboxes = [];
  class TestOutbox extends outboxModule.RecordingOutbox {
    constructor() { super(storage, globals.fetch, () => now); outboxes.push(this); }
  }
  dependencies["@/lib/recording-outbox"] = { ...outboxModule, RecordingOutbox: TestOutbox };
  const Home = loadModule("app/page.tsx", dependencies, globals).default;
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
    for (let i = 0; i < 150; i++) { await Promise.resolve(); if (dirty) render(); }
  }
  render();
  return {
    requests, uploadResponses, generationResponses, pollResponses, storage, tabStorage, broadcasts,
    hello() { for (const channel of channels) channel.onmessage?.({ data: { type: "hello" } }); },
    flush: () => outboxes[0].flush(),
    unload() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      windowListeners.get("beforeunload")?.(event);
      return event;
    },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); timers.clear(); },
    ring: (personId) => find("RingCard", (props) => props.personId === personId),
    text: () => JSON.stringify(tree),
    get now() { return now; },
    uploads: () => requests.filter((r) => r.url === "/api/readings"),
    generations: () => requests.filter((r) => r.url === "/api/generate"),
    session: () => find("SessionPanel"),
    player: () => find("MusicPlayer"),
    banner: () => find("div", (props) => props.role === "status"),
    async start() {
      await settle();
      await find("Button", (props) => props.children === "Start Session").onClick();
      await settle();
    },
    async stop() {
      const promise = find("Button", (props) => props.children === "Stop").onClick();
      await settle();
      await promise;
      await settle();
    },
    async next() { await find("Button", (props) => props.children === "New Session").onClick(); await settle(); },
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

test("full time series continues beyond 30 seconds and stops at explicit Stop with original timestamps", async () => {
  const page = pageHarness({ mockSuno: true });
  page.reading(1, 50);
  await page.start();
  await page.advance(1000);
  const measuredAt = page.now - 500;
  page.reading(1, 80, measuredAt);
  await page.advance(30000);
  page.reading(1, 80);
  page.reading(2, 90);
  await page.advance(45000);
  const endedAt = page.now;
  await page.stop();
  page.reading(2, 100);
  await page.advance(5000);
  const samples = [...page.storage.samples.values()];
  assert.equal(samples.length, 3);
  assert.equal(samples[0].timestamp, measuredAt);
  assert.equal(new Set(samples.map((row) => row.sampleId)).size, 3);
  assert.deepEqual(samples.map((row) => row.personId), [1, 1, 2]);
  assert.ok(samples.every((row) => row.spo2 === null && row.hrv === null && row.temperature === null));
  const session = [...page.storage.sessions.values()][0];
  assert.equal(session.endedAt, endedAt);
  assert.equal(session.endAcknowledged, true);
  assert.equal(page.generations().length, 1);
  assert.match(page.text(), /Saved/);
});

test("song-ready finishes recording after generation; snapshot stays in the first 20 seconds", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "song" }) });
  page.pollResponses.push({ ok: true, json: async () => ({ status: "pending" }) });
  page.pollResponses.push({ ok: true, json: async () => ({ status: "ready", audioUrl: "https://test.invalid/song.mp3" }) });
  await page.start();
  for (let i = 0; i < 5; i++) { page.reading(1, 70); page.reading(2, 80); }
  await page.advance(21000);
  page.reading(1, 150);
  await page.advance(8000);
  page.reading(2, 160);
  await page.advance(1000);
  assert.equal(page.session().isActive, false);
  assert.equal(page.player().currentSong.taskId, "song");
  assert.equal(page.player().generationProgress, 100);
  assert.equal(page.generations()[0].body.snapshot.person1.avgHr, 70);
  assert.equal(page.generations()[0].body.snapshot.person2.avgHr, 80);
  const session = [...page.storage.sessions.values()][0];
  assert.equal(session.endedAt - session.startedAt, 30000);
  assert.equal([...page.storage.samples.values()].length, 12);
  assert.equal(session.acknowledgedCount, 12);
});

test("music is requested at 20 s but shown from 30 s, with its bar already under way", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "early" }) });
  await page.start();
  for (let i = 0; i < 5; i++) { page.reading(1, 70); page.reading(2, 80); }
  await page.advance(19000);
  assert.equal(page.generations().length, 0);
  await page.advance(2000);
  assert.equal(page.generations().length, 1);
  assert.equal(page.player().generationProgress, 0);
  assert.equal(page.player().generationStatus, "Recording biometric data...");
  assert.equal(page.session().status, "Recording biometric data...");
  await page.advance(10000);
  // 11 s after the request, against an expected 40 s
  assert.ok(page.player().generationProgress >= 23, `progress ${page.player().generationProgress}`);
  assert.ok(page.player().generationProgress <= 27, `progress ${page.player().generationProgress}`);
  assert.equal(page.player().generationStatus, "Generating music... Recording continues.");
  assert.equal(page.session().collectSeconds, 30);
});

test("a song ready before 30 s still records the whole window", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "quick" }) });
  page.pollResponses.push({ ok: true, json: async () => ({ status: "ready", audioUrl: "https://test.invalid/quick.mp3" }) });
  await page.start();
  await page.advance(25000);
  assert.equal(page.requests.filter((request) => request.url === "/api/generate/quick").length, 1);
  assert.equal(page.player().currentSong, null);
  assert.equal(page.session().isActive, true);
  await page.advance(10000);
  assert.equal(page.player().currentSong.taskId, "quick");
  const session = [...page.storage.sessions.values()][0];
  assert.equal(session.endedAt - session.startedAt, 30000);
});

test("the music bar follows the measured Suno time and keeps creeping if it runs late", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "slow" }) });
  await page.start();
  await page.advance(60000);
  // 40 s after the request: the expected time
  assert.equal(page.player().generationProgress, 90);
  await page.advance(60000);
  assert.ok(page.player().generationProgress > 90 && page.player().generationProgress <= 99);
  assert.ok(page.requests.filter((request) => request.url === "/api/generate/slow").length >= 25);
});

test("New Session resets session/player/genres while retaining both ring connection refs", async () => {
  const page = pageHarness({ mockSuno: true });
  await page.settle();
  page.ring(1).onConnectionChange(1, true);
  page.ring(2).onConnectionChange(2, true);
  page.ring(1).onGenreChange("rock");
  page.ring(2).onGenreChange("jazz");
  await page.settle();
  const ref1 = page.ring(1).connectionRef;
  const ref2 = page.ring(2).connectionRef;
  const connection = { connected: true };
  ref1.current = connection;
  const playerKey = page.player().key;
  await page.start();
  page.reading(1, 80);
  await page.stop();
  await page.next();
  assert.equal(page.ring(1).connectionRef, ref1);
  assert.equal(page.ring(2).connectionRef, ref2);
  assert.equal(ref1.current, connection);
  assert.equal(page.ring(1).genre, null);
  assert.equal(page.ring(2).genre, null);
  assert.equal(page.player().currentSong, null);
  assert.equal(page.player().history.length, 0);
  assert.equal(page.player().generationStatus, "");
  assert.equal(page.player().generationProgress, 0);
  assert.notEqual(page.player().key, playerKey);
  assert.equal(page.session().collectSeconds, 0);
  await page.start();
  assert.equal(page.session().isActive, true);
});

test("offline samples survive New Session and retain their original parent identity", async () => {
  const page = pageHarness({ mockSuno: true });
  page.uploadResponses.push({ ok: false, status: 503 });
  await page.start();
  page.reading(1, 70);
  await page.advance(5000);
  await page.stop();
  const oldId = [...page.storage.sessions.keys()][0];
  await page.next();
  assert.equal(page.storage.sessions.get(oldId).retired, true);
  await page.start();
  page.reading(2, 90);
  await page.advance(10000);
  assert.match(page.text(), /pending upload/);
  await page.advance(5000);
  assert.equal(page.storage.sessions.has(oldId), false, "only fully acknowledged retired local data is pruned");
  const uploads = page.uploads();
  assert.equal(uploads[0].body.readings[0].sampleId, uploads.findLast((row) => row.body.sessionId === 1).body.readings[0].sampleId);
  assert.equal(uploads.find((row) => row.body.sessionId === 2).body.readings[0].heartRate, 90);
});

test("reload restores the active recording and durable pending samples without repeating generation", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "already-submitted" }) });
  await page.start();
  page.reading(1, 70);
  await page.advance(30000);
  page.uploadResponses.push({ ok: false, status: 503 });
  page.reading(2, 85);
  await page.advance(5000);
  const sessionId = [...page.storage.sessions.keys()][0];
  page.unmount();
  const reloaded = pageHarness({ storage: page.storage, tabStorage: page.tabStorage, initialNow: page.now });
  await reloaded.settle();
  assert.equal(reloaded.session().isActive, true);
  assert.match(reloaded.session().status, /Music was interrupted/);
  reloaded.reading(1, 90);
  await reloaded.advance(35000);
  assert.equal(reloaded.generations().length, 0);
  assert.equal([...reloaded.storage.samples.values()].length, 3);
  assert.equal([...reloaded.storage.sessions.keys()][0], sessionId);
  await reloaded.stop();
  assert.equal(reloaded.storage.sessions.get(sessionId).acknowledgedCount, 3);
});

test("samples arriving during upload retain their own acknowledgement", async () => {
  const page = pageHarness({ mockSuno: true });
  let finish;
  page.uploadResponses.push(new Promise((resolve) => { finish = resolve; }));
  await page.start();
  page.reading(1, 70);
  await page.advance(5000);
  const firstId = page.uploads()[0].body.readings[0].sampleId;
  page.reading(1, 85);
  await page.advance(5000);
  assert.equal(page.uploads().length, 1);
  finish({ ok: true, json: async () => ({ acknowledgedSampleIds: [firstId] }) });
  await page.settle();
  assert.deepEqual(page.uploads().map((request) => request.body.readings.map((reading) => reading.heartRate)), [[70], [85]]);
  assert.equal([...page.storage.sessions.values()][0].acknowledgedCount, 2);
});

test("hung uploads abort and retry the same retained IDs after cooldown", async () => {
  const page = pageHarness({ mockSuno: true });
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
  assert.equal(page.uploads()[1].body.readings[0].sampleId, page.uploads()[0].body.readings[0].sampleId);
  assert.deepEqual(page.uploads()[1].body.readings.map((row) => row.heartRate), [70, 85]);
});

test("old in-flight song response cannot finish or update a newer recording", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "old-task" }) });
  let finishPoll;
  page.pollResponses.push(new Promise((resolve) => { finishPoll = resolve; }));
  await page.start();
  await page.advance(40000);
  await page.stop();
  await page.next();
  await page.start();
  finishPoll({ ok: true, json: async () => ({ status: "ready", audioUrl: "https://test.invalid/old.mp3" }) });
  await page.settle();
  assert.equal(page.session().isActive, true);
  assert.equal(page.player().currentSong, null);
  assert.equal(page.player().generationProgress, 0);
  await page.advance(30000);
  assert.equal(page.generations().length, 2);
});

test("late generation submission cannot start polling after Stop", async () => {
  const page = pageHarness();
  let finish;
  page.generationResponses.push(new Promise((resolve) => { finish = resolve; }));
  await page.start();
  await page.advance(30000);
  await page.stop();
  await page.next();
  await page.start();
  finish({ ok: true, json: async () => ({ taskId: "cancelled" }) });
  await page.advance(10000);
  assert.equal(page.requests.some((request) => request.url === "/api/generate/cancelled"), false);
  assert.equal(page.session().isActive, true);
});

test("storage failures show unsaved data, retain samples for retry, and block reset until the end is durable", async () => {
  const page = pageHarness({ mockSuno: true });
  await page.start();
  page.storage.failWrites = true;
  page.reading(1, 75);
  await page.settle();
  assert.match(page.text(), /Local storage needs attention/);
  assert.match(page.text(), /only in memory/);
  assert.equal(page.unload().defaultPrevented, true);
  await page.stop();
  assert.match(page.text(), /Retry Stop/);
  assert.doesNotMatch(page.text(), /New Session/);
  page.storage.failWrites = false;
  await page.stop();
  await page.advance(5000);
  assert.equal([...page.storage.samples.values()].length, 1);
  assert.match(page.text(), /Saved/);
  assert.equal(page.unload().defaultPrevented, false);
});

test("one measured participant never creates a fabricated two-person snapshot", async () => {
  const page = pageHarness();
  await page.start();
  for (let i = 0; i < 8; i++) page.reading(1, 80 + i);
  await page.advance(30000);
  assert.equal(page.generations()[0].body.snapshot, null);
  assert.equal([...page.storage.samples.values()].length, 8);
});

test("server pause stops polling while full recording continues", async () => {
  const page = pageHarness();
  page.generationResponses.push({ ok: true, json: async () => ({ taskId: "paused" }) });
  page.pollResponses.push({ ok: false, status: 423 });
  await page.start();
  await page.advance(70000);
  assert.equal(page.requests.filter((request) => request.url === "/api/generate/paused").length, 1);
  assert.equal(page.session().isActive, true);
  assert.equal(page.player().generationStatus, "Music configuration changed. Start a new session after reloading.");
  assert.equal(page.player().generationProgress, 0);
});

test("mock Suno generates local audio without a key or external fetch; live flags ignore the obsolete pause", async () => {
  const forbidden = () => { throw new Error("Unexpected external side effect"); };
  const saved = [];
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/db": { insertSong: async (song) => saved.push(song), updateSongAudio: forbidden },
  };
  const globals = { process: { env: { USE_MOCK_SUNO: "true", SUNO_DISABLED: "true" } }, fetch: forbidden, crypto: require("node:crypto") };
  const generate = loadModule("app/api/generate/route.ts", dependencies, globals);
  const status = loadModule("app/api/generate/[taskId]/route.ts", dependencies, globals);
  const result = await generate.POST({ json: async () => ({ prompt: "test", style: "jazz", sessionId: 12 }) });
  assert.equal(result.status, 200);
  assert.equal(saved[0].sunoTaskId, result.body.taskId);
  const audio = await status.GET({}, { params: Promise.resolve({ taskId: result.body.taskId }) });
  assert.equal(audio.body.audioUrl, "/api/mock-audio");
  assert.equal(audio.body.status, "ready");
  assert.equal((await status.GET({}, { params: Promise.resolve({ taskId: "real-task" }) })).status, 423);
  globals.process.env.USE_MOCK_SUNO = "false";
  // Missing input/key is reported normally, not the obsolete pause.
  assert.equal((await generate.POST({ json: async () => ({}) })).status, 400);
  assert.equal((await generate.POST({ json: async () => ({ prompt: "test", style: "jazz" }) })).status, 500);
});

test("config controls synthetic measurements and the independent demo still works", async () => {
  for (const options of [{}, { mockBiometrics: true }, { demo: true }]) {
    const page = pageHarness(options);
    await page.start();
    await page.advance(3000);
    const mock = !!(options.mockBiometrics || options.demo);
    assert.equal(page.ring(1).mockMode, mock);
    assert.equal(page.storage.samples.size > 0, mock);
    assert.match(page.text(), mock ? /Mock \(synthetic\)/ : /Live rings/);
    page.unmount();
  }
});

test("fresh callbacks during slow local session creation are retained from Start time", async () => {
  const page = pageHarness({ mockSuno: true });
  const create = page.storage.createSession.bind(page.storage);
  let finishCreate;
  page.storage.createSession = async (row) => {
    await new Promise((resolve) => { finishCreate = resolve; });
    await create(row);
  };
  const starting = page.start();
  await page.settle();
  const startedAt = page.now;
  await page.advance(1000);
  page.reading(1, 75);
  page.reading(2, 85);
  assert.equal(page.unload().defaultPrevented, true);
  finishCreate();
  await starting;
  await page.flush();
  const samples = [...page.storage.samples.values()];
  assert.equal(samples.length, 2);
  assert.equal(samples[0].timestamp, startedAt + 1000);
  assert.equal([...page.storage.sessions.values()][0].startedAt, startedAt);
});

test("live heart rates reach the SyncWave display, which can ask for them", async () => {
  const page = pageHarness();
  await page.settle();
  assert.deepEqual(page.broadcasts.at(-1), { type: "rates", rates: [null, null] });
  page.reading(1, 72);
  page.reading(2, 81, page.now - 500);
  assert.deepEqual(page.broadcasts.at(-1), {
    type: "rates", rates: [{ bpm: 72, at: page.now }, { bpm: 81, at: page.now - 500 }],
  });
  const sent = page.broadcasts.length;
  page.hello();
  assert.equal(page.broadcasts.length, sent + 1);
  assert.deepEqual(page.broadcasts.at(-1).rates.map((rate) => rate?.bpm), [72, 81]);
  page.ring(2).onConnectionChange(2, false);
  assert.deepEqual(page.broadcasts.at(-1).rates.map((rate) => rate?.bpm ?? null), [72, null]);
  page.unmount();
});
