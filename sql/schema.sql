-- Suno Musical Box — Database Schema

CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS biometric_readings (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    person_id SMALLINT NOT NULL CHECK (person_id IN (1, 2)),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    heart_rate SMALLINT,
    spo2 SMALLINT,
    temperature REAL,
    hrv SMALLINT,
    raw_ppg SMALLINT,
    accel_x REAL,
    accel_y REAL,
    accel_z REAL
);

CREATE INDEX IF NOT EXISTS idx_readings_session_ts
    ON biometric_readings(session_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS generated_songs (
    id SERIAL PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    prompt TEXT NOT NULL,
    style_tag TEXT,
    suno_song_id TEXT,
    audio_url TEXT,
    local_path TEXT,
    duration_sec REAL,
    biometric_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
