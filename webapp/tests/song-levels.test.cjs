/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function load(file) {
  const source = readFileSync(path.join(__dirname, "..", file), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = { exports: {} };
  vm.runInNewContext(output, context);
  return context.exports;
}

const { envelope, levelsAt } = load("lib/song-levels.ts");
const round = (values) => Array.from(values, (value) => Math.round(value * 1000) / 1000);

// Frames of 10 samples each (300 Hz at 30 per second), each a square wave of the given loudness
function frames(...loudness) {
  return Float32Array.from(loudness.flatMap((level) => Array.from({ length: 10 }, (_, i) => (i % 2 ? level : -level))));
}

test("envelope measures each frame's loudness, scaled so the loud parts reach 1", () => {
  const quiet = Array(20).fill(0.25);
  const loud = Array(19).fill(0.5);
  const levels = envelope(frames(...quiet, ...loud, 2), 300, 30);
  assert.deepEqual(round(levels), [...Array(20).fill(0.5), ...Array(19).fill(1), 1]);
});

test("envelope copes with silence and with too little sound for a frame", () => {
  assert.deepEqual(round(envelope(frames(0, 0, 0), 300, 30)), [0, 0, 0]);
  assert.equal(envelope(new Float32Array(5), 300, 30).length, 0);
});

test("levelsAt reads the frame playing at a moment, and silence outside the song", () => {
  const levels = { fps: 30, low: Float32Array.from([0.1, 0.2, 0.3]), high: Float32Array.from([0.4, 0.5, 0.6]) };
  assert.deepEqual(round(Object.values(levelsAt(levels, 0.04))), [0.2, 0.5]);
  assert.deepEqual(round(Object.values(levelsAt(levels, -1))), [0.1, 0.4]);
  assert.deepEqual(Object.values(levelsAt(levels, 10)), [0, 0]);
});
