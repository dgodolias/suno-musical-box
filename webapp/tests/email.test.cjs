/* eslint-disable @typescript-eslint/no-require-imports -- Dependency-free Node CommonJS tests. */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, dependencies, globals = {}) {
  const code = ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const context = { exports: {}, ...globals, require(name) {
    if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
    return dependencies[name];
  } };
  vm.runInNewContext(code, context, { filename: file });
  return context.exports;
}

const opts = { to: "listener@example.com", audioUrl: "https://audio.example/song.mp3", title: "Musical Box" };
const audio = Buffer.from([0x49, 0x44, 0x33, 0, 1, 2]);
function provider({ env = { SMTP_USER: "sender@example.com", SMTP_PASS: "test-only" }, response, result, error } = {}) {
  const calls = { downloads: [], configurations: [], messages: [], closed: 0 };
  const email = load("lib/email.ts", { nodemailer: { createTransport(config) {
    calls.configurations.push(config);
    return {
      async sendMail(message) {
        calls.messages.push(message);
        if (error) throw error;
        return result ?? { accepted: [opts.to], rejected: [] };
      },
      close() { calls.closed++; },
    };
  } } }, {
    process: { env }, Buffer, AbortSignal,
    fetch: async (url, options) => {
      calls.downloads.push({ url, options });
      return response ?? { ok: true, arrayBuffer: async () => audio };
    },
  });
  return { ...email, calls };
}

test("Zoho sends the exact downloaded MP3 using authenticated sender and TLS", async () => {
  const h = provider();
  await h.sendSongEmail(opts);
  const config = h.calls.configurations[0];
  assert.equal(config.host, "smtp.zoho.eu");
  assert.equal(config.port, 465);
  assert.equal(config.secure, true);
  assert.equal(config.auth.user, "sender@example.com");
  assert.equal(config.auth.pass, "test-only");
  assert.equal(h.calls.downloads[0].url, opts.audioUrl);
  assert.ok(h.calls.downloads[0].options.signal instanceof AbortSignal);
  const message = h.calls.messages[0];
  assert.equal(message.from.address, config.auth.user);
  assert.equal(message.from.name, "Athens Voice");
  assert.equal(message.to, opts.to);
  assert.match(message.text, /Athens Voice/);
  assert.match(message.html, /Athens Voice/);
  assert.equal(message.attachments[0].filename, "Musical Box.mp3");
  assert.equal(message.attachments[0].contentType, "audio/mpeg");
  assert.deepEqual(message.attachments[0].content, audio);
  assert.equal(h.calls.closed, 1);
});

test("missing credentials and failed or empty downloads never attempt SMTP", async () => {
  for (const [settings, pattern] of [
    [{ env: {} }, /SMTP_USER and SMTP_PASS/],
    [{ response: { ok: false, status: 404 } }, /Audio download failed: 404/],
    [{ response: { ok: true, arrayBuffer: async () => Buffer.alloc(0) } }, /Audio download is empty/],
  ]) {
    const h = provider(settings);
    await assert.rejects(h.sendSongEmail(opts), pattern);
    assert.equal(h.calls.configurations.length, 0);
  }
});

test("SMTP errors and recipient rejection fail the send and close the connection", async () => {
  for (const settings of [
    { error: new Error("SMTP authentication failed") },
    { result: { accepted: [], rejected: [opts.to] } },
  ]) {
    const h = provider(settings);
    await assert.rejects(h.sendSongEmail(opts));
    assert.equal(h.calls.closed, 1);
  }
});

function route({ audioUrl = opts.audioUrl, sendError } = {}) {
  const calls = { lookups: [], sends: [] };
  const api = load("app/api/send-song/route.ts", {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status ?? 200 }) } },
    "@/lib/db": { async getSongAudioUrl(id) { calls.lookups.push(id); return audioUrl; } },
    "@/lib/email": { EMAIL_RE: provider().EMAIL_RE, async sendSongEmail(message) {
      calls.sends.push(message);
      if (sendError) throw sendError;
    } },
  }, { console: { error() {} } });
  return { ...api, calls };
}

test("send-song uses only the database audio URL and trims recipient", async () => {
  const h = route();
  const result = await h.POST({ json: async () => ({ taskId: "real-task", email: ` ${opts.to} `, audioUrl: "https://untrusted.example/file" }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(h.calls.lookups[0], "real-task");
  assert.equal(h.calls.sends[0].audioUrl, opts.audioUrl);
  assert.equal(h.calls.sends[0].to, opts.to);
});

test("send-song reports invalid input, missing song, and SMTP failure without false success", async () => {
  const invalid = route();
  assert.equal((await invalid.POST({ json: async () => ({ taskId: "task", email: "invalid" }) })).status, 400);
  assert.equal(invalid.calls.lookups.length, 0);
  const missing = route({ audioUrl: null });
  assert.equal((await missing.POST({ json: async () => ({ taskId: "task", email: opts.to }) })).status, 404);
  assert.equal(missing.calls.sends.length, 0);
  const failed = route({ sendError: new Error("SMTP failed") });
  const result = await failed.POST({ json: async () => ({ taskId: "task", email: opts.to }) });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, "Email could not be sent");
});
