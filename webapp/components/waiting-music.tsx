"use client";

import { useCallback, useEffect, useRef } from "react";
import { WAITING_MUSIC } from "@/lib/waiting-music";

const FADE_IN_MS = 2000;
const FADE_OUT_MS = 1000; // quick, so the song comes straight in
const RESTART_FADE_MS = 600; // a new round while it plays: out, then from the top
const END_FADE_S = 2.5; // the track's last seconds fade out before it starts again

// Plays while `playing`. It fades in once the page has been used (browsers
// allow sound only then; `onBlocked` says when it is waiting for that), fades
// out when `playing` ends, starts again from the top when `round` changes, and
// at the end of the track fades out and comes back in from the top. The fades
// follow the clock, so a background tab's slower timers still finish them.
export default function WaitingMusic({
  playing,
  volume,
  round,
  onBlocked,
}: {
  playing: boolean;
  volume: number; // 0-1
  round: number;
  onBlocked?: (blocked: boolean) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const mix = useRef({ gain: 0, from: 0, to: 0, at: 0, ms: 1, volume, playing });
  const onBlockedRef = useRef(onBlocked);
  const firstRound = useRef(round);

  useEffect(() => {
    onBlockedRef.current = onBlocked;
  }, [onBlocked]);

  const fadeTo = useCallback((to: number, ms: number) => {
    const m = mix.current;
    Object.assign(m, { from: m.gain, to, at: Date.now(), ms });
  }, []);
  // Plays on from where the track is, fading in
  const begin = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !mix.current.playing) return;
    audio.play().then(
      () => {
        onBlockedRef.current?.(false);
        fadeTo(1, FADE_IN_MS);
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") onBlockedRef.current?.(true);
      },
    );
  }, [fadeTo]);

  useEffect(() => {
    mix.current.volume = volume;
  }, [volume]);

  // A new round (New Session): from the top, after a short fade if it plays.
  // Runs before the effect below, so a round that also brings it back plays
  // from the top
  useEffect(() => {
    if (round === firstRound.current) return;
    firstRound.current = round;
    const audio = audioRef.current;
    if (!audio) return;
    const fromTheTop = () => {
      audio.currentTime = 0;
      mix.current.gain = 0;
      begin();
    };
    if (audio.paused || mix.current.gain < 0.01) {
      fromTheTop();
      return;
    }
    fadeTo(0, RESTART_FADE_MS);
    const timer = setTimeout(fromTheTop, RESTART_FADE_MS);
    return () => clearTimeout(timer);
  }, [round, begin, fadeTo]);

  useEffect(() => {
    mix.current.playing = playing;
    if (!playing) {
      onBlockedRef.current?.(false);
      fadeTo(0, FADE_OUT_MS);
      return;
    }
    begin();
    // Until the page has been used the browser refuses: the first press starts it
    const retry = () => {
      if (audioRef.current?.paused) begin();
    };
    window.addEventListener("pointerdown", retry);
    window.addEventListener("keydown", retry);
    return () => {
      window.removeEventListener("pointerdown", retry);
      window.removeEventListener("keydown", retry);
    };
  }, [playing, begin, fadeTo]);

  useEffect(() => {
    const timer = setInterval(() => {
      const audio = audioRef.current;
      const m = mix.current;
      if (!audio) return;
      const t = Math.min(1, (Date.now() - m.at) / m.ms);
      m.gain = m.from + (m.to - m.from) * t;
      // The last seconds of the track fade out; onEnded starts it again
      if (m.playing && m.to === 1 && audio.duration - audio.currentTime < END_FADE_S) fadeTo(0, END_FADE_S * 1000);
      if (!m.playing && t >= 1 && !audio.paused) audio.pause();
      audio.volume = Math.min(1, Math.max(0, m.gain * m.volume));
    }, 50);
    return () => clearInterval(timer);
  }, [fadeTo]);

  return (
    <audio
      ref={audioRef}
      src={WAITING_MUSIC}
      preload="auto"
      onEnded={() => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = 0;
        begin();
      }}
    />
  );
}
