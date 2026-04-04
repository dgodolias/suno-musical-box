"""Protocol (interface) for biometric collectors."""

from typing import Protocol

from src.biometrics.models import BiometricReading


class BiometricCollector(Protocol):
    """Abstract interface for biometric data sources.

    Both MockCollector and RingCollector conform to this protocol.
    """

    async def start(self, session_id: int) -> None:
        """Start collecting biometric data for a session."""
        ...

    async def stop(self) -> None:
        """Stop collecting and clean up resources."""
        ...

    async def get_latest_readings(self, window_sec: int) -> list[BiometricReading]:
        """Return readings from the last N seconds for both people."""
        ...
