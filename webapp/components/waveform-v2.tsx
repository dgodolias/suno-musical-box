"use client";

import { useEffect, useRef, type RefObject } from "react";
import { Headphones, Music, Music2, Music4 } from "lucide-react";
import { HR_STALE_MS } from "@/lib/ble/ring-manager";
import type { LiveHeartRates } from "@/lib/heart-rate-channel";

const TAU = Math.PI * 2;
const STEPS = 240;
const EDGE = 0.1; // share of the width tapered at each end
const AMP = 0.32; // tallest bell, as a share of the height
const APART = 0.11; // how far from the axis each wave sits when out of sync
const BPM_PER_BELL = 22; // a heart at 66 bpm shows three bells across the screen
const DRIFT = 0.02; // screens per second both waves travel right when in step
const SLIDE = 0.007; // extra screens per second for each bpm above the pair's mean
const TOP_SPEED = 0.1;
const REST_BPM = 50;
const REST_AMP = 0.05;
const SHARED = 7.7; // seed of the shape both waves take once in sync

type Hsl = [number, number, number];
// Hues are unwrapped so a plain lerp turns the intended way round the wheel
const VIOLET: Hsl = [252, 85, 70]; // EduCoach primary: the glow of the axis
const PINK: Hsl = [322, 95, 68]; // both waves once the two hearts agree
// A wave at rest is a pale thread in its own hue, so waking up never passes
// through pink on the way to its colour
const PEOPLE = [
  // Person 1, size 9 ring: red, above the axis
  { color: [358, 96, 58] as Hsl, rest: [358, 30, 80] as Hsl, side: -1, seed: 0.9 },
  // Person 2, size 11 ring: blue, below the axis
  { color: [214, 98, 58] as Hsl, rest: [214, 30, 80] as Hsl, side: 1, seed: 4.1 },
];

// Same icons as the floating background; they leave from the crests
const NOTES = [Music, Music2, Headphones, Music4, Music2, Music, Music2, Headphones, Music, Music4, Music2, Music];

