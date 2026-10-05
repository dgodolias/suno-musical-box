"use client";

import { useEffect, useRef, type RefObject } from "react";
import { Headphones, Music, Music2, Music4 } from "lucide-react";
import { HR_STALE_MS } from "@/lib/ble/ring-manager";
import type { LiveHeartRates } from "@/lib/heart-rate-channel";

const TAU = Math.PI * 2;
const CROSS_S = 14; // seconds for a lobe to drift across the screen
const BEATS_PER_LOBE = 4;
const STEPS = 240;
const STRANDS = 20;
const EDGE = 0.12; // share of the width tapered at each end
const CY = 0.5; // centre line, as a share of the height
const AMP = 0.34; // tallest swing, as a share of the height
const APART = 0.085; // how far from the centre each ribbon rides when out of sync
const REST_HZ = 0.75; // pace with no reading
const REST_AMP = 0.05;
const SHARED = 7.7; // seed of the shape both ribbons take once in sync

type Hsl = [number, number, number];
// Hues are unwrapped so a plain lerp turns the intended way round the wheel
const VIOLET: Hsl = [252, 85, 70]; // EduCoach primary: the thread at rest
const PINK: Hsl = [322, 95, 68]; // both ribbons once the two hearts agree
const PEOPLE = [
  // Person 1, size 9 ring: red, rides above and swings mostly upwards
  { color: [358, 96, 58] as Hsl, side: -1, up: 1, down: 0.55, seed: 0.9 },
  // Person 2, size 11 ring: blue, rides below and swings mostly downwards
  { color: [214, 98, 58] as Hsl, side: 1, up: 0.55, down: 1, seed: 4.1 },
];

// Same icons as the floating background; they rise from the crests
const NOTES = [Music, Music2, Headphones, Music4, Music2, Music, Music2, Headphones, Music, Music4, Music2, Music];

