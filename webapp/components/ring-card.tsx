"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
}: RingCardProps) {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [data, setData] = useState<RingData>({
    heartRate: null,
    heartRateRaw: null,
    spo2: null,
    hrv: null,
    accelX: null,
    accelY: null,
    accelZ: null,
    rawPpg: null,
    signalQuality: "none",
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
      className={`transition-all duration-300 ${
        isConnected
          ? "border-emerald-500/50 shadow-lg shadow-emerald-500/10"
          : "border-zinc-800"
      }`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">{label}</CardTitle>
          <Badge
            variant={isConnected ? "default" : "secondary"}
            className={isConnected ? "bg-emerald-600 hover:bg-emerald-600" : ""}
          >
            {isConnected && (
              <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-300 animate-pulse" />
            )}
            {mockMode && "Mock"}
            {!mockMode && state === "disconnected" && "Disconnected"}
            {!mockMode && state === "scanning" && "Scanning..."}
            {!mockMode && state === "connecting" && "Connecting..."}
            {!mockMode && state === "connected" && "Connected"}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Size {size}
          {displayName && ` — ${displayName}`}
        </p>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {/* Metrics */}
          <div className="grid grid-cols-2 gap-2">
            <MetricBox
              icon="♥"
              label="HR"
              value={data.heartRate}
              unit="BPM"
              color="text-red-400"
            />
            <MetricBox
              icon="🫀"
              label="HRV"
              value={data.hrv}
              unit="ms"
              color="text-purple-400"
            />
          </div>
          {(data.spo2 !== null || data.rawPpg !== null || data.signalQuality) && (
            <div className="flex items-center justify-between text-xs text-muted-foreground font-mono">
              {data.spo2 !== null && <span>SpO2: {data.spo2}%</span>}
              {data.rawPpg !== null && <span>PPG: {data.rawPpg}</span>}
              {data.signalQuality && data.signalQuality !== "none" && (
                <span className={data.signalQuality === "good" ? "text-emerald-500" : "text-yellow-500"}>
                  Signal: {data.signalQuality}
                </span>
              )}
            </div>
          )}

          {/* Action button */}
          {mockMode ? (
            <div className="text-center text-xs text-zinc-500 py-1">
              Mock data active
            </div>
          ) : isConnected ? (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={handleDisconnect}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              className="w-full"
              onClick={handleScan}
              disabled={isLoading}
            >
              {isLoading ? "Searching..." : "Scan & Connect"}
            </Button>
          )}
        </div>
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
    <div className="rounded-lg bg-zinc-900/50 p-3 text-center">
      <div className={`text-2xl font-bold tabular-nums ${color}`}>
        {value !== null ? value : "--"}
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        {icon} {label} ({unit})
      </div>
    </div>
  );
}
