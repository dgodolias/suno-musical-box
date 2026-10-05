import { neon } from "@neondatabase/serverless";

export function getDb() {
  return neon(process.env.DATABASE_URL!);
}

export async function createSession(clientSessionId: string, startedAt: number, notes = ""): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO sessions (client_session_id, started_at, notes)
    VALUES (${clientSessionId}, ${new Date(startedAt).toISOString()}, ${notes})
    ON CONFLICT (client_session_id) DO UPDATE
      SET client_session_id = EXCLUDED.client_session_id
    RETURNING id
  `;
  return rows[0].id;
}

export async function endSession(sessionId: number, clientSessionId: string, endedAt: number): Promise<boolean> {
  const sql = getDb();
  const timestamp = new Date(endedAt).toISOString();
  const rows = await sql`
    UPDATE sessions SET ended_at = COALESCE(ended_at, ${timestamp})
    WHERE id = ${sessionId} AND client_session_id = ${clientSessionId}
      AND started_at <= ${timestamp}
    RETURNING id
  `;
  return rows.length === 1;
}

export interface ReadingInput {
  sampleId: string;
  personId: 1 | 2;
  timestamp: number;
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
): Promise<{ count: number; acknowledgedSampleIds: string[] }> {
  const sql = getDb();
  if (readings.length === 0) return { count: 0, acknowledgedSampleIds: [] };
  // A failed batch must not leave a partially inserted prefix before a retry.
  const results = await sql.transaction(readings.map((r) => sql`
      INSERT INTO biometric_readings
        (client_sample_id, session_id, person_id, timestamp, heart_rate, spo2, temperature, hrv, raw_ppg, accel_x, accel_y, accel_z)
      VALUES
        (${r.sampleId}, ${sessionId}, ${r.personId}, ${new Date(r.timestamp).toISOString()}, ${r.heartRate}, ${r.spo2}, ${r.temperature}, ${r.hrv}, ${r.rawPpg}, ${r.accelX}, ${r.accelY}, ${r.accelZ})
      ON CONFLICT (client_sample_id) DO UPDATE
        SET client_sample_id = biometric_readings.client_sample_id
      WHERE biometric_readings.session_id = EXCLUDED.session_id
        AND biometric_readings.person_id = EXCLUDED.person_id
        AND biometric_readings.timestamp = EXCLUDED.timestamp
        AND biometric_readings.heart_rate IS NOT DISTINCT FROM EXCLUDED.heart_rate
        AND biometric_readings.spo2 IS NOT DISTINCT FROM EXCLUDED.spo2
        AND biometric_readings.temperature IS NOT DISTINCT FROM EXCLUDED.temperature
        AND biometric_readings.hrv IS NOT DISTINCT FROM EXCLUDED.hrv
        AND biometric_readings.raw_ppg IS NOT DISTINCT FROM EXCLUDED.raw_ppg
        AND biometric_readings.accel_x IS NOT DISTINCT FROM EXCLUDED.accel_x
        AND biometric_readings.accel_y IS NOT DISTINCT FROM EXCLUDED.accel_y
        AND biometric_readings.accel_z IS NOT DISTINCT FROM EXCLUDED.accel_z
      RETURNING client_sample_id
    `));
  // An identical retry returns its ID; a conflicting observation returns no ID
  // and stays pending on the client. Never overwrite previously recorded data.
  const acknowledgedSampleIds = [...new Set(results.flatMap((rows) => rows.map((row) => String(row.client_sample_id))))];
  return { count: acknowledgedSampleIds.length, acknowledgedSampleIds };
}

export interface ReplayReading {
  personId: 1 | 2;
  offsetMs: number; // since the session's first heart-rate reading
  heartRate: number;
}

export interface Replay {
  sessionId: number;
  readings: ReplayReading[];
}

/** A recorded session's heart rates, for replaying on the SyncWave display.
 * Without an ID, the latest session in which both people were measured. */
export async function getReplay(sessionId?: number): Promise<Replay | null> {
  const sql = getDb();
  const id: number | undefined = sessionId ?? (await sql`
    SELECT session_id FROM biometric_readings
    WHERE heart_rate IS NOT NULL
    GROUP BY session_id
    ORDER BY count(DISTINCT person_id) DESC, session_id DESC
    LIMIT 1
  `)[0]?.session_id;
  if (id === undefined) return null;
  const rows = await sql`
    SELECT person_id, heart_rate,
      round(extract(epoch FROM timestamp - min(timestamp) OVER ()) * 1000) AS offset_ms
    FROM biometric_readings
    WHERE session_id = ${id} AND heart_rate IS NOT NULL
    ORDER BY timestamp
  `;
  if (rows.length === 0) return null;
  return {
    sessionId: id,
    readings: rows.map((row) => ({
      personId: row.person_id, offsetMs: Number(row.offset_ms), heartRate: row.heart_rate,
    })),
  };
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

/** The finished song's audio URL — the same clip the UI played — or null if not ready. */
export async function getSongAudioUrl(sunoTaskId: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT audio_url FROM generated_songs
    WHERE suno_song_id = ${sunoTaskId} AND audio_url <> ''
    LIMIT 1
  `;
  return rows[0]?.audio_url ?? null;
}
