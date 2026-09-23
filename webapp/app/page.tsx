"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import RingCard from "@/components/ring-card";
import SessionPanel from "@/components/session-panel";
import MusicPlayer from "@/components/music-player";
import Image from "next/image";
import FloatingIcons from "@/components/floating-icons";
import ThemeToggle from "@/components/theme-toggle";
import { type RingData, RingConnection } from "@/lib/ble/ring-manager";
import {
  type BiometricReading,

  computeSnapshot,
} from "@/lib/biometrics";
import { buildPrompt } from "@/lib/prompt-builder";

const WINDOW_SEC = 30;

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
  const collectIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mockTickRef = useRef(0);

  // When mock mode toggles, set both rings as connected/disconnected
  useEffect(() => {
    if (mockMode) {
      setRing1Connected(true);
      setRing2Connected(true);
    } else {
      setRing1Connected(false);
      setRing2Connected(false);
      setMockRing1Data(null);
      setMockRing2Data(null);
    }
  }, [mockMode]);

  const anyConnected = ring1Connected || ring2Connected;

  const addReading = useCallback(
    (personId: 1 | 2, data: RingData) => {
      // Always store readings (even before session starts)
      // so we have data ready when generation triggers
      if (data.heartRate === null) return; // skip empty readings
      readingsRef.current.push({
        personId,
        timestamp: Date.now(),
        heartRate: data.heartRate,
        spo2: data.spo2,
        temperature: null,
        hrv: null,
        rawPpg: data.rawPpg,
        accelX: data.accelX,
        accelY: data.accelY,
        accelZ: data.accelZ,
      });
      // Keep buffer bounded (last 300 readings)
      if (readingsRef.current.length > 300) {
        readingsRef.current = readingsRef.current.slice(-200);
      }
    },
    []
  );

  const sendReadingsToApi = useCallback(
    async (readings: BiometricReading[]) => {
      if (!sessionId || readings.length === 0) return;
      try {
        await fetch("/api/readings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            readings: readings.map((r) => ({
              personId: r.personId,
              heartRate: r.heartRate,
              spo2: r.spo2,
              temperature: r.temperature,
              hrv: r.hrv,
              rawPpg: r.rawPpg,
              accelX: r.accelX,
              accelY: r.accelY,
              accelZ: r.accelZ,
            })),
          }),
        });
      } catch (err) {
        console.error("Failed to send readings:", err);
      }
    },
    [sessionId]
  );

  const pollForSong = useCallback(
    async (taskId: string, songNumber: number, prompt: string, style: string) => {
      setGenerationStatus("Generating music...");
      setGenerationProgress(0);

      // Progress animation: smooth to ~90% over 120s, then slow crawl
      const startTime = Date.now();
      const progressInterval = setInterval(() => {
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
        try {
          const res = await fetch(`/api/generate/${taskId}`);
          const data = await res.json();

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
          console.error("Poll error:", err);
        }
      }

      clearInterval(progressInterval);
      setGenerationProgress(0);
      setGenerationStatus("Generation timed out");
    },
    []
  );

  const generateSong = useCallback(async () => {
    // Prevent double generation
    if (generatingRef.current) return;
    generatingRef.current = true;

    const readings = readingsRef.current;
    let p1 = readings.filter((r) => r.personId === 1);
    let p2 = readings.filter((r) => r.personId === 2);

    // If only 1 ring connected, duplicate its data for both persons
    if (p1.length < 5 && p2.length >= 5) p1 = p2;
    if (p2.length < 5 && p1.length >= 5) p2 = p1;

    // Ring data is only logged; the song comes from the genres alone
    const snap = p1.length >= 5 ? computeSnapshot(p1, p2) : null;

    const { prompt, style } = buildPrompt(genre1, genre2);
    setGenerationStatus("Submitting to Suno...");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, prompt, style, snapshot: snap }),
      });
      const data = await res.json();

      if (data.taskId) {
        const num = songCount + 1;
        setSongCount(num);
        pollForSong(data.taskId, num, prompt, style);
      } else {
        setGenerationStatus("Suno error: " + JSON.stringify(data));
      }
    } catch (err) {
      setGenerationStatus("API error: " + String(err));
    }
  }, [sessionId, songCount, pollForSong, genre1, genre2]);

  const startSession = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: mockMode ? "Mock web session" : "Web session" }),
      });
      const data = await res.json();
      setSessionId(data.sessionId);
      setIsActive(true);
      setCollectSeconds(0);
      generatingRef.current = false;
      mockTickRef.current = 0;
      // DON'T clear readings — rings are already streaming data
      // DON'T re-send beginMeasurement — causes warmup delay with zeros
      setGenerationStatus("Collecting biometric data...");
    } catch (err) {
      console.error("Failed to start session:", err);
    }
  }, [mockMode]);

  const stopSession = useCallback(async () => {
    setIsActive(false);
    if (collectIntervalRef.current) {
      clearInterval(collectIntervalRef.current);
      collectIntervalRef.current = null;
    }
    if (sessionId) {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "end", sessionId }),
      });
    }
    setGenerationStatus("");
  }, [sessionId]);

  // Collection tick (1Hz)
  useEffect(() => {
    if (!isActive) return;

    collectIntervalRef.current = setInterval(() => {
      mockTickRef.current += 1;
      const t = mockTickRef.current;

      // Generate mock data if in mock mode
      if (mockMode) {
        const r1 = generateMockReading(1, t);
        const r2 = generateMockReading(2, t);
        readingsRef.current.push(r1, r2);

        setMockRing1Data({
          heartRate: r1.heartRate,
          spo2: r1.spo2,
          accelX: r1.accelX,
          accelY: r1.accelY,
          accelZ: r1.accelZ,
          rawPpg: r1.rawPpg,
          batteryLevel: 85,
          isCharging: false,
          lastUpdate: Date.now(),
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
          lastUpdate: Date.now(),
        });
      }

      // Skip if already generating
      if (generatingRef.current) return;

      setCollectSeconds((s) => {
        const next = s + 1;

        // Send batch to API every 5 seconds
        if (next % 5 === 0) {
          const batch = readingsRef.current.slice(-10);
          sendReadingsToApi(batch);
        }

        // After the window, always generate — with or without ring data
        if (next === WINDOW_SEC) {
          if (collectIntervalRef.current) {
            clearInterval(collectIntervalRef.current);
            collectIntervalRef.current = null;
          }
          generateSong();
        }

        return next;
      });
    }, 1000);

    return () => {
      if (collectIntervalRef.current) {
        clearInterval(collectIntervalRef.current);
      }
    };
  }, [isActive, mockMode, sendReadingsToApi, generateSong]);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <FloatingIcons />
      <div className="relative mx-auto max-w-2xl px-4 py-10 space-y-8">
        {/* Brand bar */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/brand/mascot.png" alt="" width={40} height={40} priority />
            <span className="font-display text-xl font-bold tracking-tight">
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
                disabled={!anyConnected}
                title={!anyConnected ? "Connect at least one ring" : ""}
              >
                Start Session
              </Button>
            ) : (
              <Button onClick={stopSession} variant="destructive" size="lg">
                Stop
              </Button>
            )}
          </div>
        </div>

        {/* Ring cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <RingCard
            personId={1}
            label="Person 1"
            size="9"
            onData={addReading}
            onConnectionChange={(_, connected) => setRing1Connected(connected)}
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
            onConnectionChange={(_, connected) => setRing2Connected(connected)}
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