// Raised-cosine taper, so both ends rest on the axis
const TAPER = Array.from({ length: STEPS + 1 }, (_, j) => {
  const u = Math.min(j, STEPS - j) / STEPS;
  return u < EDGE ? 0.5 - 0.5 * Math.cos((Math.PI * u) / EDGE) : 1;
});
// Both ends fade into the background
const FADE = Array.from({ length: STEPS + 1 }, (_, j) => {
  const u = Math.min(1, Math.min(j, STEPS - j) / (STEPS * 0.04));
  return u * u * (3 - 2 * u);
});

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const mix = (a: Hsl, b: Hsl, t: number): Hsl => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function rgb([h, s, l]: Hsl, dl = 0): [number, number, number] {
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

// Irregular 0-1 value for a place on the screen and a moment. It keeps
// changing slowly, so no bell holds its size and no two look alike
function wander(x: number, t: number, seed: number) {
  const n = 0.65 * grain(3.4 * x + seed, 0.1 * t + seed) + 0.35 * grain(7.9 * x + seed * 3.1, 0.17 * t - seed);
  const s = clamp((n - 0.24) / 0.52, 0, 1);
  return s * s * (3 - 2 * s);
}

// Everything is triangle strips of [x, y, side, half, r, g, b, alpha]: `side`
// runs -1..1 across a stroke and `half` is its half width in pixels, which
// feathers the rim; a negative `half` asks for a soft halo instead.
const VERTEX = `
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
const FRAGMENT = `
precision mediump float;
varying vec2 v_rim;
varying vec4 v_ink;
void main() {
  float rim = 1.0 - abs(v_rim.x);
  float cover = v_rim.y < 0.0 ? rim * rim : clamp(rim * v_rim.y, 0.0, 1.0);
  gl_FragColor = vec4(v_ink.rgb, 1.0) * (cover * v_ink.a);
}`;
const STRIPS = 13; // the axis glow, then a curtain, three halos, a line and its core per wave
const FLOATS = 8;

interface Wave {
  bpm: number; // eased reading: sets how many bells fit across the screen
  quick: number; // the reading over the last couple of seconds...
  calm: number; // ...and over the last ten, to tell rising from falling
  level: number; // 0 at rest, 1 live
  amp: number; // eased bell height, 0-1
  speed: number; // screens per second, positive to the right
  offset: number; // how far the bells have travelled, in bells
  sheen: number; // where the light running along the line is, in screens
  beat: number; // heartbeats since the page opened, for the notes
  color: Hsl;
  line: Float32Array; // where the wave runs
  base: Float32Array; // the line it rests on
  bell: Float32Array; // how far along its swing each point is, 0-1
}

// One wave per heart on either side of a shared axis: red above for Person 1,
// blue below for Person 2.
// - A faster heart packs more, steeper and taller bells into its wave, and the
//   wave swells while that heart is speeding up.
// - The faster heart's wave travels right and the slower one's left, the
//   quicker the further apart they are, each leaning the way it goes.
// - As the two rates converge the waves close in on the axis, turn pink and
//   fall into step, until one is the mirror image of the other. Wherever two
//   bells face each other the space between them lights up.
export default function WaveformV2({ ratesRef }: { ratesRef: RefObject<LiveHeartRates> }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { antialias: false });
    if (!stage || !canvas || !gl) return;
    const notes = stage.querySelectorAll<HTMLElement>("[data-note]");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type);
      if (!shader) return;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    let skip = 0;
    for (const [name, size] of [["a_at", 2], ["a_rim", 2], ["a_ink", 4]] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, FLOATS * 4, skip * 4);
      skip += size;
    }
    const uSize = gl.getUniformLocation(program, "u_size");
    // Light adds up, so red over blue reads pink
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

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
    const waves: Wave[] = PEOPLE.map(() => ({
      bpm: REST_BPM, quick: REST_BPM, calm: REST_BPM, level: 0, amp: REST_AMP, speed: DRIFT,
      offset: 0, sheen: 0, beat: 0, color: VIOLET, line: row(), base: row(), bell: row(),
    }));
    const axis = row();
    const shine = row();
    const vertices = new Float32Array(STRIPS * ((STEPS + 1) * 2 + 2) * FLOATS);
    const opened = performance.now();
    let filled = 0;
    let ink = [0, 0, 0];
    let sync = 0; // 0 = apart, 1 = the two hearts agree
    let harmony = 0; // builds up while they stay in sync
    let last = opened;
    let nextNote = 0;
    let raf = 0;

    const vertex = (x: number, y: number, side: number, half: number, color: number[], alpha: number) => {
      vertices[filled++] = x;
      vertices[filled++] = y;
      vertices[filled++] = side;
      vertices[filled++] = half;
      vertices[filled++] = color[0];
      vertices[filled++] = color[1];
      vertices[filled++] = color[2];
      vertices[filled++] = alpha;
    };
    // Every strip starts with a zero-area bridge from the one before it
    const bridge = (x: number, y: number) => {
      if (filled === 0) return;
      vertices.copyWithin(filled, filled - FLOATS, filled);
      filled += FLOATS;
      vertex(x, y, 0, 1, ink, 0);
    };
    // A stroke `width` pixels wide along `ys` in the current ink, or a soft
    // halo of that reach; `glint` brightens it along the way
    const stroke = (ys: Float32Array, width: number, alpha: number, halo = false, glint?: Float32Array) => {
      const dx = canvas.width / STEPS;
      const reach = halo ? width : width / 2 + 0.5;
      const half = halo ? -1 : reach;
      for (let j = 0; j <= STEPS; j++) {
        // A halo goes straight up and down: wide strips fold over on tight bends
        let ox = 0;
        let oy = reach;
        if (!halo) {
          const dy = ys[Math.min(j + 1, STEPS)] - ys[Math.max(j - 1, 0)];
          const run = j === 0 || j === STEPS ? dx : 2 * dx;
          const scale = reach / Math.hypot(run, dy);
          ox = -dy * scale;
          oy = run * scale;
        }
        const a = alpha * FADE[j] * (glint ? glint[j] : 1);
        if (j === 0) bridge(-ox, ys[0] - oy);
        vertex(j * dx - ox, ys[j] - oy, -1, half, ink, a);
        vertex(j * dx + ox, ys[j] + oy, 1, half, ink, a);
      }
    };

    const launchNote = (p: number) => {
      const { line, base, color, speed } = waves[p];
      const H = canvas.height;
      // Crests of this wave, away from the tapered ends
      const crests: number[] = [];
      for (let j = Math.round(STEPS * 0.15); j < STEPS * 0.85; j++) {
        const rise = Math.abs(line[j] - base[j]);
        if (rise > H * AMP * 0.3 && rise >= Math.abs(line[j - 1] - base[j - 1]) &&
          rise > Math.abs(line[j + 1] - base[j + 1])) crests.push(j);
      }
      if (crests.length === 0) return;
      const j = crests[Math.floor(Math.random() * crests.length)];
      const note = notes[nextNote++ % notes.length];
      const sway = (Math.random() - 0.5) * 3;
      // Away from the axis, carried the way the wave is travelling
      const away = PEOPLE[p].side;
      const along = clamp(speed / DRIFT, -3, 3);
      // vw/vh, so the flight scales with the screen
      const place = (x: number, y: number, scale: number, turn: number) =>
        `translate(calc(-50% + ${x}vw), calc(-50% + ${away * y}vh)) scale(${scale}) rotate(${turn}deg)`;
      note.style.left = `${(j / STEPS) * 100}%`;
      note.style.top = `${(line[j] / H) * 100}%`;
      note.style.color = `hsl(${color[0]} ${color[1]}% ${color[2] + 12}%)`;
      // Pop out of the crest, then float off and fade
      note.animate(
        [
          { opacity: 0, transform: place(0, 0, 0.3, 0) },
          { opacity: 1, transform: place(0.3 * along, 3, 1, sway * 2), offset: 0.15 },
          { opacity: 0.8, offset: 0.6 },
          { opacity: 0, transform: place(2.4 * along + sway, 14, 1.1, sway * 6) },
        ],
        { duration: 4200, easing: "ease-out" }
      );
    };

    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const t = still ? 0 : (now - opened) / 1000;
      const ease = (tau: number) => 1 - Math.exp(-dt / tau);
      // A reading counts until it is as old as the ring card's stale limit
      const wall = Date.now();
      const bpm = ratesRef.current.map((s) => (s && wall - s.at < HR_STALE_MS ? s.bpm : null));
      const gap = bpm[0] !== null && bpm[1] !== null ? Math.abs(bpm[0] - bpm[1]) : null;
      const mean = bpm[0] !== null && bpm[1] !== null ? (bpm[0] + bpm[1]) / 2 : null;

      sync += ((gap === null ? 0 : 1 / (1 + (gap / 6) ** 2)) - sync) * ease(1.2);
      harmony += ((sync > 0.75 ? 1 : 0) - harmony) * ease(sync > 0.75 ? 5 : 2.5);
      // Within a few BPM of each other the two waves pull into step
      const pull = gap === null ? 0
        : (0.25 / (1 + (gap / 2.5) ** 2)) * Math.sin(TAU * (waves[1].offset - waves[0].offset)) * Math.min(dt, 0.1);

      waves.forEach((w, p) => {
        const b = bpm[p];
        const reading = b ?? REST_BPM;
        // A reading that has just appeared is neither rising nor falling yet
        if (b !== null && w.level < 0.02) w.quick = w.calm = b;
        w.level += ((b === null ? 0 : 1) - w.level) * ease(0.8);
        w.bpm += (reading - w.bpm) * ease(2);
        w.quick += (reading - w.quick) * ease(1.5);
        w.calm += (reading - w.calm) * ease(10);
        // Faster hearts swing wider, more so while they are speeding up
        const rising = clamp((w.quick - w.calm) / 5, -1, 1);
        const swing = b === null ? REST_AMP : (0.62 + 0.38 * clamp((b - 55) / 55, 0, 1)) * (1 + 0.2 * rising);
        w.amp += (swing - w.amp) * ease(1.2);
        // Above the pair's mean a wave travels right, below it left
        const heading = b === null || mean === null ? DRIFT : DRIFT + SLIDE * (b - mean);
        w.speed += (clamp(heading, -TOP_SPEED, TOP_SPEED) - w.speed) * ease(1.5);
        w.color = mix(mix(PEOPLE[p].rest, PEOPLE[p].color, w.level), PINK, sync);
        if (still) return;
        w.offset += ((w.speed * w.bpm) / BPM_PER_BELL) * dt + (p === 0 ? pull : -pull);
        w.sheen += 3.5 * w.speed * dt;
        const beats = Math.floor(w.beat);
        w.beat += (reading / 60) * dt;
        if (b !== null && dt < 0.25 && Math.floor(w.beat) > beats && Math.random() < 0.3 + 0.3 * harmony) {
          launchNote(p);
        }
      });

      const W = canvas.width;
      const H = canvas.height;
      const cy = H / 2;
      // Out of sync each wave keeps its distance from the axis; in sync, or
      // while one of them is still at rest, they meet on it
      const apart = APART * (1 - sync) * waves[0].level * waves[1].level;
      // Each wave's own irregular value; in sync both take the shared one, so
      // one ends up the mirror image of the other
      const own = (x: number, seed: number, trait: number) =>
        lerp(wander(x, t, seed + trait), wander(x, t, SHARED + trait), sync);
      waves.forEach((w, p) => {
        const { side, seed } = PEOPLE[p];
        const bells = w.bpm / BPM_PER_BELL;
        const hurry = clamp((w.bpm - 55) / 55, 0, 1);
        // Bells lean the way they travel
        const lean = Math.exp(0.35 * Math.tanh(w.speed / 0.04));
        // The whole wave also swells and settles, at no fixed pace
        const breath = 0.82 + 0.18 * lerp(grain(0.07 * t + seed, seed), grain(0.07 * t, SHARED), sync);
        for (let j = 0; j <= STEPS; j++) {
          const x = j / STEPS;
          const phase = bells * (x - 0.5) - w.offset + 0.1 * (own(x, seed, 11) - 0.5);
          const steep = 2.5 + 1.8 * hurry + 0.8 * (own(x, seed, 31) - 0.5);
          w.bell[j] = Math.sin(Math.PI * (phase - Math.floor(phase)) ** lean) ** steep *
            (0.55 + 0.45 * own(x, seed, 0));
          w.base[j] = cy + side * apart * H * TAPER[j];
          w.line[j] = w.base[j] + side * w.amp * breath * AMP * H * TAPER[j] * w.bell[j];
        }
      });

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uSize, W, H);
      const unit = H / 1080;
      const dx = W / STEPS;
      const together = Math.min(waves[0].level, waves[1].level);
      filled = 0;
      // The axis they meet on glows as they get closer
      axis.fill(cy);
      ink = rgb(mix(VIOLET, PINK, sync));
      stroke(axis, 0.2 * H, 0.03 + 0.08 * sync + 0.06 * harmony, true);
      waves.forEach((w) => {
        // A curtain of light from the wave to the axis, lit up in pink
        // wherever one of its bells faces one of the other wave's
        const body = rgb(w.color);
        const heart = rgb(mix(w.color, PINK, 0.6), 6);
        const lit = together * (0.12 + 0.5 * sync + 0.2 * harmony);
        ink = body;
        bridge(0, w.line[0]);
        for (let j = 0; j <= STEPS; j++) {
          vertex(j * dx, w.line[j], 0, 1, body, 0.22 * FADE[j]);
          vertex(j * dx, cy, 0, 1, heart, (0.02 + lit * waves[0].bell[j] * waves[1].bell[j]) * FADE[j]);
        }
        // Light runs along the line the way the wave is going
        const flow = 0.6 * w.level * Math.min(1, Math.abs(w.speed) / DRIFT);
        for (let j = 0; j <= STEPS; j++) {
          const u = (j / STEPS - w.sheen) * 3;
          shine[j] = 1 + flow * Math.exp(-(((u - Math.floor(u) - 0.5) / 0.12) ** 2));
        }
        // Its colour hangs in the air around it
        stroke(w.line, 0.24 * H, 0.05 * w.level, true);
        stroke(w.line, 60 * unit, 0.08, true, shine);
        stroke(w.line, 22 * unit, 0.2, true, shine);
        stroke(w.line, 3.2 * unit, 0.95, false, shine);
        ink = rgb(w.color, 22);
        stroke(w.line, 1.1 * unit, 0.75, false, shine);
      });
      gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, filled), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, filled / FLOATS);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [ratesRef]);

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
