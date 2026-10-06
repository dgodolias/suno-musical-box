"use client";

import { useRef, useState, useEffect } from "react";
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
  waiting?: boolean; // the song is on its way, after the recording window
  onStarted?: () => void; // the song has started playing, or cannot
  onSongEnd?: () => void;
}

// Quiet music on a loop while the song is on its way, from public/; none until
// one of the three Suno takes is chosen
const WAITING_MUSIC: string | null = null;
const WAITING_VOLUME = 0.25;
const FADE_MS = 1500;

// Fades in while `playing`, and out (then pauses) as the song takes over. The
// fade follows the clock, so a background tab's slow timers still finish it.
function WaitingMusic({ src, playing }: { src: string; playing: boolean }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || (!playing && audio.paused)) return;
    if (playing && audio.paused) {
      audio.volume = 0;
      audio.play().catch(() => {});
    }
    const from = audio.volume;
    const to = playing ? WAITING_VOLUME : 0;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const t = Math.min(1, (Date.now() - startedAt) / FADE_MS);
      audio.volume = from + (to - from) * t;
      if (t < 1) return;
      clearInterval(timer);
      if (!playing) audio.pause();
    }, 50);
    return () => clearInterval(timer);
  }, [playing]);
  return <audio ref={audioRef} src={src} loop preload="auto" />;
}

export default function MusicPlayer({
  currentSong,
  history,
  generationStatus,
  generationProgress = 0,
  waiting = false,
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
      {WAITING_MUSIC && <WaitingMusic src={WAITING_MUSIC} playing={waiting} />}
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
