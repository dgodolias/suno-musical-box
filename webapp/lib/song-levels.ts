// How loud a song is through its length, in the bass and in the melody: worked
// out once from its file (the playing <audio> is left untouched), then read at
// the moment that is heard and sent to the SyncWave display, whose waves move
// with it.
export const LEVELS_FPS = 30;
const RATE = 22050; // plenty for loudness, and half the memory of 44.1 kHz
const BASS_HZ = 150; // below: the kick and the bass
const MELODY_HZ = 600; // above: the melody

export interface SongLevels {
  fps: number;
  low: Float32Array; // 0-1 per frame
  high: Float32Array;
}

/** Fetches and decodes the song, then measures each band through it. */
export async function analyseSong(url: string, signal?: AbortSignal): Promise<SongLevels> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Song download failed (${response.status})`);
  const decoded = await new OfflineAudioContext(1, 1, RATE).decodeAudioData(await response.arrayBuffer());
  const band = async (type: BiquadFilterType, frequency: number) => {
    const context = new OfflineAudioContext(1, decoded.length, RATE);
    const source = context.createBufferSource();
    source.buffer = decoded;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    source.connect(filter);
    filter.connect(context.destination);
    source.start();
    return envelope((await context.startRendering()).getChannelData(0), RATE);
  };
  const [low, high] = await Promise.all([band("lowpass", BASS_HZ), band("highpass", MELODY_HZ)]);
  return { fps: LEVELS_FPS, low, high };
}

/** Loudness (RMS) per frame, scaled so the song's loud parts reach 1. */
export function envelope(samples: Float32Array, rate: number, fps = LEVELS_FPS): Float32Array {
  const size = Math.max(1, Math.floor(rate / fps));
  const frames = Math.floor(samples.length / size);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let i = frame * size; i < (frame + 1) * size; i++) sum += samples[i] * samples[i];
    out[frame] = Math.sqrt(sum / size);
  }
  // The 95th percentile becomes 1, so a quiet mix still moves the waves
  const sorted = Float32Array.from(out).sort();
  const top = sorted[Math.floor(0.95 * (frames - 1))] || 1;
  for (let frame = 0; frame < frames; frame++) out[frame] = Math.min(1, out[frame] / top);
  return out;
}

/** The levels at a moment of the song, in seconds. */
export function levelsAt(levels: SongLevels, seconds: number): { low: number; high: number } {
  const frame = Math.max(0, Math.floor(seconds * levels.fps));
  return { low: levels.low[frame] ?? 0, high: levels.high[frame] ?? 0 };
}
