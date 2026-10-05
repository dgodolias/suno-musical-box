"use client";

import type { RefObject } from "react";
import { Progress } from "@/components/ui/progress";
import Waveform, { type LiveHeartRates } from "@/components/waveform";

interface SessionPanelProps {
  isActive: boolean;
  collectSeconds: number;
  windowSeconds: number;
  status: string;
  heartRatesRef: RefObject<LiveHeartRates>;
}

export default function SessionPanel({
  isActive,
  collectSeconds,
  windowSeconds,
  status,
  heartRatesRef,
}: SessionPanelProps) {
  const progress = Math.min(100, (collectSeconds / windowSeconds) * 100);

  if (!isActive) return null;

  return (
    <div className="space-y-4 rounded-2xl border border-border/60 bg-card shadow-sticker p-6">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold">Session</h3>
        <span className="text-sm text-muted-foreground">{status}</span>
      </div>

      <Waveform heartRatesRef={heartRatesRef} />

      <div className="space-y-1.5">
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>Initial music snapshot · recording continues until song ready or Stop</span>
          <span>
            {collectSeconds}s / {windowSeconds}s
          </span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>
    </div>
  );
}
