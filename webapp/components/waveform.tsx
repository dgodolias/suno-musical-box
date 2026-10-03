"use client";

import { useEffect, useRef, type RefObject } from "react";
import { Headphones, Music, Music2 } from "lucide-react";

// Latest heart rate per person; null until that ring has delivered one.
export type LiveHeartRates = [number | null, number | null];

// The svg stretches this user space over its box; strokes keep their width.
const W = 1000;
const H = 200;
const CY = 112; // below the middle: the notes need the headroom
const STEPS = 120;
const LINES = 18;
const AMP = 62; // tallest crest while the two sides are level
const SIDE_LOBES = 3;
const BREATH_SEC = 3.2;
const TILT_BPM = 4; // a gap this wide already tilts most of the way
const NOTE_GAP_MS = 650;

// Fixed outline, mirrored around the middle: zero there and at both ends,
// with each side's lobes in between.
const SHAPE = Array.from({ length: STEPS + 1 }, (_, j) => {
  const v = Math.abs((2 * j) / STEPS - 1); // 0 in the middle, 1 at either end
  const a = Math.sin(Math.PI * SIDE_LOBES * v);
  const b = Math.sin(Math.PI * (SIDE_LOBES * v - 0.07));
  const c = Math.cos(Math.PI * SIDE_LOBES * v);
  return {
    x: `${((j / STEPS) * W).toFixed(1)} `,
    v,
    top: Math.sin(Math.PI * v) * a * a,
    bottom: 0.78 * Math.sin(Math.PI * v ** 1.3) * b * b,
    // Soft echo filling the gaps between the lobes
    echo: 0.5 * Math.sin(Math.PI * v) ** 2 * c * c,
  };
});

// Same icons as the floating background; they rise from the crests
const NOTES = [Music, Music2, Headphones, Music2, Music, Music2, Music, Headphones, Music2, Music];

// A ribbon of strands, person 1 on the left and person 2 on the right. Both
// sides breathe at the same steady pace whatever the heart rates are; only the
// gap between the two hearts shows, as the faster side growing and the slower
// one shrinking.
export default function Waveform({
  heartRatesRef,
}: {
  heartRatesRef: RefObject<LiveHeartRates>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const lines = stage.querySelectorAll<SVGPathElement>("[data-line]");
    const ghost = stage.querySelector<SVGPathElement>("[data-ghost]");
    const notes = stage.querySelectorAll<HTMLElement>("[data-note]");
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const top = new Float32Array(STEPS + 1);
    const bottom = new Float32Array(STEPS + 1);
    const echo = new Float32Array(STEPS + 1);
    let level = 0; // opens up from a flat line on mount
    let tilt = 0; // -1 = all person 1, 1 = all person 2
    let clock = 0;
    let nextNote = 0;
    let lastNote = 0;
    let last = performance.now();
    let raf = 0;

    const launchNote = (now: number) => {
      // Crests of the top edge tall enough to leave from
      const crests: number[] = [];
      for (let j = 1; j < STEPS; j++) {
        if (top[j] < -AMP * 0.2 && top[j] <= top[j - 1] && top[j] < top[j + 1]) crests.push(j);
      }
      if (crests.length === 0) return;
      lastNote = now;
      const j = crests[Math.floor(Math.random() * crests.length)] + Math.round((Math.random() - 0.5) * 6);
      const note = notes[nextNote++ % notes.length];
      const sway = (Math.random() - 0.5) * 56;
      const at = (x: number, y: number, scale: number) =>
        `translate(calc(-50% + ${x}px), calc(-50% - ${y}px)) scale(${scale}) rotate(${x / 2}deg)`;
      note.style.left = `${(j / STEPS) * 100}%`;
      note.style.top = `${((CY + top[j]) / H) * 100}%`;
      // Pop out of the crest, then float up and fade
      note.animate(
        [
          { opacity: 0, transform: at(0, 0, 0.3) },
          { opacity: 0.9, transform: at(sway * 0.2, 16, 1), offset: 0.15 },
          { opacity: 0.7, offset: 0.6 },
          { opacity: 0, transform: at(sway, 76, 1) },
        ],
        { duration: 2600, easing: "ease-out" }
      );
    };

    const frame = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;

      // Equal hearts, or one still missing, keep the two sides level
      const [hr1, hr2] = heartRatesRef.current;
      const gap = hr1 !== null && hr2 !== null ? hr2 - hr1 : 0;
      tilt += (Math.tanh(gap / TILT_BPM) - tilt) * (1 - Math.exp(-3 * dt));
      level += (1 - level) * (1 - Math.exp(-2.5 * dt));
      if (!still) clock += (dt * 2 * Math.PI) / BREATH_SEC;

      for (let j = 0; j <= STEPS; j++) {
        const shape = SHAPE[j];
        const side = level * AMP * (1 + (j < STEPS / 2 ? -0.5 : 0.5) * tilt);
        // The breath ripples outwards from the middle, the same on both sides
        const phase = clock - 1.5 * shape.v;
        top[j] = -side * (0.8 + 0.2 * Math.sin(phase)) * shape.top;
        bottom[j] = side * (0.8 + 0.2 * Math.sin(phase - 0.7)) * shape.bottom;
        echo[j] = side * (0.8 + 0.2 * Math.sin(phase - 1.6)) * shape.echo;
      }

      lines.forEach((line, k) => {
        const mix = k / (LINES - 1);
        let d = "";
        for (let j = 0; j <= STEPS; j++) {
          d += (j ? "L" : "M") + SHAPE[j].x + (CY + top[j] + (bottom[j] - top[j]) * mix).toFixed(1);
        }
        line.setAttribute("d", d);
      });
      let d = "";
      for (let j = 0; j <= STEPS; j++) d += (j ? "L" : "M") + SHAPE[j].x + (CY - echo[j]).toFixed(1);
      for (let j = STEPS; j >= 0; j--) d += "L" + SHAPE[j].x + (CY + echo[j] * 0.8).toFixed(1);
      ghost?.setAttribute("d", d + "Z");

      if (!still && now - lastNote > NOTE_GAP_MS) launchNote(now);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [heartRatesRef]);

  return (
    <div
      ref={stageRef}
      aria-hidden
      className="pointer-events-none relative h-44 animate-in fade-in duration-700"
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        <defs>
          {/* Brand primary on the centre line, fanning to violet above and blue below */}
          <linearGradient
            id="waveform-strands"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={CY - 60}
            x2="0"
            y2={CY + 60}
          >
            <stop offset="0" stopColor="hsl(270 85% 68%)" />
            <stop offset="0.5" style={{ stopColor: "hsl(var(--primary))" }} />
            <stop offset="1" stopColor="hsl(220 90% 64%)" />
          </linearGradient>
        </defs>
        <path data-ghost className="fill-primary/20" />
        <g fill="none" stroke="url(#waveform-strands)" strokeLinejoin="round">
          {Array.from({ length: LINES }, (_, k) => (
            <path
              key={k}
              data-line
              vectorEffect="non-scaling-stroke"
              strokeWidth={k === 0 || k === LINES - 1 ? 1.75 : 1.1}
            />
          ))}
        </g>
      </svg>
      {NOTES.map((Icon, i) => (
        <span key={i} data-note className="absolute text-primary opacity-0">
          <Icon size={18 + (i % 3) * 4} strokeWidth={2} />
        </span>
      ))}
    </div>
  );
}
