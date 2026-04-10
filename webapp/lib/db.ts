import { neon } from "@neondatabase/serverless";

export function getDb() {
  return neon(process.env.DATABASE_URL!);
}

export async function createSession(notes: string = ""): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO sessions (notes) VALUES (${notes}) RETURNING id
  `;
  return rows[0].id;
}

export async function endSession(sessionId: number): Promise<void> {
  const sql = getDb();
  await sql`UPDATE sessions SET ended_at = NOW() WHERE id = ${sessionId}`;
}

export interface ReadingInput {
  personId: number;
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  hrv: number | null;
  rawPpg: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
}

export async function insertReadings(
  sessionId: number,
  readings: ReadingInput[]
): Promise<number> {
  const sql = getDb();
  for (const r of readings) {
    await sql`
      INSERT INTO biometric_readings
        (session_id, person_id, heart_rate, spo2, temperature, hrv, raw_ppg, accel_x, accel_y, accel_z)
      VALUES
        (${sessionId}, ${r.personId}, ${r.heartRate}, ${r.spo2}, ${r.temperature}, ${r.hrv}, ${r.rawPpg}, ${r.accelX}, ${r.accelY}, ${r.accelZ})
    `;
  }
  return readings.length;
}

export interface SongInput {
  sessionId: number;
  prompt: string;
  styleTag: string;
  sunoTaskId: string;
  audioUrl: string;
  durationSec: number;
  biometricSnapshot: Record<string, unknown>;
}

export async function insertSong(song: SongInput): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO generated_songs
      (session_id, prompt, style_tag, suno_song_id, audio_url, duration_sec, biometric_snapshot)
    VALUES
      (${song.sessionId}, ${song.prompt}, ${song.styleTag}, ${song.sunoTaskId},
       ${song.audioUrl}, ${song.durationSec}, ${JSON.stringify(song.biometricSnapshot)})
    RETURNING id
  `;
  return rows[0].id;
}

export async function updateSongAudio(
  sunoTaskId: string,
  audioUrl: string,
  durationSec: number
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE generated_songs
    SET audio_url = ${audioUrl}, duration_sec = ${durationSec}
    WHERE suno_song_id = ${sunoTaskId}
  `;
}
