"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import RingCard from "@/components/ring-card";
import SessionPanel from "@/components/session-panel";
import MusicPlayer from "@/components/music-player";
import Image from "next/image";
import FloatingIcons from "@/components/floating-icons";
import ThemeToggle from "@/components/theme-toggle";
import type { LiveHeartRates } from "@/components/waveform";
import type { RingConnection, RingData } from "@/lib/ble/ring-manager";
import type { BiometricReading } from "@/lib/biometrics";
import { computeSnapshot } from "@/lib/biometrics";
import { buildPrompt } from "@/lib/prompt-builder";

const WINDOW_SEC = 30;
const UPLOAD_INTERVAL_MS = 5000;
const UPLOAD_RETRY_MS = 15000;
const UPLOAD_BATCH_SIZE = 1000;
const UPLOAD_TIMEOUT_MS = 15000;
const SUNO_DISABLED = process.env.NEXT_PUBLIC_SUNO_DISABLED === "true";
const SUNO_PAUSED_MESSAGE = "Music generation paused for ring tests";

interface CollectionWindow {
  sessionId: number;
  startedAt: number;
  endsAt: number;
  collecting: boolean;
}

interface PendingReadings {
  readings: BiometricReading[];
  retryAfter: number;
}

interface Song {
  taskId: string;
  audioUrl: string;
  style: string;
  prompt: string;
  number: number;
}

// --- Mock data generator (same logic as Python mock_collector) ---
function generateMockReading(personId: 1 | 2, t: number): BiometricReading {
  const noise = () => (Math.random() - 0.5) * 2;
  const eventSpike = Math.random() < 0.02 ? Math.random() * 20 : 0;

  let hr: number;
  let spo2: number;
  let hrv: number;
  if (personId === 1) {
    hr = 70 + 15 * Math.sin(t / 60) + noise() * 3 + eventSpike;
    spo2 = 97 + noise() * 0.8;
    hrv = 120 - 0.8 * (hr - 60) + noise() * 5;
  } else {
    const ownBase = 75 + 12 * Math.sin(t / 45 + 1.2);
    hr = 0.6 * (70 + 15 * Math.sin(t / 60)) + 0.4 * ownBase + noise() * 4 + eventSpike * 0.8;
    spo2 = 97.5 + noise() * 0.7;
    hrv = 110 - 0.7 * (hr - 60) + noise() * 6;
  }

  const movementScale = 0.1 + eventSpike / 30;
  return {
    personId,
    timestamp: Date.now(),
    heartRate: Math.round(Math.max(40, Math.min(200, hr))),
    spo2: Math.round(Math.max(70, Math.min(100, spo2))),
    temperature: null,
    hrv: Math.round(Math.max(15, Math.min(150, hrv))),
    rawPpg: Math.round(2000 + 500 * Math.sin(t * 0.1) + noise() * 50),
    accelX: noise() * movementScale,
    accelY: noise() * movementScale,
    accelZ: 1.0 + noise() * movementScale * 0.5,
  };
}

// Local testing without rings: open /?mock (ignored in production builds)
const noopSubscribe = () => () => {};
const readMockFlag = () =>
  process.env.NODE_ENV !== "production" && new URLSearchParams(window.location.search).has("mock");

