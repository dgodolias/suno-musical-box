"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import RingCard from "@/components/ring-card";
import SessionPanel from "@/components/session-panel";
import MusicPlayer from "@/components/music-player";
import { type RingData, RingConnection } from "@/lib/ble/ring-manager";
import {
  type BiometricReading,
  type BiometricSnapshot,
  computeSnapshot,
} from "@/lib/biometrics";
import { buildPrompt } from "@/lib/prompt-builder";

const WINDOW_SEC = 30;

interface Song {
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

function loadSunoKey(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("musical-box-suno-key") || "";
}

export default function Home() {
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [collectSeconds, setCollectSeconds] = useState(0);
  const [snapshot, setSnapshot] = useState<BiometricSnapshot | null>(null);
  const [generationStatus, setGenerationStatus] = useState("");
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [history, setHistory] = useState<Song[]>([]);
  const [songCount, setSongCount] = useState(0);
  const [ring1Connected, setRing1Connected] = useState(false);
  const [ring2Connected, setRing2Connected] = useState(false);
  const [mockMode, setMockMode] = useState(false);
  const [sunoKey, setSunoKey] = useState(loadSunoKey);
  const [showSettings, setShowSettings] = useState(false);
  const [mockRing1Data, setMockRing1Data] = useState<RingData | null>(null);
  const [mockRing2Data, setMockRing2Data] = useState<RingData | null>(null);

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

  const bothConnected = ring1Connected && ring2Connected;

  const addReading = useCallback(
    (personId: 1 | 2, data: RingData) => {
      if (!isActive) return;
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
    },
    [isActive]
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
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        try {
          const headers: Record<string, string> = {};
          if (sunoKey) headers["x-suno-key"] = sunoKey;
          const res = await fetch(`/api/generate/${taskId}`, { headers });
          const data = await res.json();
          setGenerationStatus(`Generating... (${(i + 1) * 10}s)`);

          if (data.status === "ready" && data.audioUrl) {
            const song: Song = {
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
            return;
          }
        } catch (err) {
          console.error("Poll error:", err);
        }
      }
      setGenerationStatus("Generation timed out");
    },
    []
  );

  const generateSong = useCallback(async () => {
    const readings = readingsRef.current;
    const p1 = readings.filter((r) => r.personId === 1);
    const p2 = readings.filter((r) => r.personId === 2);

    if (p1.length < 5 || p2.length < 5) {
      setGenerationStatus("Not enough data from both rings");
      return;
    }

    const snap = computeSnapshot(p1, p2);
    setSnapshot(snap);

    const { prompt, style } = buildPrompt(snap);
    setGenerationStatus("Submitting to Suno...");

    try {
      const fetchHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (sunoKey) fetchHeaders["x-suno-key"] = sunoKey;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: fetchHeaders,
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
  }, [sessionId, songCount, pollForSong]);

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
      readingsRef.current = [];
      mockTickRef.current = 0;
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

      setCollectSeconds((s) => {
        const next = s + 1;

        // Send batch to API every 5 seconds
        if (next % 5 === 0) {
          const batch = readingsRef.current.slice(-10);
          sendReadingsToApi(batch);
        }

        // Trigger generation after window
        if (next === WINDOW_SEC) {
          generateSong();
        }

        // Auto-regenerate every WINDOW_SEC after first
        if (next > WINDOW_SEC && next % WINDOW_SEC === 0) {
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
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="mx-auto max-w-2xl px-4 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Musical Box</h1>
            <p className="text-sm text-zinc-400">
              Biometric-driven music generation
            </p>
          </div>
          <div className="flex items-center gap-3">
            {!isActive ? (
              <Button
                onClick={startSession}
                size="lg"
                disabled={!bothConnected}
                title={!bothConnected ? "Connect both rings first" : ""}
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

        {/* Mock mode toggle */}
        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <div>
            <span className="text-sm font-medium">Mock Mode</span>
            <span className="ml-2 text-xs text-zinc-500">
              Fake biometrics, no rings needed
            </span>
          </div>
          <button
            onClick={() => {
              if (!isActive) setMockMode((m) => !m);
            }}
            disabled={isActive}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              mockMode ? "bg-emerald-600" : "bg-zinc-700"
            } ${isActive ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                mockMode ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Settings */}
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="flex w-full items-center justify-between text-sm"
          >
            <span className="font-medium">Settings</span>
            <span className="text-zinc-500">{showSettings ? "▲" : "▼"}</span>
          </button>
          {showSettings && (
            <div className="mt-3 space-y-2">
              <label className="block text-xs text-zinc-400">
                Suno API Key (optional — overrides server default)
              </label>
              <input
                type="text"
                value={sunoKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setSunoKey(val);
                  if (val) {
                    localStorage.setItem("musical-box-suno-key", val);
                  } else {
                    localStorage.removeItem("musical-box-suno-key");
                  }
                }}
                placeholder="Enter your API key from apibox.erweima.ai"
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 focus:border-emerald-500 focus:outline-none"
              />
              {sunoKey && (
                <p className="text-xs text-emerald-500">Using your custom API key</p>
              )}
            </div>
          )}
        </div>

        {/* Ring cards */}
        <div className="grid grid-cols-2 gap-4">
          <RingCard
            personId={1}
            label="Person 1"
            size="9"
            onData={addReading}
            onConnectionChange={(_, connected) => setRing1Connected(connected)}
            connectionRef={ring1Ref}
            mockMode={mockMode}
            mockData={mockRing1Data}
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
          />
        </div>

        {/* Session panel */}
        <SessionPanel
          isActive={isActive}
          collectSeconds={
            collectSeconds % WINDOW_SEC ||
            (collectSeconds > 0 ? WINDOW_SEC : 0)
          }
          windowSeconds={WINDOW_SEC}
          snapshot={snapshot}
          status={generationStatus || (isActive ? "Collecting..." : "")}
        />

        {/* Music player */}
        <MusicPlayer
          currentSong={currentSong}
          history={history}
          generationStatus={generationStatus}
          onSongEnd={generateSong}
        />

        {/* Footer */}
        <p className="text-center text-xs text-zinc-600">
          Requires Chrome/Edge with Bluetooth. Colmi R02 rings.
        </p>
      </div>
    </div>
  );
}
