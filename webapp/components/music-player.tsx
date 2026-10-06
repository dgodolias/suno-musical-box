"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import SendSongForm from "@/components/send-song-form";

interface Song {
  taskId: string;
  audioUrl: string;
  style: string;
  prompt: string;
  number: number;
}

interface MusicPlayerProps {
  currentSong: Song | null;
  history: Song[];
  generationStatus: string;
  generationProgress?: number;
  onStarted?: () => void; // the song has started playing, or cannot
  onSongEnd?: () => void;
}

// Quiet music while the song is on its way: take 2B of three Suno candidates
// (lo-fi, Rhodes, 2 min). Its volume is the listener's, kept in this browser.
const WAITING_MUSIC = "/waiting-music.mp3";
const VOLUME_KEY = "musical-box-waiting-volume";
const DEFAULT_VOLUME = 0.25;
const FADE_IN_MS = 2000;
const FADE_OUT_MS = 1000; // quick, so the song comes straight in
const END_FADE_S = 2.5; // the track's last seconds fade out before it starts again

// The chosen volume, shared by the slider and the music; also kept in memory
// for browsers that store nothing
let volumeInMemory = DEFAULT_VOLUME;
const volumeListeners = new Set<() => void>();
function readVolume() {
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    const value = saved === null ? NaN : Number(saved);
    if (value >= 0 && value <= 1) return value;
  } catch {
    // storage unavailable: memory only
  }
  return volumeInMemory;
}
function saveVolume(value: number) {
  volumeInMemory = value;
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    // storage unavailable: memory only
  }
  for (const listener of volumeListeners) listener();
}
function subscribeVolume(listener: () => void) {
  volumeListeners.add(listener);
  return () => {
    volumeListeners.delete(listener);
  };
}

// Fades in when the page is first used (browsers allow sound only then) and,
// as the player is a new one, from the top after New Session; carries on
// through Start; fades out as soon as the song is ready. At the end of the
// track it fades out and comes back in from the top. The fades follow the
// clock, so a background tab's slower timers still finish them.
function WaitingMusic({ playing, volume }: { playing: boolean; volume: number }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const mix = useRef({ gain: 0, from: 0, to: 0, at: 0, ms: 1, volume, playing });
  const fadeTo = useCallback((to: number, ms: number) => {
    const m = mix.current;
    Object.assign(m, { from: m.gain, to, at: Date.now(), ms });
  }, []);
  // Plays on from where the track is, fading in
  const begin = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !mix.current.playing) return;
    audio.play().then(() => fadeTo(1, FADE_IN_MS), () => {});
  }, [fadeTo]);

  useEffect(() => {
    mix.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    mix.current.playing = playing;
    if (!playing) {
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

export default function MusicPlayer({
  currentSong,
  history,
  generationStatus,
  generationProgress = 0,
  onStarted,
  onSongEnd,
}: MusicPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const onStartedRef = useRef(onStarted);
  useEffect(() => {
    onStartedRef.current = onStarted;
  }, [onStarted]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const waitingVolume = useSyncExternalStore(subscribeVolume, readVolume, () => DEFAULT_VOLUME);

  useEffect(() => {
    if (currentSong && audioRef.current) {
      audioRef.current.src = currentSong.audioUrl;
      // Blocked sound still lets the display move on
      audioRef.current.play().catch(() => onStartedRef.current?.());
    }
  }, [currentSong]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-6">
      <WaitingMusic playing={!currentSong} volume={waitingVolume} />
      {/* Now playing */}
      <div className="rounded-2xl border border-border/60 bg-card shadow-sticker p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg font-bold">Now Playing</h3>
          {generationStatus && (
            <Badge variant="secondary" className="text-xs">
              {generationStatus}
            </Badge>
          )}
        </div>

        {currentSong ? (
          <>
            <div className="flex items-center gap-3">
              <span className="text-3xl">🎵</span>
              <div>
                <p className="font-medium">
                  Song #{currentSong.number} — {currentSong.style}
                </p>
                <p className="text-sm text-muted-foreground line-clamp-2">
                  {currentSong.prompt}
                </p>
              </div>
            </div>

            <audio
              ref={audioRef}
              onTimeUpdate={() =>
                setCurrentTime(audioRef.current?.currentTime || 0)
              }
              onLoadedMetadata={() =>
                setDuration(audioRef.current?.duration || 0)
              }
              onPlay={() => setIsPlaying(true)}
              onPlaying={() => onStartedRef.current?.()}
              onError={() => onStartedRef.current?.()}
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                setIsPlaying(false);
                onSongEnd?.();
              }}
            />

            <div className="space-y-2">
              <div className="relative h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="absolute h-full bg-primary rounded-full transition-all duration-300"
                  style={{
                    width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
                  }}
                />
              </div>
              <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <button
                className="text-sm font-medium text-primary hover:text-primary/80 transition"
                onClick={() => {
                  if (audioRef.current) {
                    isPlaying
                      ? audioRef.current.pause()
                      : audioRef.current.play();
                  }
                }}
              >
                {isPlaying ? "⏸ Pause" : "▶ Play"}
              </button>
            </div>

            <SendSongForm key={currentSong.taskId} taskId={currentSong.taskId} />
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {generationStatus || "No song yet. Connect rings and start a session."}
            </p>
            {generationProgress > 0 && generationProgress < 100 && (
              <div className="space-y-1.5">
                <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                  <div
                    className="absolute h-full bg-primary rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${generationProgress}%` }}
                  />
                </div>
                <div className="text-xs text-muted-foreground text-right tabular-nums">
                  {generationProgress}%
                </div>
              </div>
            )}
          </div>
        )}
        {/* The waiting music's volume, for this browser */}
        <div className="flex items-center gap-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
          <label htmlFor="waiting-volume" className="shrink-0">Waiting music</label>
          <input
            id="waiting-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={waitingVolume}
            onChange={(event) => saveVolume(Number(event.target.value))}
            className="h-1.5 w-full cursor-pointer"
            style={{ accentColor: "hsl(var(--primary))" }}
          />
          <span className="w-9 shrink-0 text-right tabular-nums">{Math.round(waitingVolume * 100)}%</span>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-card shadow-sticker-muted p-6 space-y-3">
          <h3 className="font-display font-bold text-sm">History</h3>
          {history.map((song, idx) => (
            <Card key={`${song.number}-${idx}`} className="bg-background">
              <CardContent className="p-3 flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium">Song #{song.number}</span>
                  <span className="text-muted-foreground"> — {song.style}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="text-xs font-medium text-primary hover:text-primary/80"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.src = song.audioUrl;
                        audioRef.current.play().catch(() => {});
                      }
                    }}
                  >
                    ▶ Play
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
