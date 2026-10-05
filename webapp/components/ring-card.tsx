"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import GenrePicker from "@/components/genre-picker";
import { Bluetooth, HeartPulse, UserRound } from "lucide-react";
import { HR_STALE_MS, RingConnection } from "@/lib/ble/ring-manager";
import type { ConnectionState, HeartRateMode, RingData, RingDiagnostics } from "@/lib/ble/ring-manager";

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
  const [diagnostics, setDiagnostics] = useState<RingDiagnostics | null>(null);
  const [now, setNow] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [opticalActionPending, setOpticalActionPending] = useState(false);
  const [measurementMode, setMeasurementMode] = useState<HeartRateMode>("standard");
  const [diagnosticMessage, setDiagnosticMessage] = useState("");
  const [diagnosticReport, setDiagnosticReport] = useState("");
  const ringRef = useRef<RingConnection | null>(null);
  const onDataRef = useRef(onData);
  const onConnectionChangeRef = useRef(onConnectionChange);

  useEffect(() => {
    onDataRef.current = onData;
    onConnectionChangeRef.current = onConnectionChange;
  }, [onData, onConnectionChange]);

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
    };
    // Only a new HR notification becomes a recorded observation. Battery and
    // connection updates may contain the previous HR in the display snapshot.
    ring.onHeartRate = (d) => {
      onDataRef.current?.(personId, d);
    };
    ring.onDiagnostics = (nextDiagnostics) => {
      setDiagnostics(nextDiagnostics);
      setMeasurementMode(ring.heartRateMode);
    };
    ringRef.current = ring;
    if (connectionRef) connectionRef.current = ring;

    return () => {
      ring.onStateChange = () => {};
      ring.onData = () => {};
      ring.onHeartRate = () => {};
      ring.onDiagnostics = () => {};
      if (connectionRef?.current === ring) connectionRef.current = null;
      void ring.disconnect();
    };
  }, [personId, mockMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Advance the age even when the ring has stopped sending notifications.
  useEffect(() => {
    if (state !== "connected" || mockMode) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void ringRef.current?.refreshBattery();
    }, 1000);
    return () => clearInterval(timer);
  }, [state, mockMode]);

  const handleScan = useCallback(() => {
    ringRef.current?.scan();
  }, []);

  const handleDisconnect = useCallback(() => {
    void ringRef.current?.disconnect();
    setName("");
  }, []);

  const handleRetry = async () => {
    setRetrying(true);
    setDiagnosticMessage("");
    try {
      await ringRef.current?.retryMeasurement();
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : "Could not restart measurement.");
    } finally {
      setRetrying(false);
    }
  };

  const copyDiagnostics = async () => {
    const report = ringRef.current?.getDebugReport();
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report);
      setDiagnosticReport("");
      setDiagnosticMessage("Diagnostics copied.");
    } catch {
      setDiagnosticReport(report);
      setDiagnosticMessage("Select and copy the report below.");
    }
  };

  const runOpticalDiagnostic = async (duration: 15000 | 30000) => {
    setOpticalActionPending(true);
    setDiagnosticMessage("");
    setDiagnosticReport("");
    try {
      await ringRef.current?.startOpticalDiagnostic(duration);
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : "Could not start optical diagnostic.");
    } finally {
      setOpticalActionPending(false);
    }
  };

  const stopOpticalDiagnostic = async () => {
    setOpticalActionPending(true);
    setDiagnosticMessage("");
    try {
      await ringRef.current?.stopOpticalDiagnostic();
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : "Could not stop optical diagnostic.");
    } finally {
      setOpticalActionPending(false);
    }
  };

  const changeMeasurementMode = async (value: string) => {
    if (value !== "standard" && value !== "legacy" && value !== "realtime") return;
    setRetrying(true);
    setDiagnosticMessage("");
    try {
      await ringRef.current?.setHeartRateMode(value);
      setMeasurementMode(value);
    } catch (error) {
      setDiagnosticMessage(error instanceof Error ? error.message : "Could not change measurement protocol.");
    } finally {
      setRetrying(false);
    }
  };

  const isConnected = mockMode || state === "connected";
  const isLoading = !mockMode && (state === "scanning" || state === "connecting");
  const displayName = mockMode ? `Mock_R02_P${personId}` : name;
  const displayData = mockMode && mockData ? mockData : data;
  const lastHeartRateAt = diagnostics?.lastHeartRateAt ?? 0;
  const secondsSinceReading = lastHeartRateAt > 0
    ? Math.max(0, Math.floor((now - lastHeartRateAt) / 1000))
    : null;
  const fresh = mockMode || (
    isConnected && diagnostics?.measurementState === "measuring" &&
    secondsSinceReading !== null && secondsSinceReading * 1000 < HR_STALE_MS
  );
  const waitingForContact = !mockMode && diagnostics?.measurementState === "waiting-for-contact";
  const opticalActive = !mockMode && (
    diagnostics?.opticalState === "preparing" || diagnostics?.opticalState === "capturing" ||
    diagnostics?.opticalState === "stopping"
  );
  const measurementPaused = !mockMode && diagnostics?.measurementState === "paused";
  const heartRate = isConnected && !waitingForContact && !opticalActive && !measurementPaused
    ? displayData.heartRate
    : null;
  const opticalSecondsRemaining = Math.max(0, Math.ceil(((diagnostics?.opticalEndsAt ?? 0) - now) / 1000));
  const opticalDisabled = diagnostics?.hardware === "RT02R_V3.1";
  const batteryAge = diagnostics?.lastBatteryAt
    ? Math.max(0, Math.floor((now - diagnostics.lastBatteryAt) / 1000))
    : null;
  const batteryAgeLabel = batteryAge === null ? "not read" : batteryAge < 60
    ? `${batteryAge}s ago` : `${Math.floor(batteryAge / 60)}m ago`;

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
            className={`size-8 shrink-0 ${heartRate !== null && fresh ? "text-primary" : "text-muted-foreground/40"}`}
            strokeWidth={1.75}
          />
          <div className="flex items-baseline gap-1.5">
            <span
              className={`font-display text-4xl font-bold tabular-nums ${
                heartRate !== null && fresh ? "text-foreground" : "text-muted-foreground/40"
              }`}
            >
              {heartRate ?? "--"}
            </span>
            <span className="text-sm font-medium text-muted-foreground">BPM</span>
          </div>
          {isConnected && displayData.batteryLevel !== null && (
            <span
              className={`ml-auto text-xs ${displayData.batteryLevel < 20 ? "text-destructive" : "text-muted-foreground"}`}
            >
              🔋 {displayData.batteryLevel}%{displayData.isCharging ? " ⚡" : ""}
              {!mockMode && <span className="block text-right text-[10px]">Read {batteryAgeLabel}</span>}
            </span>
          )}
        </div>

        {!mockMode && isConnected && (
          <div className="-mt-2 space-y-1 text-xs text-muted-foreground">
            <p>
              {opticalActive
                ? diagnostics?.opticalState === "stopping"
                  ? "Optical test · checking that the sensor stopped"
                  : "Optical test · heart-rate recording paused"
                : measurementPaused
                  ? "Measurement paused · choose Retry measurement to resume"
                  : waitingForContact
                    ? "Put the ring back on · measurements resume automatically"
                    : diagnostics?.measurementState === "error"
                      ? "Measurement needs attention · see diagnostics below"
                      : diagnostics?.measurementState === "warming-up" || secondsSinceReading === null
                        ? "Warming up · keep the ring still against your skin"
                        : fresh
                          ? `Receiving · last measurement ${secondsSinceReading}s ago`
                          : `Last reading · no new measurement for ${secondsSinceReading}s`}
            </p>
            <p className="tabular-nums" data-testid={`ring-${personId}-sample-count`}>
              {diagnostics?.heartRateSamples ?? 0} real measurements received
            </p>
          </div>
        )}

        {!mockMode && diagnostics?.lastError && (
          <p role="status" className="text-xs text-destructive">{diagnostics.lastError}</p>
        )}

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

        {!mockMode && diagnostics && (
          <details className="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer font-medium">Measurement diagnostics</summary>
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 break-words">
              <dt>Sensor state</dt><dd>{diagnostics.measurementState}</dd>
              <dt>Firmware</dt><dd>{diagnostics.firmware ?? "Not reported"}</dd>
              <dt>Hardware</dt><dd>{diagnostics.hardware ?? "Not reported"}</dd>
              <dt>Bluetooth packets</dt><dd>{diagnostics.packetsReceived}</dd>
              <dt>Start / continue</dt><dd>{diagnostics.startsSent} / {diagnostics.continuesSent}</dd>
              <dt>Recovery attempts</dt><dd>{diagnostics.restartCount}</dd>
              <dt>Battery last read</dt><dd>{batteryAgeLabel}</dd>
            </dl>
            <label className="mt-3 block space-y-1" htmlFor={`ring-${personId}-hr-mode`}>
              <span>Measurement protocol</span>
              <select
                id={`ring-${personId}-hr-mode`}
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-foreground"
                value={measurementMode}
                disabled={retrying || opticalActionPending || opticalActive || !isConnected}
                onChange={(event) => void changeMeasurementMode(event.target.value)}
              >
                <option value="standard">Standard</option>
                <option value="legacy">Legacy R02 (compatibility test)</option>
                <option value="realtime">Realtime HR (continuous)</option>
              </select>
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={copyDiagnostics}>Copy diagnostics</Button>
              <Button variant="ghost" size="sm" onClick={() => setDiagnosticReport(ringRef.current?.getDebugReport() ?? "")}>
                Show report
              </Button>
              {isConnected && <Button variant="ghost" size="sm" disabled={opticalActive || opticalActionPending} onClick={() => void ringRef.current?.refreshBattery(true)}>
                Refresh battery
              </Button>}
              {isConnected && (
                <Button variant="ghost" size="sm" onClick={handleRetry} disabled={retrying || opticalActionPending || opticalActive}>
                  {retrying ? "Restarting..." : "Retry measurement"}
                </Button>
              )}
            </div>
            {isConnected && (
              <div className="mt-3 space-y-2 rounded border border-border/60 p-3">
                <p className="font-medium">Optical diagnostic</p>
                <p>Short sensor capture. Packet collection ends automatically; check that the ring lights switch off. Resume heart rate with Retry measurement.</p>
                {opticalDisabled && <p>Disabled for this ring: sensor lights remained on after STOP and disconnect.</p>}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={opticalDisabled || retrying || opticalActionPending || opticalActive} onClick={() => void runOpticalDiagnostic(15000)}>
                    Optical test 15s
                  </Button>
                  <Button variant="ghost" size="sm" disabled={opticalDisabled || retrying || opticalActionPending || opticalActive} onClick={() => void runOpticalDiagnostic(30000)}>
                    Optical test 30s
                  </Button>
                  {opticalActive && (
                    <Button variant="ghost" size="sm" disabled={opticalActionPending || diagnostics.opticalState === "stopping"} onClick={() => void stopOpticalDiagnostic()}>
                      Stop optical test
                    </Button>
                  )}
                </div>
                {diagnostics.opticalState !== "idle" && (
                  <p role="status" className="tabular-nums">
                    {diagnostics.opticalState} · {diagnostics.opticalFramesReceived} raw packets
                    {opticalActive && opticalSecondsRemaining > 0 ? ` · ${opticalSecondsRemaining}s remaining` : ""}
                  </p>
                )}
              </div>
            )}
            {diagnosticMessage && <p role="status" className="mt-2">{diagnosticMessage}</p>}
            {diagnostics.batteryError && <p role="status" className="mt-2">{diagnostics.batteryError}</p>}
            {diagnosticReport && (
              <textarea
                aria-label="Measurement diagnostic report"
                readOnly
                value={diagnosticReport}
                onFocus={(event) => event.currentTarget.select()}
                className="mt-2 h-32 w-full rounded border border-border bg-background p-2 font-mono text-xs"
              />
            )}
          </details>
        )}
      </CardContent>
    </Card>
  );
}
