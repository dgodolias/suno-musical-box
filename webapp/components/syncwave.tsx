"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import ThemeToggle from "@/components/theme-toggle";
import Waveform from "@/components/waveform";
import type { Replay } from "@/lib/db";
import {
  HEART_RATE_CHANNEL,
  type HeartRateMessage,
  type LiveHeartRates,
} from "@/lib/heart-rate-channel";

// The page's colour mode, with a faint glow along the waves
const BACKDROP =
  "radial-gradient(60% 40% at 50% 50%, hsl(var(--syncwave-glow)), transparent 70%), " +
  "radial-gradient(130% 100% at 50% 50%, hsl(var(--syncwave-centre)), hsl(var(--syncwave-edge)) 75%)";

// Plays a recorded session back in real time, on a loop
function startReplay(replay: Replay, ratesRef: RefObject<LiveHeartRates>) {
  const people = ([1, 2] as const).map((id) => replay.readings.filter((r) => r.personId === id));
  const lap = replay.readings[replay.readings.length - 1].offsetMs + 1000;
  const start = Date.now();
  const tick = () => {
    const now = Date.now();
    const clock = (now - start) % lap;
    ratesRef.current = people.map((own) => {
      // Latest reading so far in this lap, else the last one of the lap before
      const latest = own.findLast((r) => r.offsetMs <= clock);
      if (latest) return { bpm: latest.heartRate, at: now - (clock - latest.offsetMs) };
      const previous = now - start >= lap ? own[own.length - 1] : undefined;
      return previous ? { bpm: previous.heartRate, at: now - (clock + lap - previous.offsetMs) } : null;
    }) as LiveHeartRates;
  };
  tick();
  const timer = setInterval(tick, 250);
  return () => clearInterval(timer);
}

// Full-screen display for a TV: only the waves, fed by the Musical Box page
// open in another window of the same browser. Double-click for full screen.
// With `replay` (?mock) it plays a recorded session instead.
export default function SyncWave({ replay }: { replay?: Replay | null }) {
  const ratesRef = useRef<LiveHeartRates>([null, null]);
  const [unlinked, setUnlinked] = useState(false);
  const [awake, setAwake] = useState(false);

  // The colour mode switch shows while the mouse moves, then gets out of the way
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setAwake(true);
      clearTimeout(timer);
      timer = setTimeout(() => setAwake(false), 2500);
    };
    window.addEventListener("pointermove", wake);
    return () => {
      window.removeEventListener("pointermove", wake);
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (replay !== undefined) return replay ? startReplay(replay, ratesRef) : undefined;
    const channel = new BroadcastChannel(HEART_RATE_CHANNEL);
    // No answer means the Musical Box page is not open in this browser
    const hint = setTimeout(() => setUnlinked(true), 1500);
    channel.onmessage = (event: MessageEvent<HeartRateMessage>) => {
      if (event.data.type !== "rates") return;
      ratesRef.current = event.data.rates;
      clearTimeout(hint);
      setUnlinked(false);
    };
    channel.postMessage({ type: "hello" } satisfies HeartRateMessage);
    return () => {
      clearTimeout(hint);
      channel.close();
    };
  }, [replay]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };

  const note = "absolute text-[clamp(13px,1.1vw,22px)] text-muted-foreground animate-in fade-in duration-700";
  return (
    <main
      onDoubleClick={toggleFullscreen}
      className="fixed inset-0 overflow-hidden select-none"
      style={{ background: BACKDROP }}
    >
      <Waveform ratesRef={ratesRef} />
      <div
        onDoubleClick={(event) => event.stopPropagation()}
        className={`absolute top-[3vh] right-[3vw] transition-opacity duration-500 ${
          awake ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <ThemeToggle />
      </div>
      {unlinked && (
        <p className={`${note} inset-x-0 bottom-[7vh] px-4 text-center`}>
          Open the Musical Box in another window of this browser to stream the rings.
        </p>
      )}
      {replay !== undefined && (
        <p className={`${note} right-[3vw] bottom-[3vh] opacity-60`}>
          {replay ? `Replay of recorded session #${replay.sessionId}` : "No recorded session to replay"}
        </p>
      )}
    </main>
  );
}
