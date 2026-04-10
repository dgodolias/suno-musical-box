"use client";

import { Progress } from "@/components/ui/progress";
import { type BiometricSnapshot } from "@/lib/biometrics";

interface SessionPanelProps {
  isActive: boolean;
  collectSeconds: number;
  windowSeconds: number;
  snapshot: BiometricSnapshot | null;
  status: string;
}

export default function SessionPanel({
  isActive,
  collectSeconds,
  windowSeconds,
  snapshot,
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

      {snapshot && (
        <div className="grid grid-cols-4 gap-3 text-center">
          <MiniStat label="Arousal" value={snapshot.combinedArousal} />
          <MiniStat label="Valence" value={snapshot.combinedValence} />
          <MiniStat label="Sync" value={snapshot.synchronyScore} />
          <MiniStat label="Movement" value={snapshot.movementIntensity} />
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div>
      <div className="text-lg font-bold tabular-nums">{pct}%</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
