// The quiet music the SyncWave display plays while a song is on its way: take
// 2B of three Suno candidates (lo-fi, Rhodes, 2 min). Its volume is set on the
// Musical Box page, kept in this browser, and sent to the display.
export const WAITING_MUSIC = "/waiting-music.mp3";
export const DEFAULT_VOLUME = 0.25;
const VOLUME_KEY = "musical-box-waiting-volume";

// Also kept in memory, for browsers that store nothing
let volumeInMemory = DEFAULT_VOLUME;
const listeners = new Set<() => void>();

export function readVolume(): number {
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    const value = saved === null ? NaN : Number(saved);
    if (value >= 0 && value <= 1) return value;
  } catch {
    // storage unavailable: memory only
  }
  return volumeInMemory;
}

export function saveVolume(value: number) {
  volumeInMemory = value;
  try {
    localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    // storage unavailable: memory only
  }
  for (const listener of listeners) listener();
}

export function subscribeVolume(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