// Raised-cosine taper, so both ends rest on the centre line
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
const mix = (a: Hsl, b: Hsl, t: number): Hsl => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function rgb([h, s, l]: Hsl, dh = 0, dl = 0): [number, number, number] {
  const light = (l + dl) / 100;
  const a = (s / 100) * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (n + (h + dh + 360) / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// One lobe: a bell leaning forwards in the direction of travel, with a flat
// stretch before the next one; `steep` sharpens it
function lobe(phase: number, steep: number) {
  return Math.sin(Math.PI * (phase - Math.floor(phase)) ** 0.85) ** steep;
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

// Irregular 0-1 value for a place on the screen and a moment. It drifts to
// the right slower than the lobes and keeps changing, so every lobe swells and
// shrinks on its own as it travels and no two stretches of a ribbon look alike
function wander(x: number, t: number, seed: number) {
  const n = 0.65 * grain(4.2 * x - 0.19 * t + seed, 0.1 * t + seed) +
    0.35 * grain(9.7 * x - 0.31 * t + seed * 3.1, 0.17 * t - seed);
  const s = Math.min(1, Math.max(0, (n - 0.24) / 0.52));
  return s * s * (3 - 2 * s);
}

// Strokes are triangle strips of [x, y, side, alpha, half] vertices: `side`
// runs -1..1 across the stroke and `half` is its half width in pixels, which
// feathers the rim; a negative `half` asks for a soft halo instead.
const VERTEX = `
attribute vec2 a_at;
attribute vec3 a_ink;
uniform vec2 u_size;
varying vec3 v_ink;
varying float v_y;
void main() {
  v_ink = a_ink;
  v_y = a_at.y / u_size.y;
  gl_Position = vec4(a_at / u_size * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
}`;
const FRAGMENT = `
precision mediump float;
uniform vec3 u_top;
uniform vec3 u_mid;
uniform vec3 u_bottom;
varying vec3 v_ink;
varying float v_y;
void main() {
  float rim = 1.0 - abs(v_ink.x);
  float cover = v_ink.z < 0.0 ? rim * rim : clamp(rim * v_ink.z, 0.0, 1.0);
  float g = clamp((v_y - ${(CY - 0.35).toFixed(2)}) / 0.7, 0.0, 1.0);
  vec3 color = g < 0.5 ? mix(u_top, u_mid, g * 2.0) : mix(u_mid, u_bottom, g * 2.0 - 1.0);
  gl_FragColor = vec4(color, 1.0) * (cover * v_ink.y);
}`;
const STRIPS = STRANDS + 4; // strands, three halos and the body
const FLOATS = 5;

interface Trace {
  rate: number; // beats per second, following the reading closely
  density: number; // the same, eased slowly: sets how tightly the lobes are packed
  phase: number; // beats since the page opened
  level: number; // 0 at rest, 1 live
  amp: number; // eased swing, 0-1
  color: Hsl;
  top: Float32Array;
  bottom: Float32Array;
  mid: Float32Array;
}

// Two heartbeat ribbons drifting to the right: red for Person 1, blue for
// Person 2. Everything on screen follows the current readings: a faster heart
// packs its lobes tighter and swings wider. As the two heart rates converge,
// the ribbons fall into step, close in on each other and turn pink, until
// they move as one.
export default function Waveform({ ratesRef }: { ratesRef: RefObject<LiveHeartRates> }) {
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
    const at = gl.getAttribLocation(program, "a_at");
    const ink = gl.getAttribLocation(program, "a_ink");
    gl.enableVertexAttribArray(at);
    gl.enableVertexAttribArray(ink);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, FLOATS * 4, 0);
    gl.vertexAttribPointer(ink, 3, gl.FLOAT, false, FLOATS * 4, 8);
    const uniform = (name: string) => gl.getUniformLocation(program, name);
    const uSize = uniform("u_size");
    const uShades = [uniform("u_top"), uniform("u_mid"), uniform("u_bottom")];
    // Light adds up: strands glow where they bunch, and red over blue reads pink
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

    const traces: Trace[] = PEOPLE.map(() => ({
      rate: REST_HZ, density: REST_HZ, phase: 0, level: 0, amp: REST_AMP, color: VIOLET,
      top: new Float32Array(STEPS + 1), bottom: new Float32Array(STEPS + 1), mid: new Float32Array(STEPS + 1),
    }));
    const line = new Float32Array(STEPS + 1);
    const skew = new Float32Array(STEPS + 1);
    const vertices = new Float32Array(STRIPS * ((STEPS + 1) * 2 + 2) * FLOATS);
    const opened = performance.now();
    let filled = 0;
    let sync = 0; // 0 = apart, 1 = the two hearts agree
    let last = opened;
    let nextNote = 0;
    let raf = 0;

    const vertex = (x: number, y: number, side: number, alpha: number, half: number) => {
      vertices[filled++] = x;
      vertices[filled++] = y;
      vertices[filled++] = side;
      vertices[filled++] = alpha;
      vertices[filled++] = half;
    };
    // Every strip starts with a zero-area bridge from the one before it
    const bridge = (x: number, y: number, side: number, alpha: number, half: number) => {
      if (filled === 0) return;
      vertices.copyWithin(filled, filled - FLOATS, filled);
      filled += FLOATS;
      vertex(x, y, side, alpha, half);
    };
    // The body of a ribbon: everything between its two edges
    const fill = (upper: Float32Array, lower: Float32Array, alpha: number) => {
      const dx = canvas.width / STEPS;
      bridge(0, upper[0], 0, 0, 1);
      for (let j = 0; j <= STEPS; j++) {
        vertex(j * dx, upper[j], 0, alpha * FADE[j], 1);
        vertex(j * dx, lower[j], 0, alpha * FADE[j], 1);
      }
    };
    // A stroke `width` pixels wide along `ys`, or a soft halo of that reach
    const stroke = (ys: Float32Array, width: number, alpha: number, halo = false) => {
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
        const a = alpha * FADE[j];
        if (j === 0) bridge(-ox, ys[0] - oy, -1, a, half);
        vertex(j * dx - ox, ys[j] - oy, -1, a, half);
        vertex(j * dx + ox, ys[j] + oy, 1, a, half);
      }
    };

    const launchNote = (p: number) => {
      const { top, mid, color } = traces[p];
      const H = canvas.height;
      // Crests of this ribbon's top edge, away from the tapered ends
      const crests: number[] = [];
      for (let j = Math.round(STEPS * 0.15); j < STEPS * 0.85; j++) {
        if (mid[j] - top[j] > H * AMP * 0.3 && top[j] <= top[j - 1] && top[j] < top[j + 1]) crests.push(j);
      }
      if (crests.length === 0) return;
      const j = crests[Math.floor(Math.random() * crests.length)];
      const note = notes[nextNote++ % notes.length];
      const sway = (Math.random() - 0.5) * 3;
      // vw/vh, so the flight scales with the screen
      const place = (x: number, y: number, scale: number, turn: number) =>
        `translate(calc(-50% + ${x}vw), calc(-50% - ${y}vh)) scale(${scale}) rotate(${turn}deg)`;
      note.style.left = `${(j / STEPS) * 100}%`;
      note.style.top = `${(top[j] / H) * 100}%`;
      note.style.color = `hsl(${color[0] + 8} ${color[1]}% ${color[2] + 10}%)`;
      // Pop out of the crest, then rise and drift on with the wave
      note.animate(
        [
          { opacity: 0, transform: place(0, 0, 0.3, 0) },
          { opacity: 1, transform: place(0.4, 3, 1, sway * 2), offset: 0.15 },
          { opacity: 0.8, offset: 0.6 },
          { opacity: 0, transform: place(3 + sway, 16, 1.1, sway * 6) },
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

      sync += ((gap === null ? 0 : 1 / (1 + (gap / 6) ** 2)) - sync) * ease(1.2);
      // Within a few BPM of each other the two carriers pull into step
      const pull = gap === null ? 0
        : (0.25 / (1 + (gap / 2.5) ** 2)) *
          Math.sin((TAU * (traces[1].phase - traces[0].phase)) / BEATS_PER_LOBE) * Math.min(dt, 0.1);

      traces.forEach((tr, p) => {
        const b = bpm[p];
        const hz = b === null ? REST_HZ : b / 60;
        tr.level += ((b === null ? 0 : 1) - tr.level) * ease(0.8);
        tr.rate += (hz - tr.rate) * ease(0.6);
        tr.density += (hz - tr.density) * ease(2.5);
        // Faster hearts swing wider
        const swing = b === null ? REST_AMP : 0.7 + 0.3 * Math.min(1, Math.max(0, (b - 55) / 50));
        tr.amp += (swing - tr.amp) * ease(1.2);
        const before = tr.phase;
        if (!still) tr.phase += tr.rate * dt + (p === 0 ? pull : -pull);
        if (b !== null && dt < 0.25 && Math.floor(tr.phase) > Math.floor(before) && Math.random() < 0.35) {
          launchNote(p);
        }
        tr.color = mix(mix(VIOLET, PEOPLE[p].color, tr.level), PINK, sync);
      });

      const W = canvas.width;
      const H = canvas.height;
      // Out of sync each ribbon keeps to its own lane; in sync, or while one
      // of them is still at rest, they share the centre
      const apart = APART * (1 - sync) * traces[0].level * traces[1].level;
      // Each ribbon's own irregular value; in sync both take the shared one,
      // so they end up with the same shape and move as one
      const own = (x: number, seed: number, trait: number) =>
        lerp(wander(x, t, seed + trait), wander(x, t, SHARED + trait), sync);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uSize, W, H);
      const unit = H / 1080;
      traces.forEach((tr, p) => {
        const person = PEOPLE[p];
        const seed = person.seed;
        const up = lerp(person.up, 0.85, sync);
        const down = lerp(person.down, 0.85, sync);
        // The whole ribbon also swells and settles, at no fixed pace
        const breath = 0.78 + 0.22 * lerp(grain(0.07 * t + seed, seed), grain(0.07 * t, SHARED), sync);
        for (let j = 0; j <= STEPS; j++) {
          const x = j / STEPS;
          // Lobes drift right at a steady pace and the heart rate packs
          // them; how wide, tall and steep each one is keeps wandering
          const carrier = (tr.phase - tr.density * CROSS_S * x) / BEATS_PER_LOBE +
            0.24 * (own(x, seed, 11) - 0.5);
          const reach = tr.amp * breath * AMP * H * TAPER[j];
          const lag = 0.05 + 0.2 * own(x, seed, 23);
          const lane = person.side * apart * (1 + 0.25 * Math.sin(TAU * (0.5 * x - t / 21) + seed));
          tr.mid[j] = H * (CY + TAPER[j] * (0.012 * Math.sin(TAU * (0.8 * x - t / 15)) + lane));
          tr.top[j] = tr.mid[j] -
            reach * up * (0.16 + 0.84 * own(x, seed, 0)) * lobe(carrier, 2.2 + 2.4 * own(x, seed, 31));
          tr.bottom[j] = tr.mid[j] +
            reach * down * (0.16 + 0.84 * own(x, seed, 5)) * lobe(carrier - lag, 2.2 + 2.4 * own(x, seed, 37));
          // Where the strands crowd inside the ribbon wanders too
          skew[j] = Math.exp(1.1 * (own(x, seed, 43) - 0.5));
        }

        filled = 0;
        // Soft body, then a glow around both edges and the core
        fill(tr.top, tr.bottom, 0.09);
        for (let j = 0; j <= STEPS; j++) line[j] = (tr.top[j] + tr.bottom[j]) / 2;
        stroke(line, 46 * unit, 0.12, true);
        stroke(tr.top, 30 * unit, 0.18, true);
        stroke(tr.bottom, 30 * unit, 0.18, true);
        // Strands fanning from the top edge to the bottom one
        for (let s = 0; s < STRANDS; s++) {
          const m = s / (STRANDS - 1);
          const edge = s === 0 || s === STRANDS - 1;
          for (let j = 0; j <= STEPS; j++) line[j] = tr.top[j] + (tr.bottom[j] - tr.top[j]) * m ** skew[j];
          stroke(line, (edge ? 2.2 : 1.1) * unit, edge ? 0.85 : 0.42);
        }
        gl.uniform3fv(uShades[0], rgb(tr.color, 14, 10));
        gl.uniform3fv(uShades[1], rgb(tr.color));
        gl.uniform3fv(uShades[2], rgb(tr.color, -12, -4));
        gl.bufferData(gl.ARRAY_BUFFER, vertices.subarray(0, filled), gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, filled / FLOATS);
      });

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
