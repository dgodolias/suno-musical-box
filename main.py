"""Suno Musical Box — Entry point."""

import asyncio
import logging
import os
import selectors
import sys

from dotenv import load_dotenv

from src.biometrics.mock_collector import MockCollector
from src.core.audio_player import AudioPlayer
from src.core.database import Database
from src.core.pipeline import Pipeline
from src.music.suno_client import MockSunoClient, SunoClient


def main() -> None:
    load_dotenv()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    db = Database(dsn=os.environ["DATABASE_URL"])
    collector = MockCollector(db=db)
    player = AudioPlayer()

    use_mock = os.getenv("USE_MOCK_SUNO", "true").lower() == "true"
    if use_mock:
        suno_client: MockSunoClient | SunoClient = MockSunoClient(delay_sec=3.0)
    else:
        suno_client = SunoClient(api_key=os.environ["SUNO_API_KEY"])

    pipeline = Pipeline(db=db, collector=collector, suno_client=suno_client, player=player)

    # Windows requires SelectorEventLoop for psycopg async
    if sys.platform == "win32":
        selector = selectors.SelectSelector()
        loop = asyncio.SelectorEventLoop(selector)
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(pipeline.run())
        finally:
            loop.close()
    else:
        asyncio.run(pipeline.run())


if __name__ == "__main__":
    main()
