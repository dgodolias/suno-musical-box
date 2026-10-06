"use client";

import { useEffect, useRef, type RefObject } from "react";
import {
  AudioLines, Disc3, Drum, Guitar, Headphones, HeartPulse, Mic, Music, Music2, Music3, Music4, Piano, Radio, Speaker,
} from "lucide-react";
import { HR_STALE_MS } from "@/lib/ble/ring-manager";
import type { LiveHeartRates } from "@/lib/heart-rate-channel";

const TAU = Math.PI * 2;
const STEPS = 200;
const COARSE = 4; // the irregular fields are sampled every few steps, then interpolated
const FIELD = STEPS / COARSE;
const ROWS = 12; // ridges per wave: the live one in front, earlier moments behind it
const ROW_S = 0.3; // seconds between one ridge and the next one back
const PAST_MS = ((ROWS - 1) * ROW_S + 0.5) * 1000; // how much of each wave's past to keep
const SIGN_ROW = 3; // the BPM figure stands behind this many ridges
const EDGE = 0.1; // share of the width tapered at each end
const AMP = 0.25; // tallest bell of the front ridge, as a share of the height
const DEPTH = 0.16; // how far behind the front ridge the last one sits, as a share of the height
const APART = 0.08; // how far from the axis each wave sits when out of sync
const BPM_PER_BELL = 22; // a heart at 66 bpm shows three bells across the screen
// Both waves always travel right. In step they cruise; apart, the faster
// heart's wave speeds up and the slower one's slows down, but never stops
const CRUISE = 0.06; // screens per second
const CREEP = 0.035; // the slowest a wave ever goes
const TOP_SPEED = 0.15;
const SPREAD = 0.1; // how strongly each bpm above or below the pair's mean changes the speed
const REST_BPM = 50;
const REST_AMP = 0.05;
const SHARED = 7.7; // seed of the shape both waves take once in sync
const SPARKS = 90;
const MAGNET_S = 2.4; // seconds from one tug of the magnet to the next
const NOTE_SIZE = 0.56; // the song's note, as a share of the height
const NOTE_RISE = 0.07; // how far above the axis its centre sits, as a share of the height

type Hsl = [number, number, number];
type Rgb = [number, number, number];
// Hues are unwrapped so a plain lerp turns the intended way round the wheel
const VIOLET: Hsl = [252, 85, 70]; // EduCoach primary: the glow of the axis
const PINK: Hsl = [322, 95, 68]; // both waves once the two hearts agree
// The background in each colour mode: what distance and shadow fade into
const BACKDROPS = {
  midnight: [0.07, 0.05, 0.14] as Rgb,
  dark: [0.05, 0.045, 0.075] as Rgb,
  light: [0.985, 0.978, 0.966] as Rgb,
};
// A wave at rest is a pale thread in its own hue, so waking up never passes
// through pink on the way to its colour
const PEOPLE = [
  // Person 1, size 9 ring: red, above the axis
  { color: [358, 96, 58] as Hsl, rest: [358, 30, 80] as Hsl, side: -1, seed: 0.9 },
  // Person 2, size 11 ring: blue, below the axis
  { color: [214, 98, 58] as Hsl, rest: [214, 30, 80] as Hsl, side: 1, seed: 4.1 },
];

// Same icons as the floating background; they leave from the crests
const NOTES = [
  Music, Music2, Headphones, Music4, HeartPulse, Guitar, Music3, Mic, Disc3, Piano, Drum, AudioLines,
  Music, Music2, Speaker, Music4, HeartPulse, Headphones, Music3, Radio, Guitar, Music, Mic, Disc3,
];

