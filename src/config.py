"""Constants and configuration values. No logic — only data."""

from pathlib import Path

# Biometric collection
BIOMETRIC_SAMPLE_INTERVAL_SEC: float = 1.0
BIOMETRIC_WINDOW_SEC: int = 30

# Suno API
SUNO_API_BASE_URL: str = "https://apibox.erweima.ai/api/v1/generate"
SUNO_WAIT_AUDIO: bool = True
SONG_DURATION_SEC: int = 60

# Audio
AUDIO_CACHE_DIR: Path = Path("audio_cache")
SONG_QUEUE_MAXSIZE: int = 2

# Colmi R02 BLE (future use)
COLMI_SERVICE_UUID: str = "6E40FFF0-B5A3-F393-E0A9-E50E24DCCA9E"
COLMI_RX_UUID: str = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
COLMI_TX_UUID: str = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

# Physiological ranges (for validation and mock data)
HR_MIN: int = 40
HR_MAX: int = 200
SPO2_MIN: int = 70
SPO2_MAX: int = 100
TEMP_MIN: float = 34.0
TEMP_MAX: float = 40.0
HRV_MIN: int = 15
HRV_MAX: int = 150
