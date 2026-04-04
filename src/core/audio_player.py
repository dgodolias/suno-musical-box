"""Audio playback using pygame.mixer."""

import asyncio
import logging
from pathlib import Path

import pygame

logger = logging.getLogger(__name__)


class AudioPlayer:
    """Simple MP3 player wrapping pygame.mixer."""

    def __init__(self) -> None:
        pygame.mixer.init(frequency=44100)
        logger.info("Audio player initialized")

    def play(self, file_path: Path) -> None:
        """Load and start playing an MP3 file (non-blocking)."""
        pygame.mixer.music.load(str(file_path))
        pygame.mixer.music.play()
        logger.info("Playing: %s", file_path)

    async def wait_until_done(self) -> None:
        """Async wait until the current track finishes playing."""
        while pygame.mixer.music.get_busy():
            await asyncio.sleep(0.5)

    def stop(self) -> None:
        """Stop current playback."""
        pygame.mixer.music.stop()
        logger.info("Playback stopped")

    def is_playing(self) -> bool:
        return pygame.mixer.music.get_busy()

    def cleanup(self) -> None:
        pygame.mixer.quit()
        logger.info("Audio player cleaned up")
