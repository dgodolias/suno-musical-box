"""Async PostgreSQL database layer using psycopg v3."""

import json
import logging
from datetime import datetime, timezone

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from src.biometrics.models import BiometricReading, BiometricSnapshot

logger = logging.getLogger(__name__)


class Database:
    """Async PostgreSQL connection pool and query methods."""

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self.pool: AsyncConnectionPool | None = None

    async def connect(self) -> None:
        self.pool = AsyncConnectionPool(conninfo=self.dsn, min_size=2, max_size=5, open=False)
        await self.pool.open()
        logger.info("Database pool opened")

    async def close(self) -> None:
        if self.pool:
            await self.pool.close()
            logger.info("Database pool closed")

    def get_connection(self) -> AsyncConnection:
        """Get an async connection from the pool (use as async context manager)."""
        assert self.pool is not None, "Database not connected"
        return self.pool.connection()

    async def create_session(self, notes: str = "") -> int:
        """Create a new session and return its ID."""
        async with self.get_connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "INSERT INTO sessions (notes) VALUES (%s) RETURNING id",
                    (notes,),
                )
                row = await cur.fetchone()
                assert row is not None
                return row["id"]

    async def end_session(self, session_id: int) -> None:
        """Mark a session as ended."""
        async with self.get_connection() as conn:
            await conn.execute(
                "UPDATE sessions SET ended_at = %s WHERE id = %s",
                (datetime.now(timezone.utc), session_id),
            )

    async def insert_reading(self, session_id: int, reading: BiometricReading) -> None:
        """Insert a single biometric reading."""
        async with self.get_connection() as conn:
            await conn.execute(
                """INSERT INTO biometric_readings
                   (session_id, person_id, timestamp, heart_rate, spo2, temperature, hrv, raw_ppg, accel_x, accel_y, accel_z)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    session_id,
                    reading.person_id,
                    reading.timestamp,
                    reading.heart_rate,
                    reading.spo2,
                    reading.temperature,
                    reading.hrv,
                    reading.raw_ppg,
                    reading.accel_x,
                    reading.accel_y,
                    reading.accel_z,
                ),
            )

    async def insert_readings_batch(
        self,
        session_id: int,
        readings: list[BiometricReading],
    ) -> None:
        """Insert multiple biometric readings in a single transaction."""
        async with self.get_connection() as conn:
            async with conn.cursor() as cur:
                for reading in readings:
                    await cur.execute(
                        """INSERT INTO biometric_readings
                           (session_id, person_id, timestamp, heart_rate, spo2, temperature, hrv)
                           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                        (
                            session_id,
                            reading.person_id,
                            reading.timestamp,
                            reading.heart_rate,
                            reading.spo2,
                            reading.temperature,
                            reading.hrv,
                        ),
                    )

    async def get_readings_window(
        self,
        session_id: int,
        window_sec: int,
        person_id: int | None = None,
    ) -> list[BiometricReading]:
        """Get readings from the last N seconds, optionally filtered by person."""
        query = """
            SELECT person_id, timestamp, heart_rate, spo2, temperature, hrv, raw_ppg, accel_x, accel_y, accel_z
            FROM biometric_readings
            WHERE session_id = %s
              AND timestamp >= NOW() - INTERVAL '%s seconds'
        """
        params: list[int] = [session_id, window_sec]

        if person_id is not None:
            query += " AND person_id = %s"
            params.append(person_id)

        query += " ORDER BY timestamp DESC"

        async with self.get_connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(query, params)
                rows = await cur.fetchall()
                return [
                    BiometricReading(
                        person_id=row["person_id"],
                        timestamp=row["timestamp"],
                        heart_rate=row["heart_rate"],
                        spo2=row["spo2"],
                        temperature=row["temperature"],
                        hrv=row["hrv"],
                        raw_ppg=row["raw_ppg"],
                        accel_x=row["accel_x"],
                        accel_y=row["accel_y"],
                        accel_z=row["accel_z"],
                    )
                    for row in rows
                ]

    async def insert_song(
        self,
        session_id: int,
        prompt: str,
        style_tag: str,
        snapshot: BiometricSnapshot,
        suno_song_id: str = "",
        audio_url: str = "",
        local_path: str = "",
        duration_sec: float = 0.0,
    ) -> int:
        """Insert a generated song record and return its ID."""
        async with self.get_connection() as conn:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    """INSERT INTO generated_songs
                       (session_id, prompt, style_tag, suno_song_id, audio_url,
                        local_path, duration_sec, biometric_snapshot)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                       RETURNING id""",
                    (
                        session_id,
                        prompt,
                        style_tag,
                        suno_song_id,
                        audio_url,
                        local_path,
                        duration_sec,
                        json.dumps(snapshot.model_dump(), default=str),
                    ),
                )
                row = await cur.fetchone()
                assert row is not None
                return row["id"]
