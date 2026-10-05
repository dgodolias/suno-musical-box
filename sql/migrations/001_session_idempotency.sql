-- Add stable client IDs while preserving historical rows and numeric IDs.
BEGIN;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_session_id UUID;
ALTER TABLE biometric_readings ADD COLUMN IF NOT EXISTS client_sample_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_client_session_id
    ON sessions(client_session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_client_sample_id
    ON biometric_readings(client_sample_id);
COMMIT;
