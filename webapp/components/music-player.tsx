"use client";

import { useRef, useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Song {
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
  onSongEnd?: () => void;
}

export default function MusicPlayer({
  currentSong,
  history,
  generationStatus,
  generationProgress = 0,
  onSongEnd,
}: MusicPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (currentSong && audioRef.current) {
      audioRef.current.src = currentSong.audioUrl;
      audioRef.current.play().catch(() => {});
    }
  }, [currentSong]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-4">
      {/* Now playing */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Now Playing</h3>
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
              onPause={() => setIsPlaying(false)}
              onEnded={() => {
                setIsPlaying(false);
                onSongEnd?.();
              }}
            />

            <div className="space-y-2">
              <div className="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="absolute h-full bg-emerald-500 rounded-full transition-all duration-300"
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
                className="text-sm text-muted-foreground hover:text-white transition"
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
              <a
                href={currentSong.audioUrl}
                download={`musical-box-${currentSong.number}.mp3`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-emerald-400 hover:text-emerald-300 transition"
              >
                ⬇ Download
              </a>
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              {generationStatus || "No song yet. Connect rings and start a session."}
            </p>
            {generationProgress > 0 && generationProgress < 100 && (
              <div className="space-y-1.5">
                <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="absolute h-full bg-emerald-500 rounded-full transition-all duration-500 ease-out"
                    style={{ width: `${generationProgress}%` }}
                  />
                </div>
                <div className="text-xs text-zinc-500 text-right tabular-nums">
                  {generationProgress}%
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-5 space-y-3">
          <h3 className="font-semibold text-sm">History</h3>
          {history.map((song, idx) => (
            <Card key={`${song.number}-${idx}`} className="bg-zinc-900/50 border-zinc-800">
              <CardContent className="p-3 flex items-center justify-between">
                <div className="text-sm">
                  <span className="font-medium">Song #{song.number}</span>
                  <span className="text-muted-foreground"> — {song.style}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="text-xs text-emerald-400 hover:text-emerald-300"
                    onClick={() => {
                      if (audioRef.current) {
                        audioRef.current.src = song.audioUrl;
                        audioRef.current.play().catch(() => {});
                      }
                    }}
                  >
                    ▶ Play
                  </button>
                  <a
                    href={song.audioUrl}
                    download={`musical-box-${song.number}.mp3`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-zinc-500 hover:text-zinc-300"
                  >
                    ⬇
                  </a>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