export default function Home() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [collectSeconds, setCollectSeconds] = useState(0);
  const [generationStatus, setGenerationStatus] = useState("");
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [history, setHistory] = useState<Song[]>([]);
  const [songCount, setSongCount] = useState(0);
  const [generationProgress, setGenerationProgress] = useState(0);
  const generatingRef = useRef(false);
  const generationRunRef = useRef(0);
  const [ring1Connected, setRing1Connected] = useState(false);
  const [ring2Connected, setRing2Connected] = useState(false);
  const mockMode = useSyncExternalStore(noopSubscribe, readMockFlag, () => false);
  const [mockRing1Data, setMockRing1Data] = useState<RingData | null>(null);
  const [mockRing2Data, setMockRing2Data] = useState<RingData | null>(null);
  const [genre1, setGenre1] = useState<string | null>(null);
  const [genre2, setGenre2] = useState<string | null>(null);

  const ring1Ref = useRef<RingConnection | null>(null);
  const ring2Ref = useRef<RingConnection | null>(null);
  const readingsRef = useRef<BiometricReading[]>([]);
  const collectionRef = useRef<CollectionWindow | null>(null);
  const pendingReadingsRef = useRef(new Map<number, PendingReadings>());
  const uploadingRef = useRef(false);
  const startingSessionRef = useRef(false);
  // Latest heart rate per person; the session waveform reads it every frame
  const liveHrRef = useRef<LiveHeartRates>([null, null]);
  const collectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mockTickRef = useRef(0);

  const anyConnected = mockMode || ring1Connected || ring2Connected;

  const recordReading = useCallback((reading: BiometricReading) => {
    liveHrRef.current[reading.personId - 1] = reading.heartRate;
    const collection = collectionRef.current;
    if (
      !collection?.collecting ||
      reading.timestamp < collection.startedAt ||
      reading.timestamp > collection.endsAt
    ) return;

    readingsRef.current.push(reading);
    let pending = pendingReadingsRef.current.get(collection.sessionId);
    if (!pending) {
      pending = { readings: [], retryAfter: 0 };
      pendingReadingsRef.current.set(collection.sessionId, pending);
    }
    pending.readings.push(reading);
  }, []);

  const addReading = useCallback(
    (personId: 1 | 2, data: RingData) => {
      if (data.heartRate === null) return;
      recordReading({
        personId,
        timestamp: data.lastUpdate,
        heartRate: data.heartRate,
        spo2: data.spo2,
        temperature: null,
        hrv: null,
        rawPpg: data.rawPpg,
        accelX: data.accelX,
        accelY: data.accelY,
        accelZ: data.accelZ,
      });
    },
    [recordReading]
  );

  const handleConnectionChange = useCallback((personId: 1 | 2, connected: boolean) => {
    if (personId === 1) setRing1Connected(connected);
    else setRing2Connected(connected);
    // A ring that is not connected stops driving the waveform
    if (!connected) liveHrRef.current[personId - 1] = null;
  }, []);

  const sendReadingsToApi = useCallback(async () => {
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      for (const [pendingSessionId, pending] of pendingReadingsRef.current) {
        if (pending.retryAfter > Date.now()) continue;
        const batch = pending.readings.slice(0, UPLOAD_BATCH_SIZE);
        if (batch.length === 0) continue;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
        try {
          const response = await fetch("/api/readings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: pendingSessionId, readings: batch }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Readings upload failed (${response.status})`);
          pending.readings.splice(0, batch.length);
          if (pending.readings.length === 0) pendingReadingsRef.current.delete(pendingSessionId);
        } catch (err) {
          pending.retryAfter = Date.now() + UPLOAD_RETRY_MS;
          console.error("Failed to send readings:", err);
        } finally {
          clearTimeout(timeout);
        }
      }
    } finally {
      uploadingRef.current = false;
    }
  }, []);

  // Retries also run after collection ends; failed observations keep their session.
  useEffect(() => {
    const timer = setInterval(() => void sendReadingsToApi(), UPLOAD_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sendReadingsToApi]);

  const pollForSong = useCallback(
    async (taskId: string, songNumber: number, prompt: string, style: string, generationRun: number) => {
      if (SUNO_DISABLED || generationRunRef.current !== generationRun) return;
      setGenerationStatus("Generating music...");
      setGenerationProgress(0);

      // Progress animation: smooth to ~90% over 120s, then slow crawl
      const startTime = Date.now();
      const progressInterval = setInterval(() => {
        if (generationRunRef.current !== generationRun) {
          clearInterval(progressInterval);
          return;
        }
        const elapsed = (Date.now() - startTime) / 1000;
        let progress: number;

        if (elapsed <= 108) {
          // 0-90% over first 108 seconds (linear)
          progress = (elapsed / 108) * 90;
        } else {
          // 90-99% asymptotic slowdown: each extra 1% takes longer
          // Never reaches 100% on its own
          const extra = elapsed - 108;
          progress = 90 + (9 * extra) / (extra + 30);
        }

        setGenerationProgress(Math.min(99, Math.round(progress)));
      }, 500);

      // Poll Suno for actual completion
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        if (generationRunRef.current !== generationRun) {
          clearInterval(progressInterval);
          return;
        }
        try {
          const res = await fetch(`/api/generate/${taskId}`);
          if (res.status === 423) {
            clearInterval(progressInterval);
            if (generationRunRef.current === generationRun) {
              generatingRef.current = false;
              setGenerationProgress(0);
              setGenerationStatus(SUNO_PAUSED_MESSAGE);
              setIsActive(false);
            }
            return;
          }
          const data = await res.json();
          if (generationRunRef.current !== generationRun) {
            clearInterval(progressInterval);
            return;
          }

          if (data.status === "ready" && data.audioUrl) {
            clearInterval(progressInterval);
            setGenerationProgress(100);
            const song: Song = {
              taskId,
              audioUrl: data.audioUrl,
              style,
              prompt,
              number: songNumber,
            };
            setCurrentSong((prev) => {
              if (prev) setHistory((h) => [prev, ...h]);
              return song;
            });
            setGenerationStatus("");
            setIsActive(false);
            return;
          }
        } catch (err) {
          if (generationRunRef.current !== generationRun) {
            clearInterval(progressInterval);
            return;
          }
          console.error("Poll error:", err);
        }
      }

      clearInterval(progressInterval);
      if (generationRunRef.current !== generationRun) return;
      setGenerationProgress(0);
      setGenerationStatus("Generation timed out");
    },
    []
  );

  const generateSong = useCallback(async () => {
    if (SUNO_DISABLED) {
      generatingRef.current = false;
      setGenerationProgress(0);
      setGenerationStatus(SUNO_PAUSED_MESSAGE);
      setIsActive(false);
      return;
    }
    // Prevent double generation
    if (generatingRef.current) return;
    generatingRef.current = true;
    const generationRun = generationRunRef.current;

    const collection = collectionRef.current;
    const readings = readingsRef.current.filter((reading) =>
      collection &&
      reading.timestamp >= collection.startedAt &&
      reading.timestamp <= collection.endsAt
    );
    const p1 = readings.filter((r) => r.personId === 1);
    const p2 = readings.filter((r) => r.personId === 2);

    // Ring data is only logged; the song comes from the genres alone
    const snap = p1.length >= 5 && p2.length >= 5 ? computeSnapshot(p1, p2) : null;

    const { prompt, style } = buildPrompt(genre1, genre2);
    setGenerationStatus("Submitting to Suno...");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, prompt, style, snapshot: snap }),
      });
      if (res.status === 423) {
        if (generationRunRef.current === generationRun) {
          generatingRef.current = false;
          setGenerationProgress(0);
          setGenerationStatus(SUNO_PAUSED_MESSAGE);
          setIsActive(false);
        }
        return;
      }
      const data = await res.json();
      if (generationRunRef.current !== generationRun) return;

      if (data.taskId) {
        const num = songCount + 1;
        setSongCount(num);
        void pollForSong(data.taskId, num, prompt, style, generationRun);
      } else {
        setGenerationStatus("Suno error: " + JSON.stringify(data));
      }
    } catch (err) {
      if (generationRunRef.current !== generationRun) return;
      setGenerationStatus("API error: " + String(err));
    }
  }, [sessionId, songCount, pollForSong, genre1, genre2]);

  const startSession = useCallback(async () => {
    if (startingSessionRef.current) return;
    startingSessionRef.current = true;
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: mockMode ? "Mock web session" : "Web session" }),
      });
      if (!res.ok) throw new Error(`Session creation failed (${res.status})`);
      const data = await res.json();
      if (!Number.isSafeInteger(data.sessionId) || data.sessionId <= 0) {
        throw new Error("Invalid session ID");
      }
      generationRunRef.current += 1;
      const startedAt = Date.now();
      collectionRef.current = {
        sessionId: data.sessionId,
        startedAt,
        endsAt: startedAt + WINDOW_SEC * 1000,
        collecting: true,
      };
      readingsRef.current = [];
      setSessionId(data.sessionId);
      setIsActive(true);
      setCollectSeconds(0);
      generatingRef.current = false;
      mockTickRef.current = 0;
      // BLE stays streaming; only the session's observation window resets.
      setGenerationStatus("Collecting biometric data...");
    } catch (err) {
      console.error("Failed to start session:", err);
    } finally {
      startingSessionRef.current = false;
    }
  }, [mockMode]);

  const stopSession = useCallback(async () => {
    const stoppedRun = ++generationRunRef.current;
    if (collectionRef.current) collectionRef.current.collecting = false;
    setIsActive(false);
    if (collectIntervalRef.current) {
      clearInterval(collectIntervalRef.current);
      collectIntervalRef.current = null;
    }
    await sendReadingsToApi();
    if (sessionId) {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", sessionId }),
      });
    }
    if (generationRunRef.current === stoppedRun) setGenerationStatus("");
  }, [sessionId, sendReadingsToApi]);

  // Collection tick (1Hz)
  useEffect(() => {
    if (!isActive || !collectionRef.current?.collecting) return;

    collectIntervalRef.current = setInterval(() => {
      mockTickRef.current += 1;
      const t = mockTickRef.current;

      // Generate mock data if in mock mode
      if (mockMode) {
        const r1 = generateMockReading(1, t);
        const r2 = generateMockReading(2, t);
        recordReading(r1);
        recordReading(r2);

        setMockRing1Data({
          heartRate: r1.heartRate,
          spo2: r1.spo2,
          accelX: r1.accelX,
          accelY: r1.accelY,
          accelZ: r1.accelZ,
          rawPpg: r1.rawPpg,
          batteryLevel: 85,
          isCharging: false,
          lastUpdate: r1.timestamp,
        });
        setMockRing2Data({
          heartRate: r2.heartRate,
          spo2: r2.spo2,
          accelX: r2.accelX,
          accelY: r2.accelY,
          accelZ: r2.accelZ,
          rawPpg: r2.rawPpg,
          batteryLevel: 72,
          isCharging: false,
          lastUpdate: r2.timestamp,
        });
      }

      // Skip if already generating
      if (generatingRef.current) return;

      const collection = collectionRef.current;
      if (!collection?.collecting) return;
      const elapsed = Math.floor((Date.now() - collection.startedAt) / 1000);
      setCollectSeconds(Math.min(elapsed, WINDOW_SEC));

      // Keep network effects outside React state updaters (which may be replayed).
      if (Date.now() >= collection.endsAt) {
        collection.collecting = false;
        if (collectIntervalRef.current) {
          clearInterval(collectIntervalRef.current);
          collectIntervalRef.current = null;
        }
        void sendReadingsToApi();
        void generateSong();
      }
    }, 1000);

    return () => {
      if (collectIntervalRef.current) {
        clearInterval(collectIntervalRef.current);
      }
    };
  }, [isActive, mockMode, sendReadingsToApi, generateSong, recordReading]);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <FloatingIcons />
      <div className="relative mx-auto max-w-2xl px-4 py-10 space-y-8">
        {/* Brand bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {/* Same as educoach-platform's <Logo showIcon />: logo-v3 + text wordmark */}
            <Image src="/brand/logo.png" alt="" width={36} height={36} priority className="rounded-lg" />
            <span className="font-display text-2xl font-bold tracking-tight">
              Edu<span className="text-primary">Coach</span>
            </span>
          </div>
          <ThemeToggle />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">Musical Box</h1>
            <p className="text-sm text-muted-foreground">
              Biometric-driven music generation
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!isActive ? (
              <Button
                onClick={startSession}
                variant="3d-primary"
                size="lg"
                className="h-12 px-7 text-base"
                disabled={!anyConnected}
                title={!anyConnected ? "Connect at least one ring" : ""}
              >
                Start Session
              </Button>
            ) : (
              <Button onClick={stopSession} variant="destructive" size="lg" className="h-12 rounded-2xl px-7 text-base font-bold uppercase tracking-widest">
                Stop
              </Button>
            )}
          </div>
        </div>

        {SUNO_DISABLED && (
          <div role="status" className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm font-medium">
            {SUNO_PAUSED_MESSAGE}
          </div>
        )}

        {/* Ring cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <RingCard
            personId={1}
            label="Person 1"
            size="9"
            onData={addReading}
            onConnectionChange={handleConnectionChange}
            connectionRef={ring1Ref}
            mockMode={mockMode}
            mockData={mockRing1Data}
            genre={genre1}
            onGenreChange={setGenre1}
          />
          <RingCard
            personId={2}
            label="Person 2"
            size="11"
            onData={addReading}
            onConnectionChange={handleConnectionChange}
            connectionRef={ring2Ref}
            mockMode={mockMode}
            mockData={mockRing2Data}
            genre={genre2}
            onGenreChange={setGenre2}
          />
        </div>

        {/* Session panel */}
        <SessionPanel
          isActive={isActive}
          collectSeconds={Math.min(collectSeconds, WINDOW_SEC)}
          windowSeconds={WINDOW_SEC}
          status={generationStatus || (isActive ? "Collecting..." : "")}
          heartRatesRef={liveHrRef}
        />

        {/* Music player */}
        <MusicPlayer
          currentSong={currentSong}
          history={history}
          generationStatus={generationStatus}
          generationProgress={generationProgress}
          onSongEnd={() => {}}
        />

        {/* Footer */}
        <p className="text-center text-xs text-muted-foreground">
          Requires Chrome/Edge with Bluetooth. Colmi R02 rings.
        </p>
      </div>
    </div>
  );
}
