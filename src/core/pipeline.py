"""3-task async pipeline: collect → generate → play.

The orchestrator runs three concurrent asyncio tasks:
1. Collection: biometric data at 1Hz (never stops)
2. Generation: builds prompt from recent biometrics, calls Suno, queues MP3
3. Playback: dequeues MP3s and plays them sequentially
"""

import asyncio
import logging

from src.biometrics.mock_collector import MockCollector
from src.config import BIOMETRIC_WINDOW_SEC, SONG_QUEUE_MAXSIZE
from src.core.audio_player import AudioPlayer
from src.core.database import Database
from src.helpers import compute_snapshot
from src.mapping.prompt_builder import build_prompt
from src.music.suno_client import MockSunoClient, SunoClient

logger = logging.getLogger(__name__)


class Pipeline:
    """Orchestrates the collect → generate → play loop."""

    def __init__(
        self,
        db: Database,
        collector: MockCollector,
        suno_client: MockSunoClient | SunoClient,
        player: AudioPlayer,
    ) -> None:
        self.db = db
        self.collector = collector
        self.suno_client = suno_client
        self.player = player
        self.song_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=SONG_QUEUE_MAXSIZE)
        self.session_id: int = 0

    async def run(self) -> None:
        """Start the full pipeline. Blocks until interrupted."""
        await self.db.connect()
        self.session_id = await self.db.create_session(notes="Musical Box session")
        logger.info("Session %d started", self.session_id)

        await self.collector.start(self.session_id)

        tasks = [
            asyncio.create_task(self.generation_loop(), name="generation"),
            asyncio.create_task(self.playback_loop(), name="playback"),
        ]

        try:
            await asyncio.gather(*tasks)
        except asyncio.CancelledError:
            logger.info("Pipeline cancelled")
        finally:
            await self.shutdown()

    async def generation_loop(self) -> None:
        """Wait for enough data, then continuously generate songs."""
        logger.info("Waiting %ds for biometric data to accumulate...", BIOMETRIC_WINDOW_SEC)
        await asyncio.sleep(BIOMETRIC_WINDOW_SEC)

        song_number = 0
        while True:
            song_number += 1
            logger.info("--- Generating song #%d ---", song_number)

            readings = await self.collector.get_latest_readings(BIOMETRIC_WINDOW_SEC)
            readings_p1 = [r for r in readings if r.person_id == 1]
            readings_p2 = [r for r in readings if r.person_id == 2]

            if not readings_p1 or not readings_p2:
                logger.warning("Not enough readings, waiting 5s...")
                await asyncio.sleep(5)
                continue

            snapshot = compute_snapshot(readings_p1, readings_p2)
            prompt, style = build_prompt(snapshot)
            logger.info("Prompt: %s", prompt)
            logger.info("Style: %s", style)
            logger.info(
                "Biometrics: arousal=%.2f valence=%.2f sync=%.2f | "
                "P1(HR=%.0f SpO2=%.0f T=%.1f HRV=%.0f) "
                "P2(HR=%.0f SpO2=%.0f T=%.1f HRV=%.0f)",
                snapshot.combined_arousal,
                snapshot.combined_valence,
                snapshot.synchrony_score,
                snapshot.person1.avg_hr,
                snapshot.person1.avg_spo2,
                snapshot.person1.avg_temperature,
                snapshot.person1.avg_hrv,
                snapshot.person2.avg_hr,
                snapshot.person2.avg_spo2,
                snapshot.person2.avg_temperature,
                snapshot.person2.avg_hrv,
            )

            song = await self.suno_client.generate(prompt, style)

            await self.db.insert_song(
                session_id=self.session_id,
                prompt=prompt,
                style_tag=style,
                snapshot=snapshot,
                suno_song_id=song.suno_id,
                audio_url=song.audio_url,
                local_path=str(song.local_path or ""),
                duration_sec=song.duration_sec,
            )

            if song.local_path and song.local_path.exists():
                await self.song_queue.put(str(song.local_path))
                logger.info("Song #%d queued for playback", song_number)
            else:
                logger.warning("Song #%d has no local file, skipping playback", song_number)

    async def playback_loop(self) -> None:
        """Continuously play songs from the queue."""
        logger.info("Playback loop waiting for first song...")

        while True:
            file_path = await self.song_queue.get()
            logger.info("Playing: %s", file_path)

            try:
                from pathlib import Path

                self.player.play(Path(file_path))
                await self.player.wait_until_done()
                logger.info("Finished playing: %s", file_path)
            except Exception as exc:
                logger.error("Playback error: %s", exc)

    async def shutdown(self) -> None:
        """Graceful shutdown: stop collector, player, close DB."""
        logger.info("Shutting down pipeline...")
        await self.collector.stop()
        self.player.stop()
        self.player.cleanup()

        if self.session_id:
            await self.db.end_session(self.session_id)

        if isinstance(self.suno_client, SunoClient):
            await self.suno_client.close()

        await self.db.close()
        logger.info("Pipeline shutdown complete")