// Raised-cosine taper, so both ends of the front ridge rest on the axis
const TAPER = Array.from({ length: STEPS + 1 }, (_, j) => {
  const u = Math.min(j, STEPS - j) / STEPS;
  return u < EDGE ? 0.5 - 0.5 * Math.cos((Math.PI * u) / EDGE) : 1;
});
// Both ends fade into the background
const FADE = Array.from({ length: STEPS + 1 }, (_, j) => {
  const u = Math.min(1, Math.min(j, STEPS - j) / (STEPS * 0.05));
  return u * u * (3 - 2 * u);
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

// The lucide Music icon in its 24-unit box: a beam on two stems, each on a
// note head. When the song is ready Person 1's wave becomes the left half,
// round its head, up the stem to the middle of the beam, and Person 2's the
// right half on from there, so the two lines make the one note between them.
// Each half is the same number of points as a ridge, evenly spaced along it
const NOTE_HALVES = (() => {
  // Each head is run round so the line leaves it the way it arrived
  const round = (cx: number, cy: number, r: number, way: number) =>
    Array.from({ length: 49 }, (_, i) => [cx + r * Math.cos((TAU * i) / 48), cy + way * r * Math.sin((TAU * i) / 48)]);
  const left = [...round(6, 18, 3, -1), [9, 5], [15, 4]];
  const right = [[15, 4], [21, 3], [21, 16], ...round(18, 16, 3, 1)];
  return [left, right].map((path) => {
    const along = [0];
    for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    const xs = new Float32Array(STEPS + 1);
    const ys = new Float32Array(STEPS + 1);
    let i = 1;
    for (let j = 0; j <= STEPS; j++) {
      const s = (j / STEPS) * along[along.length - 1];
      while (i < path.length - 1 && along[i] < s) i++;
      const f = (s - along[i - 1]) / (along[i] - along[i - 1] || 1);
      xs[j] = lerp(path[i - 1][0], path[i][0], f);
      ys[j] = lerp(path[i - 1][1], path[i][1], f);
    }
    return [xs, ys] as const;
  });
})();
const mix = (a: Hsl, b: Hsl, t: number): Hsl => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function rgb([h, s, l]: Hsl, dl = 0): Rgb {
  const light = (l + dl) / 100;
  const a = (s / 100) * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + (h + 360) / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// Smooth value noise, 0-1: the same place always gives the same value
function grain(x: number, y: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const knot = (i: number, j: number) => {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const u = (x - xi) ** 2 * (3 - 2 * (x - xi));
  const v = (y - yi) ** 2 * (3 - 2 * (y - yi));
  return lerp(lerp(knot(xi, yi), knot(xi + 1, yi), u), lerp(knot(xi, yi + 1), knot(xi + 1, yi + 1), u), v);
}
// Stretches the middle of the noise out to the whole 0-1 range
const spread = (n: number) => {
  const s = clamp((n - 0.24) / 0.52, 0, 1);
  return s * s * (3 - 2 * s);
};
// Irregular 0-1 values for a place on the screen and a moment; they keep
// changing, so no bell holds its shape and no two look alike
type Field = (x: number, t: number, seed: number) => number;
const wander: Field = (x, t, seed) =>
  spread(0.65 * grain(3.4 * x + seed, 0.16 * t + seed) + 0.35 * grain(7.9 * x + seed * 3.1, 0.27 * t - seed));
const roam: Field = (x, t, seed) => spread(grain(2.6 * x + seed * 1.7, 0.13 * t + seed));

// Strips of [x, y, side, half, r, g, b, opacity]: `side` runs -1..1 across a
// stroke and `half` is its half width in pixels, which feathers the rim; a
// negative `half` asks for a soft halo instead. Opacity below zero is light,
// added to what is behind it; above zero it is paint that covers it.
const STRIP_VERTEX = `
attribute vec2 a_at;
attribute vec2 a_rim;
attribute vec4 a_ink;
uniform vec2 u_size;
varying vec2 v_rim;
varying vec4 v_ink;
void main() {
  v_rim = a_rim;
  v_ink = a_ink;
  gl_Position = vec4(a_at / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;
const STRIP_FRAGMENT = `
precision mediump float;
varying vec2 v_rim;
varying vec4 v_ink;
void main() {
  float rim = 1.0 - abs(v_rim.x);
  float cover = (v_rim.y < 0.0 ? rim * rim : clamp(rim * v_rim.y, 0.0, 1.0)) * abs(v_ink.a);
  gl_FragColor = vec4(v_ink.rgb * cover, v_ink.a < 0.0 ? 0.0 : cover);
}`;
// The BPM figures: glowing text painted on a 2D canvas, drawn as light, or as
// paint in light mode
const SIGN_VERTEX = `
attribute vec2 a_at;
attribute vec2 a_uv;
uniform vec2 u_size;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_at / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;
const SIGN_FRAGMENT = `
precision mediump float;
uniform sampler2D u_figure;
uniform vec4 u_tint;
uniform float u_paint;
varying vec2 v_uv;
void main() {
  float cover = texture2D(u_figure, v_uv).a * u_tint.a;
  gl_FragColor = vec4(u_tint.rgb * cover, u_paint * cover);
}`;
const FLOATS = 8;
// Per wave: a flank and a line per ridge, then four strokes on the front one;
// after both, two glows between them, two strokes on the axis, its flash and
// the sparks
const STRIP_VERTICES = (2 * (2 * ROWS + 4) + 5) * ((STEPS + 1) * 2 + 2) + SPARKS * 6;
const SIGN_W = 512;
const SIGN_H = 256;

function link(gl: WebGLRenderingContext, vertex: string, fragment: string) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

interface Wave {
  bpm: number; // eased reading: sets how many bells fit across the screen
  quick: number; // the reading over the last couple of seconds...
  calm: number; // ...and over the last ten, to tell rising from falling
  level: number; // 0 at rest, 1 live
  amp: number; // eased bell height, 0-1
  speed: number; // screens per second, positive to the right
  bells: number; // how many bells fit across the screen
  offset: number; // how far the bells have travelled, in bells (phase at the left edge)
  // The last few seconds of `offset` and `bells`, which the ridges behind show
  pastAt: number[];
  pastOffset: number[];
  pastBells: number[];
  sheen: number; // where the light running along the front ridge is, in screens
  beat: number; // heartbeats since the page opened, for the notes
  due: number; // sparks owed
  shown: number | null; // the figure painted on its sign
  flash: number; // lights the sign up when the figure changes
  color: Hsl;
  lineX: Float32Array; // where the front ridge runs
  line: Float32Array;
  base: Float32Array; // the line it rests on
  bell: Float32Array; // how far along its swing each point is
  sign: CanvasRenderingContext2D | null;
  figure: WebGLTexture | null;
}

// One wave per heart on either side of a shared axis, red above for Person 1
// and blue below for Person 2, each a range of ridges: the live one in front
// and, behind it, the same wave a moment earlier each, smaller and dimmer with
// distance. A ridge has a solid flank lit from the left, so the range reads as
// a landscape; the ridges trail the way the wave is travelling, and the BPM
// stands among them as a figure of light.
// Both always travel right: a faster heart packs more, steeper and taller bells
// and travels faster than the slower one; as the rates converge the ranges
// close in on the axis, turn pink and fall into step, until one is the mirror
// image of the other, and bells that face each other light the space between
// them.
// Two hearts on the same number act like magnets: a flash on the axis and a
// tug on the waves every couple of seconds, as if they were trying to join.
// When the song is ready (`songRef`) the two lines gather up into its note,
// and go back to their waves when a new session begins.
// It follows the page's colour mode: light paints the ridges in ink on the
// page, dark and cosmic draw them in light.
export default function Waveform({
  ratesRef, songRef,
}: { ratesRef: RefObject<LiveHeartRates>; songRef: RefObject<boolean> }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { antialias: false });
    if (!stage || !canvas || !gl) return;
    const notes = stage.querySelectorAll<HTMLElement>("[data-note]");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const strips = link(gl, STRIP_VERTEX, STRIP_FRAGMENT);
    const signs = link(gl, SIGN_VERTEX, SIGN_FRAGMENT);
    if (!strips || !signs) return;
    const stripBuffer = gl.createBuffer();
    const signBuffer = gl.createBuffer();
    // Returns a switch to the given program, with its attributes on its buffer
    const switchTo = (program: WebGLProgram, buffer: WebGLBuffer, layout: [string, number][]) => {
      const stride = layout.reduce((sum, [, size]) => sum + size, 0) * 4;
      const locations = layout.map(([name]) => gl.getAttribLocation(program, name));
      const uSize = gl.getUniformLocation(program, "u_size");
      return () => {
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        for (let index = 0; index < 3; index++) gl.disableVertexAttribArray(index);
        let skip = 0;
        layout.forEach(([, size], i) => {
          gl.enableVertexAttribArray(locations[i]);
          gl.vertexAttribPointer(locations[i], size, gl.FLOAT, false, stride, skip * 4);
          skip += size;
        });
        gl.uniform2f(uSize, canvas.width, canvas.height);
      };
    };
    const toStrips = switchTo(strips, stripBuffer, [["a_at", 2], ["a_rim", 2], ["a_ink", 4]]);
    const toSigns = switchTo(signs, signBuffer, [["a_at", 2], ["a_uv", 2]]);
    const uTint = gl.getUniformLocation(signs, "u_tint");
    const uPaint = gl.getUniformLocation(signs, "u_paint");
    // Colours come out premultiplied: paint covers, light (no opacity) adds
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(stage.clientWidth * dpr);
      canvas.height = Math.round(stage.clientHeight * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();

    const row = () => new Float32Array(STEPS + 1);
    const waves: Wave[] = PEOPLE.map(() => {
      const sign = document.createElement("canvas");
      sign.width = SIGN_W;
      sign.height = SIGN_H;
      const figure = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, figure);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sign);
      return {
        bpm: REST_BPM, quick: REST_BPM, calm: REST_BPM, level: 0, amp: REST_AMP, speed: CRUISE, bells: REST_BPM / BPM_PER_BELL, offset: 0, pastAt: [], pastOffset: [], pastBells: [], sheen: 0,
        beat: 0, due: 0, shown: null, flash: 0, color: VIOLET, lineX: row(), line: row(), base: row(), bell: row(),
        sign: sign.getContext("2d"), figure,
      };
    });
    // The page's display font, once it has loaded
    let family = "sans-serif";
    const paintSign = (w: Wave) => {
      const ctx = w.sign;
      if (!ctx) return;
      ctx.clearRect(0, 0, SIGN_W, SIGN_H);
      if (w.shown !== null) {
        ctx.font = `700 ${SIGN_H * 0.74}px ${family}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff";
        ctx.shadowColor = "#fff";
        // A wide glow, then the figure itself
        ctx.shadowBlur = SIGN_H * 0.12;
        ctx.globalAlpha = 0.55;
        ctx.fillText(String(w.shown), SIGN_W / 2, SIGN_H * 0.54);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.fillText(String(w.shown), SIGN_W / 2, SIGN_H * 0.54);
      }
      gl.bindTexture(gl.TEXTURE_2D, w.figure);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ctx.canvas);
    };
    let live = true;
    const display = getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim();
    if (display) {
      document.fonts.load(`700 64px ${display}`).then(() => {
        if (!live) return;
        family = `${display}, sans-serif`;
        waves.forEach(paintSign);
      }, () => {});
    }

    const frontX = row();
    const farX = row();
    const farY = row();
    const axis = row();
    const shine = row();
    const tall = new Float32Array(FIELD + 1);
    const wide = new Float32Array(FIELD + 1);
    const rough = new Float32Array(FIELD + 1);
    const vertices = new Float32Array(STRIP_VERTICES * FLOATS);
    const quad = new Float32Array(16);
    const spark = {
      x: new Float32Array(SPARKS), y: new Float32Array(SPARKS), vx: new Float32Array(SPARKS),
      vy: new Float32Array(SPARKS), age: new Float32Array(SPARKS).fill(1), life: new Float32Array(SPARKS).fill(1),
      who: new Uint8Array(SPARKS),
    };
    const opened = performance.now();
    let filled = 0;
    let ink: Rgb = [0, 0, 0];
    let paper = false; // light mode: everything is paint instead of light
    let night = BACKDROPS.midnight;
    let sync = 0; // 0 = apart, 1 = the two hearts agree
    let harmony = 0; // builds up while they stay in sync
    let magnet = 0; // 1 while both read the same number
    let tug = 0; // the latest pull of the magnet, fading
    let tugged = -Infinity; // when it was
    let song = 0; // climbs to 1 while the song is ready...
    let morph = 0; // ...and the waves become its note
    let fold = 1; // what is left of the flanks and the ridges behind while it does
    let hadSong = false;
    let last = opened;
    let nextSpark = 0;
    let raf = 0;

    const vertex = (x: number, y: number, side: number, half: number, r: number, g: number, b: number, a: number) => {
      vertices[filled++] = x;
      vertices[filled++] = y;
      vertices[filled++] = side;
      vertices[filled++] = half;
      vertices[filled++] = r;
      vertices[filled++] = g;
      vertices[filled++] = b;
      vertices[filled++] = a;
    };
    // Every strip starts with a zero-area bridge from the one before it
    const bridge = (x: number, y: number) => {
      if (filled === 0) return;
      vertices.copyWithin(filled, filled - FLOATS, filled);
      filled += FLOATS;
      vertex(x, y, 0, 1, 0, 0, 0, 0);
    };
    // A line of light `width` pixels wide along a ridge in the current ink,
    // or a soft halo of that reach; `glint` brightens it along the way
    const stroke = (
      xs: Float32Array, ys: Float32Array, step: number, width: number, alpha: number, halo = false,
      glint?: Float32Array
    ) => {
      const reach = halo ? width : width / 2 + 0.5;
      const half = halo ? -1 : reach;
      // A halo goes straight up and down, as wide strips fold over on tight
      // bends; round the note, which has none that tight, it follows the line
      const upright = halo ? 1 - morph : 0;
      for (let j = 0; j <= STEPS; j += step) {
        const ahead = Math.min(j + step, STEPS);
        const behind = Math.max(j - step, 0);
        const dy = ys[ahead] - ys[behind];
        const run = xs[ahead] - xs[behind];
        const scale = (reach * (1 - upright)) / (Math.hypot(run, dy) || 1);
        const ox = -dy * scale;
        const oy = run * scale + reach * upright;
        // The note's halves meet end to end, so their ends must not fade
        const a = (paper ? 1 : -1) * alpha * lerp(FADE[j], 1, morph) * (glint ? glint[j] : 1);
        if (j === 0) bridge(xs[0] - ox, ys[0] - oy);
        vertex(xs[j] - ox, ys[j] - oy, -1, half, ink[0], ink[1], ink[2], a);
        vertex(xs[j] + ox, ys[j] + oy, 1, half, ink[0], ink[1], ink[2], a);
      }
    };
    // The solid flank of a ridge, from its line to the axis: lit where it
    // climbs to the right, in shadow where it falls, fading towards its foot
    const flank = (
      xs: Float32Array, ys: Float32Array, step: number, side: number, foot: number, tint: Rgb, glow: number,
      cover = 1
    ) => {
      bridge(xs[0], ys[0]);
      for (let j = 0; j <= STEPS; j += step) {
        const ahead = Math.min(j + step, STEPS);
        const behind = Math.max(j - step, 0);
        const climb = (side * (ys[ahead] - ys[behind])) / (xs[ahead] - xs[behind]);
        const facing = 0.5 + 0.5 * Math.tanh(1.3 * climb); // 1 = turned to the light
        // In the dark a lit face glows in its colour; on paper it pales
        const amount = glow * (paper ? 1 - 0.55 * facing : 0.1 + 0.9 * facing);
        const deep = paper ? 0.97 : 0.8;
        vertex(
          xs[j], ys[j], 0, 1, lerp(night[0], tint[0], amount), lerp(night[1], tint[1], amount),
          lerp(night[2], tint[2], amount), 0.95 * FADE[j] * cover
        );
        vertex(xs[j], foot, 0, 1, night[0] * deep, night[1] * deep, night[2] * deep, 0.95 * FADE[j] * cover);
      }
    };

    const launchNote = (p: number) => {
      const { lineX, line, base, color, speed } = waves[p];
      const H = canvas.height;
      // Crests of the front ridge, away from the tapered ends
      const crests: number[] = [];
      for (let j = Math.round(STEPS * 0.15); j < STEPS * 0.85; j++) {
        const rise = Math.abs(line[j] - base[j]);
        if (rise > H * AMP * 0.3 && rise >= Math.abs(line[j - 1] - base[j - 1]) &&
          rise > Math.abs(line[j + 1] - base[j + 1])) crests.push(j);
      }
      if (crests.length === 0) return;
      const j = crests[Math.floor(Math.random() * crests.length)];
      // A random icon that is not already in flight
      let note = notes[Math.floor(Math.random() * notes.length)];
      for (let tries = 0; tries < 6 && note.getAnimations().length > 0; tries++) {
        note = notes[Math.floor(Math.random() * notes.length)];
      }
      const size = 0.8 + 0.45 * Math.random();
      const sway = (Math.random() - 0.5) * 3;
      // Away from the axis, carried the way the wave is travelling
      const away = PEOPLE[p].side;
      const along = clamp(speed / CRUISE, 0, 2.5);
      // vw/vh, so the flight scales with the screen
      const place = (x: number, y: number, scale: number, turn: number) =>
        `translate(calc(-50% + ${x}vw), calc(-50% + ${away * y}vh)) scale(${scale}) rotate(${turn}deg)`;
      note.style.left = `${(lineX[j] / canvas.width) * 100}%`;
      note.style.top = `${(line[j] / H) * 100}%`;
      note.style.color = `hsl(${color[0]} ${color[1]}% ${color[2] + (paper ? -10 : 12)}%)`;
      // Pop out of the crest, then float off and fade
      note.animate(
        [
          { opacity: 0, transform: place(0, 0, 0.3 * size, 0) },
          { opacity: 1, transform: place(0.3 * along, 3, size, sway * 2), offset: 0.15 },
          { opacity: 0.8, offset: 0.6 },
          { opacity: 0, transform: place(2.4 * along + sway, 14, 1.1 * size, sway * 6) },
        ],
        { duration: 4200, easing: "ease-out" }
      );
    };
    // A spark leaves the front ridge near one of its taller points
    const launchSpark = (p: number) => {
      const w = waves[p];
      let j = 0;
      for (let tries = 0; tries < 3; tries++) {
        const pick = Math.round(STEPS * (0.08 + 0.84 * Math.random()));
        if (tries === 0 || Math.abs(w.line[pick] - w.base[pick]) > Math.abs(w.line[j] - w.base[j])) j = pick;
      }
      const i = nextSpark++ % SPARKS;
      spark.x[i] = w.lineX[j];
      spark.y[i] = w.line[j];
      // Off the note they fly outwards from its centre instead of along
      const dx = w.lineX[j] - canvas.width / 2;
      const dy = w.line[j] - (0.5 - NOTE_RISE) * canvas.height;
      const out = (canvas.height * (0.05 + 0.1 * Math.random())) / (Math.hypot(dx, dy) || 1);
      spark.vx[i] = lerp(canvas.width * (w.speed * (1.5 + 2 * Math.random()) + (Math.random() - 0.5) * 0.03), dx * out, morph);
      spark.vy[i] = lerp(PEOPLE[p].side * canvas.height * (0.04 + 0.09 * Math.random()), dy * out, morph);
      spark.age[i] = 0;
      spark.life[i] = 1.4 + 1.6 * Math.random();
      spark.who[i] = p;
    };
    // A burst of sparks from the middle of the axis, where the two waves meet
    const burst = (count: number) => {
      for (let n = 0; n < count; n++) {
        const i = nextSpark++ % SPARKS;
        const angle = Math.random() * TAU;
        const pace = canvas.height * (0.1 + 0.25 * Math.random());
        spark.x[i] = canvas.width * (0.5 + (Math.random() - 0.5) * 0.2);
        spark.y[i] = canvas.height / 2;
        spark.vx[i] = Math.cos(angle) * pace;
        spark.vy[i] = Math.sin(angle) * pace;
        spark.age[i] = 0;
        spark.life[i] = 0.7 + 0.9 * Math.random();
        spark.who[i] = n % 2;
      }
    };

    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const t = still ? 0 : (now - opened) / 1000;
      const ease = (tau: number) => 1 - Math.exp(-dt / tau);
      // The colour mode the page is in (next-themes puts it on <html>)
      const modes = document.documentElement.classList;
      const mode = modes.contains("midnight") ? "midnight" : modes.contains("dark") ? "dark" : "light";
      paper = mode === "light";
      night = BACKDROPS[mode];
      // A reading counts until it is as old as the ring card's stale limit
      const wall = Date.now();
      const bpm = ratesRef.current.map((s) => (s && wall - s.at < HR_STALE_MS ? s.bpm : null));
      const gap = bpm[0] !== null && bpm[1] !== null ? Math.abs(bpm[0] - bpm[1]) : null;
      const mean = bpm[0] !== null && bpm[1] !== null ? (bpm[0] + bpm[1]) / 2 : null;

      sync += ((gap === null ? 0 : 1 / (1 + (gap / 6) ** 2)) - sync) * ease(1.2);
      harmony += ((sync > 0.75 ? 1 : 0) - harmony) * ease(sync > 0.75 ? 5 : 2.5);
      // On the same number the two are magnets: a flash and a tug towards each
      // other at once, then again every couple of seconds while it lasts
      const same = bpm[0] !== null && bpm[0] === bpm[1];
      magnet += ((same ? 1 : 0) - magnet) * ease(same ? 0.3 : 1);
      if (same && t - tugged >= MAGNET_S && !still) {
        tugged = t;
        tug = 1;
        burst(24);
      }
      // The song arrives in a flash and the waves gather into its note over a
      // few seconds; a new session lets them go again
      const wanted = songRef.current;
      if (wanted && !hadSong && !still) {
        tug = 1;
        burst(60);
      }
      hadSong = wanted;
      tug *= Math.exp(-dt / 0.7);
      song = clamp(song + Math.min(dt, 0.25) * (wanted ? 1 / 3 : -1 / 2), 0, 1);
      morph = song * song * (3 - 2 * song);
      fold = clamp(1 - 3 * song, 0, 1);
      // Within a few BPM of each other the two waves pull into step (matching
      // in the middle of the screen): the one ahead eases off and the one behind
      // hurries, neither ever turning back
      const middle = (w: Wave) => w.offset - 0.5 * w.bells;
      const pull = gap === null ? 0
        : (0.45 / (1 + (gap / 2.5) ** 2)) * Math.sin(TAU * (middle(waves[1]) - middle(waves[0])));

      waves.forEach((w, p) => {
        const b = bpm[p];
        const reading = b ?? REST_BPM;
        // A reading that has just appeared is neither rising nor falling yet,
        // and the resting thread takes its spacing at once
        if (b !== null && w.level < 0.02) w.bpm = w.quick = w.calm = b;
        w.level += ((b === null ? 0 : 1) - w.level) * ease(0.8);
        w.bpm += (reading - w.bpm) * ease(2);
        w.quick += (reading - w.quick) * ease(1.5);
        w.calm += (reading - w.calm) * ease(10);
        // Faster hearts swing wider, more so while they are speeding up
        const rising = clamp((w.quick - w.calm) / 5, -1, 1);
        const swing = b === null ? REST_AMP : (0.62 + 0.38 * clamp((b - 55) / 55, 0, 1)) * (1 + 0.2 * rising);
        w.amp += (swing - w.amp) * ease(1.2);
        // Above the pair's mean a wave travels faster, below it slower
        const heading = b === null || mean === null ? CRUISE : CREEP + (CRUISE - CREEP) * Math.exp(SPREAD * (b - mean));
        w.speed += (Math.min(heading, TOP_SPEED) - w.speed) * ease(1.5);
        // The note is pink whatever the two hearts read, with a trace of each
        w.color = mix(mix(PEOPLE[p].rest, PEOPLE[p].color, w.level), PINK, Math.max(sync, 0.8 * morph));
        // The sign keeps its last figure while it fades out with the wave
        if (b !== null && b !== w.shown) {
          w.shown = b;
          w.flash = 1;
          paintSign(w);
        }
        w.flash *= Math.exp(-dt / 0.5);
        if (still) return;
        // Bells travel right. When they get denser they close up towards the
        // right edge, and when sparser they spread out from the left one, so
        // none ever slides back to the left
        const bells = w.bpm / BPM_PER_BELL;
        w.offset += w.speed * bells * Math.min(dt, 0.25) * (1 + (p === 0 ? pull : -pull)) + Math.max(0, bells - w.bells);
        w.bells = bells;
        w.pastAt.push(now);
        w.pastOffset.push(w.offset);
        w.pastBells.push(bells);
        let old = 0;
        while (old < w.pastAt.length - 2 && w.pastAt[old + 1] < now - PAST_MS) old++;
        if (old > 0) {
          w.pastAt.splice(0, old);
          w.pastOffset.splice(0, old);
          w.pastBells.splice(0, old);
        }
        w.sheen += 4 * w.speed * dt;
        const beats = Math.floor(w.beat);
        w.beat += (reading / 60) * dt;
        // An icon leaves with most heartbeats, nearly all of them once in sync
        if (b !== null && dt < 0.25 && Math.floor(w.beat) > beats && Math.random() < 0.65 + 0.3 * harmony) {
          launchNote(p);
        }
        // More sparks the faster it travels and the longer the two agree
        w.due += (w.level * (8 + (12 * w.speed) / TOP_SPEED + 12 * harmony) + 10 * morph) * Math.min(dt, 0.1);
        for (; w.due >= 1; w.due--) launchSpark(p);
      });

      const W = canvas.width;
      const H = canvas.height;
      const cy = H / 2;
      const unit = H / 1080;
      // Out of sync each wave keeps its distance from the axis; in sync, or
      // while one of them is still at rest, they meet on it
      const apart = APART * (1 - sync) * waves[0].level * waves[1].level;
      // Each wave's own irregular value; in sync both take the shared one, so
      // one ends up the mirror image of the other
      const own = (field: Field, x: number, at: number, seed: number, trait: number) =>
        sync < 0.01 ? field(x, at, seed + trait)
          : sync > 0.99 ? field(x, at, SHARED + trait)
            : lerp(field(x, at, seed + trait), field(x, at, SHARED + trait), sync);
      for (let j = 0; j <= STEPS; j++) frontX[j] = (j / STEPS) * W;

      // A wave's offset and spacing as they were at `at`, from its recent past.
      // Before the page had any, it is taken to have been cruising
      const recall = (w: Wave, at: number): [number, number] => {
        const times = w.pastAt;
        if (times.length === 0 || at >= times[times.length - 1]) return [w.offset, w.bells];
        if (at <= times[0]) {
          const first = w.pastBells[0];
          return [w.pastOffset[0] - (CRUISE * first * (times[0] - at)) / 1000, first];
        }
        let low = 0;
        let high = times.length - 1;
        while (high - low > 1) {
          const mid = (low + high) >> 1;
          if (times[mid] <= at) low = mid;
          else high = mid;
        }
        const f = (at - times[low]) / (times[high] - times[low] || 1);
        return [lerp(w.pastOffset[low], w.pastOffset[high], f), lerp(w.pastBells[low], w.pastBells[high], f)];
      };

      // Where ridge `k` of wave `p` runs: the wave as it was k moments ago,
      // narrower, lower and closer to the ridges around it with distance
      const ridge = (
        p: number, k: number, xs: Float32Array, ys: Float32Array, bell?: Float32Array, base?: Float32Array
      ) => {
        const w = waves[p];
        const { side, seed } = PEOPLE[p];
        const far = k / (ROWS - 1);
        const then = t - k * ROW_S;
        const [offset, bells] = k === 0 || still ? [w.offset, w.bells] : recall(w, now - k * ROW_S * 1000);
        const hurry = clamp((w.bpm - 55) / 55, 0, 1);
        // Bells lean the way they travel
        const lean = 0.35 * Math.tanh(w.speed / 0.04);
        // Farther ridges are narrower; at rest they all fold down onto the axis,
        // so waking up only raises them and nothing slides sideways
        const scale = 1 - 0.2 * far;
        const sink = k === 0 ? 1 : fold;
        const lift = DEPTH * (1 - (1 - far) ** 1.7) * w.level * sink;
        // The whole wave swells and settles at no fixed pace, and a swell
        // keeps rolling from the front ridge to the back
        const breath = 0.82 + 0.18 * lerp(grain(0.11 * then + seed, seed), grain(0.11 * then, SHARED), sync);
        const roll = 1 + 0.12 * Math.sin(TAU * (0.8 * far - 0.3 * t));
        const reach = w.amp * breath * roll * (1 - 0.45 * far) * AMP * H * sink;
        for (let c = 0; c <= FIELD; c++) {
          tall[c] = own(wander, c / FIELD, then, seed, 0);
          wide[c] = own(roam, c / FIELD, then, seed, 11);
          rough[c] = own(roam, c / FIELD, then, seed, 31);
        }
        for (let j = 0; j <= STEPS; j++) {
          const x = j / STEPS;
          const c = Math.min(FIELD - 1, Math.floor(j / COARSE));
          const f = j / COARSE - c;
          const height = lerp(tall[c], tall[c + 1], f);
          const width = lerp(wide[c], wide[c + 1], f);
          const grit = lerp(rough[c], rough[c + 1], f);
          // No two bells are as wide, as tall or as steep as each other...
          const phase = bells * x - offset + 0.34 * (width - 0.5);
          const peak = Math.sin(Math.PI * (phase - Math.floor(phase)) ** Math.exp(lean + 0.5 * (width - 0.5))) **
            (2.2 + 1.6 * hurry + 1.6 * (grit - 0.5));
          // ...and the valleys between them rarely reach the floor
          const swung = peak * (0.3 + 0.7 * height) + 0.2 * grit * (1 - peak);
          const floor = cy + side * (apart * TAPER[j] + lift) * H;
          xs[j] = (0.5 + (x - 0.5) * scale) * W;
          ys[j] = floor + side * reach * TAPER[j] * swung;
          if (bell) bell[j] = swung;
          if (base) base[j] = floor;
        }
      };

      // The magnet tugs the middle of the front ridge towards the axis. The
      // song's note gathers the ridge up, Person 1's from the left end and
      // Person 2's from the right, each point swinging round the note's
      // centre on its way, so the two lines spiral in and the note breathes
      const noteY = cy - NOTE_RISE * H;
      const span = ((NOTE_SIZE * H) / 18) * (1 + 0.02 * Math.sin(1.3 * t));
      const shape = (p: number, xs: Float32Array, ys: Float32Array) => {
        const pinch = 0.55 * magnet * tug;
        const [noteXs, noteYs] = NOTE_HALVES[p];
        for (let j = 0; j <= STEPS; j++) {
          const x = j / STEPS;
          if (pinch > 0.001) ys[j] = lerp(ys[j], cy, pinch * Math.exp(-(((x - 0.5) / 0.2) ** 2)));
          if (morph <= 0) continue;
          const along = p === 0 ? x : 1 - x;
          const begun = clamp(1.6 * morph - 0.6 * along, 0, 1);
          const m = begun * begun * (3 - 2 * begun);
          const dx = lerp(xs[j], W / 2 + (noteXs[j] - 12) * span, m) - W / 2;
          const dy = lerp(ys[j], noteY + (noteYs[j] - 12) * span, m) - noteY;
          const turn = PEOPLE[p].side * 0.9 * Math.sin(Math.PI * m);
          xs[j] = W / 2 + dx * Math.cos(turn) - dy * Math.sin(turn);
          ys[j] = noteY + dx * Math.sin(turn) + dy * Math.cos(turn);
        }
      };

      filled = 0;
      const cuts: number[] = [];
      // The note is drawn far bolder than a ridge
      const bold = lerp(1, 12, morph);
      waves.forEach((w, p) => {
        const { side } = PEOPLE[p];
        const tint = rgb(w.color, paper ? -12 : 0);
        for (let k = ROWS - 1; k >= 0; k--) {
          // The sign goes in here, in front of the ridges already drawn
          if (k === SIGN_ROW - 1) cuts.push(filled / FLOATS);
          const front = k === 0;
          const xs = front ? w.lineX : farX;
          const ys = front ? w.line : farY;
          if (front) {
            ridge(p, 0, xs, ys, w.bell, w.base);
            shape(p, xs, ys);
          } else {
            if (fold <= 0) continue;
            ridge(p, k, xs, ys);
          }
          const far = k / (ROWS - 1);
          // Distant ridges are drawn with half the points
          const step = k < 4 ? 1 : 2;
          flank(xs, ys, step, side, cy, tint, (0.6 - 0.36 * far) * (0.35 + 0.65 * w.level), fold);
          ink = tint;
          if (!front) {
            stroke(xs, ys, step, lerp(2.4, 1, far) * unit, lerp(0.7, 0.16, far) * (0.3 + 0.7 * w.level) * fold);
            continue;
          }
          // Light runs along the front ridge the way the wave is going
          const flow = 0.7 * Math.max(w.level, morph) * Math.min(1, w.speed / CRUISE);
          for (let j = 0; j <= STEPS; j++) {
            const u = (j / STEPS - w.sheen) * 3;
            shine[j] = 1 + flow * Math.exp(-(((u - Math.floor(u) - 0.5) / 0.12) ** 2));
          }
          stroke(xs, ys, 1, 60 * unit * lerp(1, 1.5, morph), (paper ? 0.04 : 0.08) * (1 + 1.5 * morph), true, shine);
          stroke(xs, ys, 1, 22 * unit * lerp(1, 2, morph), (paper ? 0.1 : 0.22) * (1 + morph), true, shine);
          stroke(xs, ys, 1, 3.4 * unit * bold, 0.95, false, shine);
          ink = rgb(w.color, paper ? 6 : 22);
          stroke(xs, ys, 1, 1.2 * unit * bold, paper ? 0.55 : 0.8, false, shine);
        }
        cuts.push(filled / FLOATS);
      });

      // Wherever a bell of one wave faces a bell of the other, the space
      // between them lights up pink
      const together = Math.min(waves[0].level, waves[1].level);
      const lit = together * (0.14 + 0.5 * sync + 0.22 * harmony) * fold;
      waves.forEach((w) => {
        const heart = rgb(mix(w.color, PINK, 0.6), paper ? -6 : 6);
        bridge(w.lineX[0], w.line[0]);
        for (let j = 0; j <= STEPS; j++) {
          const meet = (paper ? 0.45 : -1) * lit * waves[0].bell[j] * waves[1].bell[j] * FADE[j];
          vertex(w.lineX[j], w.line[j], 0, 1, heart[0], heart[1], heart[2], meet * 0.25);
          vertex(w.lineX[j], cy, 0, 1, heart[0], heart[1], heart[2], meet);
        }
      });
      // The axis they meet on glows as they get closer, and flares up with
      // each tug of the magnet; under the note it dims
      axis.fill(cy);
      const dim = 1 - 0.8 * morph;
      ink = rgb(mix(VIOLET, PINK, sync), paper ? -12 : 0);
      stroke(frontX, axis, 1, 0.16 * H, (0.05 + 0.1 * sync + 0.08 * harmony + 0.15 * tug) * (paper ? 0.5 : 1) * dim, true);
      stroke(frontX, axis, 1, 1.4 * unit * (1 + 2 * tug), (0.35 + 0.4 * sync + 0.5 * tug) * dim);
      // The flash: white-hot in the middle, right across the screen's height
      if (tug > 0.002) {
        for (let j = 0; j <= STEPS; j++) shine[j] = Math.exp(-(((j / STEPS - 0.5) / 0.2) ** 2));
        ink = rgb(PINK, paper ? -8 : 26);
        stroke(frontX, axis, 1, 0.45 * H, (paper ? 0.55 : 0.85) * tug, true, shine);
      }
      // Sparks: short streaks of light, brightest at the head
      for (let i = 0; i < SPARKS; i++) {
        if (spark.age[i] >= spark.life[i]) continue;
        const w = waves[spark.who[i]];
        if (!still) {
          spark.age[i] += dt;
          spark.x[i] += spark.vx[i] * dt;
          spark.y[i] += spark.vy[i] * dt;
        }
        const left = 1 - spark.age[i] / spark.life[i];
        const glow = (paper ? 0.8 : -0.9) * left * left * w.level;
        const [r, g, b] = rgb(w.color, paper ? -10 : 16);
        const speed = Math.hypot(spark.vx[i], spark.vy[i]) || 1;
        const reach = (2.5 + 4 * left) * unit;
        const nx = (-spark.vy[i] / speed) * reach;
        const ny = (spark.vx[i] / speed) * reach;
        const tx = spark.x[i] - spark.vx[i] * 0.22;
        const ty = spark.y[i] - spark.vy[i] * 0.22;
        bridge(spark.x[i] - nx, spark.y[i] - ny);
        vertex(spark.x[i] - nx, spark.y[i] - ny, -1, -1, r, g, b, glow);
        vertex(spark.x[i] + nx, spark.y[i] + ny, 1, -1, r, g, b, glow);
        vertex(tx - nx, ty - ny, -1, -1, r, g, b, 0);
        vertex(tx + nx, ty + ny, 1, -1, r, g, b, 0);
      }

      // Each wave's BPM as a figure of light standing among its ridges: the
      // nearest ones pass in front of it, and it shows through them dimmed,
      // as if half sunk into the wave
      const drawSign = (p: number, opacity: number) => {
        const w = waves[p];
        const height = 0.2 * H * (1 + 0.06 * w.flash);
        const middle = cy + PEOPLE[p].side * (apart + 0.135 + 0.006 * Math.sin(0.6 * t + p)) * H;
        quad.set([
          W / 2 - height, middle - height / 2, 0, 0, W / 2 + height, middle - height / 2, 1, 0,
          W / 2 - height, middle + height / 2, 0, 1, W / 2 + height, middle + height / 2, 1, 1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, quad, gl.DYNAMIC_DRAW);
        gl.bindTexture(gl.TEXTURE_2D, w.figure);
        const [r, g, b] = rgb(w.color, paper ? -16 : 8);
        gl.uniform4f(uTint, r, g, b, opacity * w.level * fold * (0.8 + 0.4 * w.flash));
        gl.uniform1f(uPaint, paper ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      };
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindBuffer(gl.ARRAY_BUFFER, stripBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, filled), gl.DYNAMIC_DRAW);
      let drawn = 0;
      const drawStripsTo = (end: number) => {
        toStrips();
        gl.drawArrays(gl.TRIANGLE_STRIP, drawn, end - drawn);
        drawn = end;
      };
      waves.forEach((_, p) => {
        drawStripsTo(cuts[2 * p]);
        toSigns();
        drawSign(p, 0.9);
        drawStripsTo(cuts[2 * p + 1]);
      });
      drawStripsTo(filled / FLOATS);
      toSigns();
      waves.forEach((_, p) => drawSign(p, 0.38));

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      waves.forEach((w) => gl.deleteTexture(w.figure));
      gl.deleteBuffer(stripBuffer);
      gl.deleteBuffer(signBuffer);
      gl.deleteProgram(strips);
      gl.deleteProgram(signs);
    };
  }, [ratesRef, songRef]);

  return (
    <div ref={stageRef} aria-hidden className="pointer-events-none absolute inset-0">
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {NOTES.map((Icon, i) => (
        <span
          key={i}
          data-note
          className="absolute opacity-0"
          style={{ filter: "drop-shadow(0 0 0.6vw currentColor)" }}
        >
          <Icon strokeWidth={2} style={{ width: `${1.8 + (i % 3) * 0.5}vw`, height: `${1.8 + (i % 3) * 0.5}vw` }} />
        </span>
      ))}
    </div>
  );
}
