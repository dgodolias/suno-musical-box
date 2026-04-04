"""Mock biometric collector — generates realistic fake data for 2 people.

Data is physiologically plausible with correlation between the two people
(simulating hand-holding / shared emotional state).
"""

import asyncio
import logging
import math
import random
from collections import deque
from datetime import datetime, timezone

import numpy as np

from src.biometrics.models import BiometricReading
from src.config import BIOMETRIC_SAMPLE_INTERVAL_SEC
from src.core.database import Database

logger = logging.getLogger(__name__)


class MockCollector:
    """Generates realistic correlated biometric data for 2 people."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.session_id: int = 0
        self.buffer: deque[BiometricReading] = deque(maxlen=300)
        self.task: asyncio.Task[None] | None = None
        self.running: bool = False
        self.start_time: float = 0.0
        self.rng = np.random.default_rng()
        self.next_event_time: float = 0.0
        self.event_magnitude: float = 0.0
        self.event_start: float = 0.0

    async def start(self, session_id: int) -> None:
        self.session_id = session_id
        self.running = True
        self.start_time = asyncio.get_event_loop().time()
        self.next_event_time = self.start_time + random.uniform(60, 120)
        self.task = asyncio.create_task(self.collection_loop())
        logger.info("Mock collector started for session %d", session_id)

    async def stop(self) -> None:
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info("Mock collector stopped")

    async def get_latest_readings(self, window_sec: int) -> list[BiometricReading]:
        """Return buffered readings from the last N seconds."""
        now = datetime.now(timezone.utc)
        cutoff = now.timestamp() - window_sec
        return [r for r in self.buffer if r.timestamp.timestamp() >= cutoff]

    async def collection_loop(self) -> None:
        """Main loop: generate readings at 1Hz and write to DB."""
        while self.running:
            now_loop = asyncio.get_event_loop().time()
            t = now_loop - self.start_time
            now_utc = datetime.now(timezone.utc)

            event_spike = self.compute_event_spike(now_loop, t)

            reading_p1 = self.generate_person1(t, now_utc, event_spike)
            reading_p2 = self.generate_person2(t, now_utc, reading_p1.heart_rate or 70, event_spike)

            self.buffer.append(reading_p1)
            self.buffer.append(reading_p2)

            await self.db.insert_readings_batch(self.session_id, [reading_p1, reading_p2])

            await asyncio.sleep(BIOMETRIC_SAMPLE_INTERVAL_SEC)

    def compute_event_spike(self, now_loop: float, t: float) -> float:
        """Compute excitement event spike (shared between both people).

        Events happen every 60-120s, spike HR by 15-30bpm with exponential decay.
        """
        if now_loop >= self.next_event_time:
            self.event_magnitude = random.uniform(15, 30)
            self.event_start = t
            self.next_event_time = now_loop + random.uniform(60, 120)
            logger.debug("Excitement event! magnitude=%.1f bpm", self.event_magnitude)

        if self.event_magnitude > 0:
            elapsed = t - self.event_start
            spike = self.event_magnitude * math.exp(-elapsed / 10.0)
            if spike < 1.0:
                self.event_magnitude = 0.0
                return 0.0
            return spike
        return 0.0

    def generate_person1(
        self,
        t: float,
        now: datetime,
        event_spike: float,
    ) -> BiometricReading:
        """Generate biometric reading for person 1 (independent base signals)."""
        hr = 70 + 15 * math.sin(t / 60) + self.rng.normal(0, 3) + event_spike
        hrv = 120 - 0.8 * (hr - 60) + self.rng.normal(0, 5)
        spo2 = 97 + self.rng.normal(0, 0.8)
        temp = 36.2 + 0.3 * math.sin(t / 300) + self.rng.normal(0, 0.1)

        return BiometricReading(
            person_id=1,
            timestamp=now,
            heart_rate=int(round(hr)),
            spo2=int(round(spo2)),
            temperature=round(float(temp), 1),
            hrv=int(round(hrv)),
        )

    def generate_person2(
        self,
        t: float,
        now: datetime,
        p1_hr: int,
        event_spike: float,
    ) -> BiometricReading:
        """Generate biometric reading for person 2 (correlated with person 1).

        ~0.6 correlation with person 1's HR (hand-holding effect).
        """
        own_base = 75 + 12 * math.sin(t / 45 + 1.2)
        hr = 0.6 * p1_hr + 0.4 * own_base + self.rng.normal(0, 4) + event_spike * 0.8
        hrv = 110 - 0.7 * (hr - 60) + self.rng.normal(0, 6)
        spo2 = 97.5 + self.rng.normal(0, 0.7)
        temp = 36.4 + 0.25 * math.sin(t / 280 + 0.5) + self.rng.normal(0, 0.12)

        return BiometricReading(
            person_id=2,
            timestamp=now,
            heart_rate=int(round(hr)),
            spo2=int(round(spo2)),
            temperature=round(float(temp), 1),
            hrv=int(round(hrv)),
        )
