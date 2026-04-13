"use client";

import { Progress } from "@/components/ui/progress";

interface SessionPanelProps {
  isActive: boolean;
  collectSeconds: number;
  windowSeconds: number;
  status: string;
}

export default function SessionPanel({
  isActive,
  collectSeconds,
  windowSeconds,
  status,
}: SessionPanelProps) {
  const progress = Math.min(100, (collectSeconds / windowSeconds) * 100);

  if (!isActive) return null;

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-5">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Session</h3>
        <span className="text-sm text-muted-foreground">{status}</span>
      </div>

      <div className="space-y-1.5">
        <div className="flex justify-between text-sm text-muted-foreground">
          <span>Collecting biometric data</span>
          <span>
            {collectSeconds}s / {windowSeconds}s
          </span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>
    </div>
  );
}
