"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import ThemeToggle from "@/components/theme-toggle";
import Waveform from "@/components/waveform";
import type { Replay } from "@/lib/db";
import {
  HEART_RATE_CHANNEL,
  type HeartRateMessage,
  type LiveHeartRates,
  type SessionPlan,
} from "@/lib/heart-rate-channel";
import { placebo } from "@/lib/progress";

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

// How long into a replay the song arrives, with ?song, a little later than
// its bar expects
const REPLAY_SONG_MS = 15000;

// The wait for the song, filling from one edge of the screen to the other
// under the waves: no figure, just how far along it is. Once the song comes
// it fills up and goes
function WaitBar({ plan, done }: { plan: SessionPlan; done: boolean }) {
  const [share, setShare] = useState(() => placebo(Date.now() - plan.startedAt, plan.expectedMs));
  useEffect(() => {
    const timer = setInterval(() => setShare(placebo(Date.now() - plan.startedAt, plan.expectedMs)), 200);
    return () => clearInterval(timer);
  }, [plan]);
  return (
    <div
      className={`absolute inset-x-0 bottom-[11vh] h-[0.5vh] min-h-[3px] bg-primary/15 ${
        done ? "animate-out fade-out fill-mode-forwards delay-700 duration-1000" : "animate-in fade-in duration-700"
      }`}
    >
      <div
        className="h-full transition-[clip-path] duration-500 ease-linear"
        style={{
          clipPath: `inset(0 ${100 - (done ? 100 : share)}% 0 0)`,
          background: "linear-gradient(90deg, hsl(358 96% 58%), hsl(322 95% 68%), hsl(214 98% 58%))",
          boxShadow: "0 0 1vh hsl(322 95% 68% / 0.6)",
        }}
      />
    </div>
  );
}

// Full-screen display for a TV: only the waves, fed by the Musical Box page
// open in another tab of the same browser. Double-click for full screen.
// With `replay` (?mock) it plays a recorded session instead.
export default function SyncWave({ replay, song = false }: { replay?: Replay | null; song?: boolean }) {
  const ratesRef = useRef<LiveHeartRates>([null, null]);
  const songRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
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
    // The waves become the song's note while it is ready, with its words below
    const arrive = (on: boolean) => {
      songRef.current = on;
      setReady(on);
    };
    if (replay !== undefined) {
      if (!replay) return;
      const stop = startReplay(replay, ratesRef);
      if (!song) return stop;
      // The bar expects the song a little before it comes
      const begun = Date.now();
      const bar = setTimeout(() => setPlan({ startedAt: begun, expectedMs: 0.8 * REPLAY_SONG_MS }));
      const timer = setTimeout(() => arrive(true), REPLAY_SONG_MS);
      return () => {
        stop();
        clearTimeout(bar);
        clearTimeout(timer);
      };
    }
    const channel = new BroadcastChannel(HEART_RATE_CHANNEL);
    // No answer means the Musical Box page is not open in this browser
    const hint = setTimeout(() => setUnlinked(true), 1500);
    channel.onmessage = (event: MessageEvent<HeartRateMessage>) => {
      const message = event.data;
      if (message.type !== "rates") return;
      ratesRef.current = message.rates;
      // A new plan only when it changes, so the bar does not restart
      setPlan((current) =>
        current?.startedAt === message.plan?.startedAt && current?.expectedMs === message.plan?.expectedMs
          ? current : message.plan
      );
      arrive(message.song);
      clearTimeout(hint);
      setUnlinked(false);
    };
    channel.postMessage({ type: "hello" } satisfies HeartRateMessage);
    return () => {
      clearTimeout(hint);
      channel.close();
    };
  }, [replay, song]);

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
      <Waveform ratesRef={ratesRef} songRef={songRef} />
      {plan && <WaitBar plan={plan} done={ready} />}
      <p className="absolute inset-x-0 bottom-[7vh] px-4 text-center text-[clamp(11px,0.9vw,18px)] text-muted-foreground/70">
        Created by dimosthenisgkontolias.com
      </p>
      {ready && (
        <div
          key="ready"
          className="absolute inset-x-0 top-[73vh] px-4 text-center animate-in fade-in slide-in-from-bottom-6 fill-mode-both delay-[2400ms] duration-1000 ease-out"
        >
          <p
            className="font-display text-[clamp(30px,4.4vw,88px)] leading-tight font-bold tracking-tight text-transparent"
            style={{
              backgroundImage: "linear-gradient(90deg, hsl(358 96% 62%), hsl(322 95% 66%), hsl(214 98% 62%))",
              backgroundClip: "text",
              WebkitBackgroundClip: "text",
              filter: "drop-shadow(0 0 1.2vw hsl(322 95% 68% / 0.45))",
            }}
          >
            Your song is ready!
          </p>
          <p className="mx-auto mt-[1.2vh] max-w-[70vw] text-[clamp(14px,1.5vw,30px)] text-muted-foreground">
            Two hearts met, fell into the same rhythm, and wrote this song together.
          </p>
        </div>
      )}
      <div
        onDoubleClick={(event) => event.stopPropagation()}
        className={`absolute top-[3vh] right-[3vw] transition-opacity duration-500 ${
          awake ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <ThemeToggle />
      </div>
      {unlinked && (
        <p className={`${note} inset-x-0 bottom-[3vh] px-4 text-center`}>
          Open the Musical Box in another tab of this browser to stream the rings.
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
