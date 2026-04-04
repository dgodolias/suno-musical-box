"""Suno API client — supports both real API and mock mode.

Real mode uses the Suno API via httpx.
Mock mode returns a sample MP3 after a configurable delay (saves credits).
"""

import asyncio
import logging
import shutil
from pathlib import Path

import httpx

from src.config import AUDIO_CACHE_DIR
from src.music.models import GeneratedSong

logger = logging.getLogger(__name__)


class MockSunoClient:
    """Returns a sample MP3 after a short delay. No API calls, no credits used."""

    def __init__(self, delay_sec: float = 3.0) -> None:
        self.delay_sec = delay_sec
        self.call_count = 0

    async def generate(self, prompt: str, style: str) -> GeneratedSong:
        logger.info("[MOCK SUNO] Generating song (%.1fs delay)...", self.delay_sec)
        logger.info("[MOCK SUNO] Prompt: %s", prompt)
        logger.info("[MOCK SUNO] Style: %s", style)

        await asyncio.sleep(self.delay_sec)

        self.call_count += 1
        sample_path = Path("tests/fixtures/sample.wav")

        if sample_path.exists():
            dest = AUDIO_CACHE_DIR / f"mock_song_{self.call_count}.wav"
            AUDIO_CACHE_DIR.mkdir(exist_ok=True)
            shutil.copy(sample_path, dest)
            logger.info("[MOCK SUNO] Song ready: %s", dest)
            return GeneratedSong(
                suno_id=f"mock_{self.call_count}",
                local_path=dest,
                prompt=prompt,
                style=style,
                duration_sec=60.0,
            )

        logger.warning("[MOCK SUNO] No sample.wav found at %s — returning empty song", sample_path)
        return GeneratedSong(
            suno_id=f"mock_{self.call_count}",
            prompt=prompt,
            style=style,
        )


class SunoClient:
    """Real Suno API client using httpx.

    Uses the unofficial Suno API (apibox.erweima.ai style) with API key auth.
    """

    def __init__(self, api_key: str, base_url: str = "https://apibox.erweima.ai") -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.client = httpx.AsyncClient(timeout=120.0)
        self.call_count = 0

    async def generate(self, prompt: str, style: str) -> GeneratedSong:
        """Generate a song via Suno API and download the audio file."""
        logger.info("[SUNO] Requesting song generation...")
        logger.info("[SUNO] Prompt: %s", prompt)
        logger.info("[SUNO] Style: %s", style)

        # Step 1: Submit generation request
        response = await self.client.post(
            f"{self.base_url}/api/v1/generate",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            json={
                "prompt": prompt,
                "style": style,
                "title": f"Musical Box #{self.call_count + 1}",
                "customMode": True,
                "instrumental": True,
                "wait_audio": False,
            },
        )
        response.raise_for_status()
        data = response.json()
        logger.info("[SUNO] Generation submitted: %s", data)

        task_id = data.get("data", {}).get("taskId", "")
        if not task_id:
            logger.error("[SUNO] No taskId in response: %s", data)
            return GeneratedSong(prompt=prompt, style=style)

        # Step 2: Poll for completion
        audio_url = await self.poll_for_audio(task_id)
        if not audio_url:
            return GeneratedSong(suno_id=task_id, prompt=prompt, style=style)

        # Step 3: Download audio
        self.call_count += 1
        local_path = await self.download_audio(audio_url, self.call_count)

        return GeneratedSong(
            suno_id=task_id,
            audio_url=audio_url,
            local_path=local_path,
            prompt=prompt,
            style=style,
            duration_sec=60.0,
        )

    async def poll_for_audio(
        self,
        task_id: str,
        max_attempts: int = 60,
        interval_sec: float = 5.0,
    ) -> str:
        """Poll the API until the song is ready or timeout."""
        for attempt in range(max_attempts):
            await asyncio.sleep(interval_sec)

            response = await self.client.get(
                f"{self.base_url}/api/v1/generate/record-info",
                headers={"Authorization": f"Bearer {self.api_key}"},
                params={"taskId": task_id},
            )
            response.raise_for_status()
            data = response.json()

            records = data.get("data", {}).get("response", {}).get("sunoData", [])
            if records and records[0].get("audioUrl"):
                audio_url = records[0]["audioUrl"]
                logger.info("[SUNO] Song ready after %d polls: %s", attempt + 1, audio_url)
                return audio_url

            status = data.get("data", {}).get("status", "unknown")
            logger.info("[SUNO] Poll %d/%d — status: %s", attempt + 1, max_attempts, status)

        logger.error("[SUNO] Timeout after %d polls for task %s", max_attempts, task_id)
        return ""

    async def download_audio(self, audio_url: str, song_number: int) -> Path:
        """Download an MP3 from URL to audio_cache/."""
        AUDIO_CACHE_DIR.mkdir(exist_ok=True)
        dest = AUDIO_CACHE_DIR / f"song_{song_number}.mp3"

        response = await self.client.get(audio_url)
        response.raise_for_status()
        dest.write_bytes(response.content)

        logger.info("[SUNO] Downloaded: %s (%.1f KB)", dest, len(response.content) / 1024)
        return dest

    async def close(self) -> None:
        await self.client.aclose()
