"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import RingCard from "@/components/ring-card";
import SessionPanel from "@/components/session-panel";
import MusicPlayer from "@/components/music-player";
import Image from "next/image";
import FloatingIcons from "@/components/floating-icons";
import ThemeToggle from "@/components/theme-toggle";
import Credit from "@/components/credit";
import { Tv } from "lucide-react";
import type { RingConnection, RingData } from "@/lib/ble/ring-manager";
import { HEART_RATE_CHANNEL } from "@/lib/heart-rate-channel";
import type { HeartRateMessage, LiveHeartRates, SessionPlan } from "@/lib/heart-rate-channel";
import { placebo } from "@/lib/progress";
import type { BiometricReading } from "@/lib/biometrics";
import { computeSnapshot } from "@/lib/biometrics";
import { buildPrompt } from "@/lib/prompt-builder";

import { EMPTY_SYNC_STATUS, RecordingOutbox } from "@/lib/recording-outbox";
import type { RecordedReading, RecordingSession } from "@/lib/recording-outbox";

const WINDOW_SEC = 30;
// The music is requested this many seconds in, from the readings so far, while
// the page keeps showing the recording until WINDOW_SEC: by the time the music
// bar appears, part of the wait has already gone by
const MUSIC_AT_SEC = 15;
// A 3-minute V6 song was ready 37-40 s after the request in the 2026-10-06
// benchmark; the music bar reaches its expected share at this point (placebo)
const SONG_EXPECTED_SEC = 40;
// The whole wait from Start to the song, for the bar on the SyncWave display
const PLAN_MS = Math.max(WINDOW_SEC, MUSIC_AT_SEC + SONG_EXPECTED_SEC) * 1000;
const POLL_MS = 3000;
// The note forms on the SyncWave display when the song starts playing; this
// long after the song is shown it forms anyway (sound blocked, slow network)
const SONG_START_GRACE_MS = 8000;
const POLL_ATTEMPTS = 100; // five minutes
const CURRENT_SESSION_KEY = "musical-box-current-session";
const MOCK_SUNO = process.env.USE_MOCK_SUNO === "true";
const MUSIC_CONFIG_MESSAGE = "Music configuration changed. Start a new session after reloading.";

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
  const [clientSessionId, setClientSessionId] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [endPersisted, setEndPersisted] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [currentSong, setCurrentSong] = useState<Song | null>(null);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [playerEpoch, setPlayerEpoch] = useState(0);
  const [sync, setSync] = useState(EMPTY_SYNC_STATUS);
  const [initialized, setInitialized] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [ring1Connected, setRing1Connected] = useState(false);
  const [ring2Connected, setRing2Connected] = useState(false);
  const demoMode = useSyncExternalStore(noopSubscribe, readMockFlag, () => false);
  const mockMode = process.env.USE_MOCK_BIOMETRICS === "true" || demoMode;
  const [mockRing1Data, setMockRing1Data] = useState<RingData | null>(null);
  const [mockRing2Data, setMockRing2Data] = useState<RingData | null>(null);
  const [genre1, setGenre1] = useState<string | null>(null);
  const [genre2, setGenre2] = useState<string | null>(null);

  const ring1Ref = useRef<RingConnection | null>(null);
  const ring2Ref = useRef<RingConnection | null>(null);
  const outboxRef = useRef<RecordingOutbox | null>(null);
  const activeSessionRef = useRef<RecordingSession | null>(null);
  const startingSessionRef = useRef(false);
  const endingSessionRef = useRef(false);
  const startingReadingsRef = useRef<{ startedAt: number; readings: RecordedReading[] } | null>(null);
  const generatingRef = useRef(false);
  const generationRunRef = useRef(0);
  const liveHrRef = useRef<LiveHeartRates>([null, null]);
  const planRef = useRef<SessionPlan | null>(null);
  const songReadyRef = useRef(false);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const mockTickRef = useRef(0);
  const anyConnected = mockMode || ring1Connected || ring2Connected;

  // Live heart rates for the SyncWave display (/syncwave) in another tab,
  // with the wait for the song and whether it has come
  const publishRates = useCallback(() => {
    channelRef.current?.postMessage({
      type: "rates", rates: liveHrRef.current, plan: planRef.current, song: songReadyRef.current,
    } satisfies HeartRateMessage);
  }, []);
  // The SyncWave display turns into the song's note as the music starts
  const songStarted = useCallback(() => {
    if (songReadyRef.current) return;
    songReadyRef.current = true;
    publishRates();
  }, [publishRates]);
  // No song is coming any more: the display's bar goes
  const dropPlan = useCallback(() => {
    planRef.current = null;
    publishRates();
  }, [publishRates]);

  useEffect(() => {
    const channel = new BroadcastChannel(HEART_RATE_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<HeartRateMessage>) => {
      if (event.data.type === "hello") publishRates();
    };
    publishRates();
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [publishRates]);

  useEffect(() => {
    const outbox = outboxRef.current ?? new RecordingOutbox();
    outboxRef.current = outbox;
    const generationRun = generationRunRef;
    let mounted = true;
    let localWrites = 0;
    const unsubscribe = outbox.subscribe((status) => {
      localWrites = status.localWrites;
      if (mounted) setSync(status);
    });
    const protectUnsavedMeasurements = (event: BeforeUnloadEvent) => {
      if (localWrites === 0 && !endingSessionRef.current && !startingReadingsRef.current?.readings.length) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsavedMeasurements);
    void (async () => {
      try {
        await outbox.initialize();
        const previousId = sessionStorage.getItem(CURRENT_SESSION_KEY);
        const previous = previousId ? await outbox.getSession(previousId) : undefined;
        if (!mounted) return;
        if (previous && !previous.retired) {
          activeSessionRef.current = previous;
          // A song is still to come only if the request was not interrupted
          planRef.current = previous.endedAt === null && !previous.generationAttempted
            ? { startedAt: previous.startedAt, expectedMs: PLAN_MS } : null;
          setClientSessionId(previous.clientSessionId);
          setGenre1(previous.genre1);
          setGenre2(previous.genre2);
          setElapsedSeconds(Math.floor(((previous.endedAt ?? Date.now()) - previous.startedAt) / 1000));
          setIsActive(previous.endedAt === null);
          setEndPersisted(previous.endedAt !== null);
          generatingRef.current = previous.generationAttempted;
          if (previous.endedAt === null) {
            setGenerationStatus(previous.generationAttempted
              ? "Recording resumed. Music was interrupted; stop before starting a new session."
              : "Recording biometric data...");
          }
        }
        setInitialized(true);
        void outbox.flush();
      } catch (error) {
        if (mounted) setSessionError("Local recording storage: " + String(error));
      }
    })();
    const timer = setInterval(() => void outbox.flush(), 5000);
    return () => {
      mounted = false;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("beforeunload", protectUnsavedMeasurements);
      generationRun.current++;
    };
  }, []);

  const recordReading = useCallback((reading: BiometricReading) => {
    liveHrRef.current[reading.personId - 1] = reading.heartRate === null
      ? null
      : { bpm: reading.heartRate, at: reading.timestamp };
    publishRates();
    const session = activeSessionRef.current;
    if (!session) {
      const starting = startingReadingsRef.current;
      if (starting && reading.timestamp >= starting.startedAt) {
        starting.readings.push({ ...reading, sampleId: crypto.randomUUID() });
      }
      return;
    }
    if (session.endedAt !== null || reading.timestamp < session.startedAt) return;
    void outboxRef.current?.append(session.clientSessionId, { ...reading, sampleId: crypto.randomUUID() })
      .catch((error) => setSessionError("Could not retain measurement: " + String(error)));
  }, [publishRates]);

  const addReading = useCallback((personId: 1 | 2, data: RingData) => {
    if (data.heartRate === null) return;
    recordReading({
      personId, timestamp: data.lastUpdate, heartRate: data.heartRate,
      spo2: data.spo2, temperature: null, hrv: null, rawPpg: data.rawPpg,
      accelX: data.accelX, accelY: data.accelY, accelZ: data.accelZ,
    });
  }, [recordReading]);

  const handleConnectionChange = useCallback((personId: 1 | 2, connected: boolean) => {
    if (personId === 1) setRing1Connected(connected);
    else setRing2Connected(connected);
    if (!connected) {
      liveHrRef.current[personId - 1] = null;
      publishRates();
    }
  }, [publishRates]);

  const finishSession = useCallback(async () => {
    const session = activeSessionRef.current;
    const outbox = outboxRef.current;
    if (!session || !outbox) return;
    const endedAt = session.endedAt ?? Date.now();
    // Stop accepting samples immediately; queued local writes precede this end marker.
    session.endedAt = endedAt;
    endingSessionRef.current = true;
    generationRunRef.current++;
    setIsActive(false);
    setElapsedSeconds(Math.floor((endedAt - session.startedAt) / 1000));
    try {
      await outbox.updateSession(session.clientSessionId, { endedAt });
      endingSessionRef.current = false;
      if (activeSessionRef.current?.clientSessionId === session.clientSessionId) {
        setEndPersisted(true);
        setSessionError("");
      }
      void outbox.flush();
    } catch (error) {
      setSessionError("Session end is not saved locally. Retry Stop: " + String(error));
    }
  }, []);

  const pollForSong = useCallback(async (taskId: string, prompt: string, style: string, run: number, requestedAt: number) => {
    if (generationRunRef.current !== run) return;
    setGenerationStatus("Generating music... Recording continues.");
    const progressTimer = setInterval(() => {
      if (generationRunRef.current !== run) { clearInterval(progressTimer); return; }
      // Counted from the request, so the bar is already under way when it appears
      setGenerationProgress(Math.round(placebo(Date.now() - requestedAt, SONG_EXPECTED_SEC * 1000)));
    }, 500);
    try {
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (generationRunRef.current !== run) return;
        const response = await fetch(`/api/generate/${taskId}`);
        if (generationRunRef.current !== run) return;
        if (response.status === 423) { setGenerationStatus(MUSIC_CONFIG_MESSAGE); return; }
        if (!response.ok) continue;
        const data = await response.json();
        if (generationRunRef.current !== run) return;
        if (data.status === "ready" && data.audioUrl) {
          // Even a song that is ready early waits for the full recording window
          const windowEnd = (activeSessionRef.current?.startedAt ?? 0) + WINDOW_SEC * 1000;
          if (Date.now() < windowEnd) await new Promise((resolve) => setTimeout(resolve, windowEnd - Date.now()));
          if (generationRunRef.current !== run) return;
          // The player starts it, and the note forms when the music does
          setCurrentSong({ taskId, audioUrl: data.audioUrl, prompt, style, number: 1 });
          const sessionId = activeSessionRef.current?.clientSessionId;
          setTimeout(() => {
            if (activeSessionRef.current?.clientSessionId === sessionId) songStarted();
          }, SONG_START_GRACE_MS);
          setGenerationStatus("");
          setGenerationProgress(100);
          await finishSession();
          return;
        }
      }
      if (generationRunRef.current === run) setGenerationStatus("Generation timed out. Recording continues until Stop.");
    } catch (error) {
      if (generationRunRef.current === run) setGenerationStatus("Music unavailable; recording continues. " + String(error));
    } finally {
      clearInterval(progressTimer);
      if (generationRunRef.current === run) {
        setGenerationProgress(0);
        if (!songReadyRef.current) dropPlan();
      }
    }
  }, [finishSession, songStarted, dropPlan]);

  const generateSong = useCallback(async () => {
    const session = activeSessionRef.current;
    const outbox = outboxRef.current;
    if (!session || session.endedAt !== null || !outbox || generatingRef.current) return;
    generatingRef.current = true;
    const run = generationRunRef.current;
    try {
      // Persist before any paid request. Reload never resubmits an uncertain request.
      await outbox.updateSession(session.clientSessionId, { generationAttempted: true });
      await outbox.flush();
      if (generationRunRef.current !== run) return;
      const saved = await outbox.getSession(session.clientSessionId);
      if (!saved?.serverSessionId) throw new Error("Session is still pending upload");
      const readings = await outbox.snapshot(session.clientSessionId, session.startedAt, session.startedAt + MUSIC_AT_SEC * 1000);
      const p1 = readings.filter((reading) => reading.personId === 1);
      const p2 = readings.filter((reading) => reading.personId === 2);
      const snapshot = p1.length >= 5 && p2.length >= 5 ? computeSnapshot(p1, p2) : null;
      const { prompt, style } = buildPrompt(session.genre1, session.genre2);
      if (generationRunRef.current !== run) return;
      setGenerationStatus(MOCK_SUNO ? "Preparing mock audio (no credits)..." : "Submitting to Suno... Recording continues.");
      const requestedAt = Date.now();
      const response = await fetch("/api/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: saved.serverSessionId, prompt, style, snapshot }),
      });
      if (generationRunRef.current !== run) return;
      if (response.status === 423) { setGenerationStatus(MUSIC_CONFIG_MESSAGE); dropPlan(); return; }
      if (!response.ok) throw new Error(`Music request failed (${response.status})`);
      const data = await response.json();
      if (generationRunRef.current !== run) return;
      if (!data.taskId) throw new Error("Music service did not return a task ID");
      void pollForSong(data.taskId, prompt, style, run, requestedAt);
    } catch (error) {
      if (generationRunRef.current === run) {
        setGenerationStatus("Music unavailable; recording continues. " + String(error));
        dropPlan();
      }
    }
  }, [pollForSong, dropPlan]);

  const startSession = useCallback(async () => {
    const outbox = outboxRef.current;
    if (!outbox || !sync.ready || !initialized || startingSessionRef.current || activeSessionRef.current) return;
    startingSessionRef.current = true;
    const session: RecordingSession = {
      clientSessionId: crypto.randomUUID(), serverSessionId: null, startedAt: Date.now(), endedAt: null,
      endAcknowledged: false, notes: mockMode ? "Mock web session" : "Web session",
      genre1, genre2, generationAttempted: false, retired: false,
      person1Count: 0, person2Count: 0, acknowledgedCount: 0,
    };
    startingReadingsRef.current = { startedAt: session.startedAt, readings: [] };
    try {
      await outbox.createSession(session);
      sessionStorage.setItem(CURRENT_SESSION_KEY, session.clientSessionId);
      activeSessionRef.current = session;
      // The display's bar starts filling
      planRef.current = { startedAt: session.startedAt, expectedMs: PLAN_MS };
      publishRates();
      // Preserve callbacks received while IndexedDB was committing the parent.
      for (const reading of startingReadingsRef.current.readings) {
        void outbox.append(session.clientSessionId, reading)
          .catch((error) => setSessionError("Could not retain measurement: " + String(error)));
      }
      startingReadingsRef.current = null;
      generationRunRef.current++;
      generatingRef.current = false;
      setClientSessionId(session.clientSessionId);
      setIsActive(true);
      setEndPersisted(false);
      setElapsedSeconds(0);
      setSessionError("");
      setGenerationStatus("Recording biometric data...");
      mockTickRef.current = 0;
      void outbox.flush();
    } catch (error) {
      setSessionError("Could not start local recording: " + String(error));
    } finally { startingSessionRef.current = false; startingReadingsRef.current = null; }
  }, [sync.ready, initialized, mockMode, genre1, genre2, publishRates]);

  const stopSession = useCallback(async () => {
    setGenerationStatus("");
    setGenerationProgress(0);
    dropPlan();
    await finishSession();
  }, [finishSession, dropPlan]);

  const newSession = useCallback(async () => {
    const session = activeSessionRef.current;
    if (!session || !endPersisted || session.endedAt === null) return;
    try {
      await outboxRef.current?.retire(session.clientSessionId);
      sessionStorage.removeItem(CURRENT_SESSION_KEY);
      activeSessionRef.current = null;
      generationRunRef.current++;
      generatingRef.current = false;
      setClientSessionId(null);
      setElapsedSeconds(0);
      setEndPersisted(false);
      setCurrentSong(null);
      // ...and the SyncWave display returns to its waves
      songReadyRef.current = false;
      dropPlan();
      setGenerationStatus("");
      setGenerationProgress(0);
      setGenre1(null);
      setGenre2(null);
      setMockRing1Data(null);
      setMockRing2Data(null);
      setPlayerEpoch((epoch) => epoch + 1);
      setSessionError("");
    } catch (error) {
      setSessionError("Could not prepare a new session: " + String(error));
    }
  }, [endPersisted, dropPlan]);

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => {
      const session = activeSessionRef.current;
      if (!session || session.endedAt !== null) return;
      if (mockMode) {
        const t = ++mockTickRef.current;
        for (const personId of [1, 2] as const) {
          const reading = generateMockReading(personId, t);
          recordReading(reading);
          const mockData: RingData = {
            heartRate: reading.heartRate, spo2: reading.spo2, rawPpg: reading.rawPpg,
            accelX: reading.accelX, accelY: reading.accelY, accelZ: reading.accelZ,
            batteryLevel: 85, isCharging: false, lastUpdate: reading.timestamp,
          };
          if (personId === 1) setMockRing1Data(mockData);
          else setMockRing2Data(mockData);
        }
      }
      const elapsed = Math.floor((Date.now() - session.startedAt) / 1000);
      setElapsedSeconds(elapsed);
      if (elapsed >= MUSIC_AT_SEC) void generateSong();
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive, mockMode, generateSong, recordReading]);

  const currentRecording = sync.sessions.find((session) => session.clientSessionId === clientSessionId);
  const saved = endPersisted && currentRecording?.endAcknowledged && sync.localWrites === 0;
  const saveStatus = sync.storageError ? "Local storage needs attention"
    : sync.localWrites > 0 ? "Saving locally..."
    : sync.pendingReadings > 0 || sync.pendingSessions > 0 ? `${sync.pendingReadings} measurements pending upload`
    : saved ? "Saved" : isActive ? "All received measurements saved" : "Ready";
  // Until the recording window ends the music stays out of sight, even though it
  // was requested at MUSIC_AT_SEC
  const musicShown = !isActive || elapsedSeconds >= WINDOW_SEC;
  const shownStatus = musicShown ? generationStatus : "Recording biometric data...";
  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <FloatingIcons />
      <div className="relative mx-auto max-w-2xl px-4 py-10 space-y-8">
        {/* Brand bar */}
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2.5">
              {/* Same as educoach-platform's <Logo showIcon />: logo-v3 + text wordmark */}
              <Image src="/brand/logo.png" alt="" width={36} height={36} priority className="rounded-lg" />
              <span className="font-display text-2xl font-bold tracking-tight">
                Edu<span className="text-primary">Coach</span>
              </span>
            </div>
            <Credit className="text-xs" />
          </div>
          <div className="flex items-center gap-2">
            {/* Opens in a tab of its own (the same one each time); drag it out onto a TV */}
            <Button
              variant="outline"
              onClick={() => window.open("/syncwave", "syncwave")}
              className="h-10 rounded-full border-border/60 bg-card px-3.5"
              aria-label="Open SyncWave"
              title="Open the SyncWave display in a new tab"
            >
              <Tv />
              <span className="hidden sm:inline">SyncWave</span>
            </Button>
            <ThemeToggle />
          </div>
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
            {!clientSessionId ? (
              <Button
                onClick={startSession}
                variant="3d-primary"
                size="lg"
                className="h-12 px-7 text-base"
                disabled={!anyConnected || !sync.ready || !initialized}
                title={!anyConnected ? "Connect at least one ring" : ""}
              >
                Start Session
              </Button>
            ) : isActive || !endPersisted ? (
              <Button onClick={stopSession} variant="destructive" size="lg" className="h-12 rounded-2xl px-7 text-base font-bold uppercase tracking-widest">
                Stop
              </Button>
            ) : (
              <Button onClick={newSession} variant="3d-primary" size="lg">New Session</Button>
            )}
          </div>
        </div>

        {/* Setup and saving, folded away until wanted; a problem someone has to
            act on shows below it */}
        <div className="space-y-2">
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer select-none font-medium hover:text-foreground">Session details</summary>
            <div className="mt-2 space-y-2">
              <div role="status" aria-label="Application configuration" className="rounded-lg border border-border/60 bg-card/60 px-3 py-2">
                Music: {MOCK_SUNO ? "Mock (no credits)" : "Suno (live)"} &middot; Biometrics: {mockMode ? "Mock (synthetic)" : "Live rings"}
              </div>
              <div role="status" aria-label="Recording storage" className="rounded-lg border border-border/60 bg-card/60 px-3 py-2 space-y-1">
                <p className="font-medium">{isActive ? "Recording" : clientSessionId ? "Session finished" : "Session"} · {saveStatus}</p>
                {clientSessionId && <p>{elapsedSeconds}s · Person 1: {currentRecording?.person1Count ?? 0} · Person 2: {currentRecording?.person2Count ?? 0} measurements</p>}
                {(sync.networkError || sync.storageError || sessionError) && <p className="text-destructive">{sessionError || sync.storageError || sync.networkError}</p>}
                {sync.localWrites > 0 && <p>Some measurements are only in memory. Keep this tab open until local saving finishes.</p>}
                {sync.pendingReadings > 0 && sync.localWrites === 0 && <p>Pending measurements are kept on this device and retried automatically.</p>}
              </div>
            </div>
          </details>
          {(sessionError || sync.storageError) && (
            <p role="alert" className="text-sm text-destructive">{sessionError || sync.storageError}</p>
          )}
        </div>

        {/* Ring cards: each person's ring by the name Chrome lists it under */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <RingCard
            personId={1}
            label="Person 1"
            size="9"
            ringName="R02_AF03"
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
            ringName="R02_D7B0"
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
          collectSeconds={Math.min(elapsedSeconds, WINDOW_SEC)}
          windowSeconds={WINDOW_SEC}
          status={shownStatus || (isActive ? "Recording..." : "")}
        />

        {/* Music player */}
        <MusicPlayer
          key={playerEpoch}
          currentSong={currentSong}
          history={[]}
          generationStatus={shownStatus}
          generationProgress={musicShown ? generationProgress : 0}
          waiting={musicShown && !currentSong && generationProgress > 0}
          onStarted={songStarted}
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
