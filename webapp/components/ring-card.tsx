"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import GenrePicker from "@/components/genre-picker";
import { Bluetooth, HeartPulse, UserRound } from "lucide-react";
import {
  RingConnection,
  type ConnectionState,
  type RingData,
} from "@/lib/ble/ring-manager";

interface RingCardProps {
  personId: 1 | 2;
  label: string;
  size: string;
  onData?: (personId: 1 | 2, data: RingData) => void;
  onConnectionChange?: (personId: 1 | 2, connected: boolean) => void;
  connectionRef?: React.MutableRefObject<RingConnection | null>;
  mockMode?: boolean;
  mockData?: RingData | null;
  genre: string | null;
  onGenreChange: (genre: string | null) => void;
}

export default function RingCard({
  personId,
  label,
  size,
  onData,
  onConnectionChange,
  connectionRef,
  mockMode = false,
  mockData = null,
  genre,
  onGenreChange,
}: RingCardProps) {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [data, setData] = useState<RingData>({
    heartRate: null,
    spo2: null,
    accelX: null,
    accelY: null,
    accelZ: null,
    rawPpg: null,
    batteryLevel: null,
    isCharging: false,
    lastUpdate: 0,
  });
  const [name, setName] = useState<string>("");
  const ringRef = useRef<RingConnection | null>(null);
  const onDataRef = useRef(onData);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onDataRef.current = onData;
  onConnectionChangeRef.current = onConnectionChange;

  // Real BLE connection — only re-create when personId or mockMode changes
  useEffect(() => {
    if (mockMode) return;

    const ring = new RingConnection(personId);
    ring.onStateChange = (s) => {
      setState(s);
      if (s === "connected") setName(ring.name);
      onConnectionChangeRef.current?.(personId, s === "connected");
    };
    ring.onData = (d) => {
      setData(d);
      onDataRef.current?.(personId, d);
    };
    ringRef.current = ring;
    if (connectionRef) connectionRef.current = ring;

    return () => {
      ring.disconnect();
    };
  }, [personId, mockMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mock mode: reflect mock data into display
  useEffect(() => {
    if (mockMode && mockData) {
      setData(mockData);
    }
  }, [mockMode, mockData]);

  const handleScan = useCallback(() => {
    ringRef.current?.scan();
  }, []);

  const handleDisconnect = useCallback(() => {
    ringRef.current?.disconnect();
    setName("");
  }, []);

  const isConnected = mockMode || state === "connected";
  const isLoading = !mockMode && (state === "scanning" || state === "connecting");
  const displayName = mockMode ? `Mock_R02_P${personId}` : name;

  return (
    <Card
      className={`gap-5 transition-all duration-300 ${
        isConnected
          ? "rounded-2xl border border-primary/40 shadow-sticker ring-0"
          : "rounded-2xl border border-border/60 shadow-sticker-muted ring-0"
      }`}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* Sticker-style person tile, like the platform's persona steps */}
            <span
              className={`flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sticker-sm ${
                personId === 1 ? "-rotate-6" : "rotate-6"
              }`}
            >
              <UserRound className="size-5" strokeWidth={2.25} />
            </span>
            <div>
              <CardTitle className="font-display text-lg font-bold">{label}</CardTitle>
              <p className="text-sm text-muted-foreground">Wears the size {size} ring</p>
            </div>
          </div>
          <Badge
            variant="secondary"
            className={isConnected ? "bg-success/15 text-success" : ""}
          >
            {isConnected && (
              <span className="inline-block size-2 rounded-full bg-success animate-pulse" />
            )}
            {mockMode && "Mock"}
            {!mockMode && state === "disconnected" && "Not connected"}
            {!mockMode && state === "scanning" && "Scanning..."}
            {!mockMode && state === "connecting" && "Connecting..."}
            {!mockMode && state === "connected" && "Connected"}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Heart rate */}
        <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background px-4 py-3">
          <HeartPulse
            className={`size-8 shrink-0 ${data.heartRate !== null ? "text-primary" : "text-muted-foreground/40"}`}
            strokeWidth={1.75}
          />
          <div className="flex items-baseline gap-1.5">
            <span
              className={`font-display text-4xl font-bold tabular-nums ${
                data.heartRate !== null ? "text-foreground" : "text-muted-foreground/40"
              }`}
            >
              {data.heartRate !== null ? data.heartRate : "--"}
            </span>
            <span className="text-sm font-medium text-muted-foreground">BPM</span>
          </div>
          {data.batteryLevel !== null && (
            <span
              className={`ml-auto text-xs ${data.batteryLevel < 20 ? "text-destructive" : "text-muted-foreground"}`}
            >
              🔋 {data.batteryLevel}%{data.isCharging ? " ⚡" : ""}
            </span>
          )}
        </div>

        <GenrePicker value={genre} onChange={onGenreChange} />

        {/* Connection */}
        {mockMode ? (
          <p className="text-center text-xs text-muted-foreground">
            Mock data · {displayName}
          </p>
        ) : isConnected ? (
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs text-muted-foreground">{displayName}</span>
            <Button variant="ghost" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        ) : (
          <Button
            variant="3d-secondary"
            className="h-10 w-full"
            onClick={handleScan}
            disabled={isLoading}
          >
            <Bluetooth />
            {isLoading ? "Searching..." : "Connect ring"}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function MetricBox({
  icon,
  label,
  value,
  unit,
  color,
}: {
  icon: string;
  label: string;
  value: number | null;
  unit: string;
  color: string;
}) {
  return (
    <div className="rounded-lg bg-background p-3 text-center">
      <div className={`text-2xl font-bold tabular-nums ${color}`}>
        {value !== null ? value : "--"}
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {icon} {label} ({unit})
      </div>
    </div>
  );
}
