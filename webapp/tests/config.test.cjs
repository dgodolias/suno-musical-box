/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file) {
  const source = readFileSync(path.join(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {}, require, Buffer, Response };
  vm.runInNewContext(output, context);
  return context.exports;
}

test("mock config defaults false, loads root .env, honors deployment overrides, and exports no secrets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "musical-box-config-"));
  const app = path.join(root, "webapp");
  await mkdir(app);
  const { loadMockConfig } = load("lib/config-env.ts");
  try {
    let config = await loadMockConfig({}, app);
    assert.equal(config.USE_MOCK_SUNO, "false");
    assert.equal(config.USE_MOCK_BIOMETRICS, "false");
    await writeFile(path.join(root, ".env"), 'USE_MOCK_SUNO="true"\nUSE_MOCK_BIOMETRICS=true # comment\nSUNO_API_KEY=private\n');
    config = await loadMockConfig({}, app);
    assert.equal(config.USE_MOCK_SUNO, "true");
    assert.equal(config.USE_MOCK_BIOMETRICS, "true");
    assert.deepEqual(Object.keys(config).sort(), ["USE_MOCK_BIOMETRICS", "USE_MOCK_SUNO"]);
    config = await loadMockConfig({ USE_MOCK_SUNO: "false", USE_MOCK_BIOMETRICS: "false", SUNO_DISABLED: "true" }, app);
    assert.equal(config.USE_MOCK_SUNO, "false");
    assert.equal(config.USE_MOCK_BIOMETRICS, "false");
    assert.equal((await loadMockConfig({ VERCEL: "1" }, app)).USE_MOCK_SUNO, "false");
    await assert.rejects(loadMockConfig({ USE_MOCK_SUNO: "typo" }, app), /must be true or false/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("mock audio is a valid five-second PCM WAV served locally", async () => {
  const response = load("app/api/mock-audio/route.ts").GET();
  assert.equal(response.headers.get("Content-Type"), "audio/wav");
  const wav = Buffer.from(await response.arrayBuffer());
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 8000);
  assert.equal(wav.readUInt32LE(40), 8000 * 5 * 2);
  assert.equal(wav.length, 44 + 8000 * 5 * 2);
});
