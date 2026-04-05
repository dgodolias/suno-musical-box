"""Pydantic models for biometric data."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, field_validator

from src.config import HR_MAX, HR_MIN, HRV_MAX, HRV_MIN, SPO2_MAX, SPO2_MIN, TEMP_MAX, TEMP_MIN


class BiometricReading(BaseModel):
    """Single biometric sample from one person."""

    person_id: Literal[1, 2]
    timestamp: datetime
    heart_rate: int | None = None
    spo2: int | None = None
    temperature: float | None = None
    hrv: int | None = None
    raw_ppg: int | None = None
    accel_x: float | None = None
    accel_y: float | None = None
    accel_z: float | None = None

    @field_validator("heart_rate", mode="before")
    @classmethod
    def clamp_hr(cls, v: int | None) -> int | None:
        if v is None:
            return v
        return max(HR_MIN, min(HR_MAX, int(v)))

    @field_validator("spo2", mode="before")
    @classmethod
    def clamp_spo2(cls, v: int | None) -> int | None:
        if v is None:
            return v
        return max(SPO2_MIN, min(SPO2_MAX, int(v)))

    @field_validator("temperature", mode="before")
    @classmethod
    def clamp_temp(cls, v: float | None) -> float | None:
        if v is None:
            return v
        return max(TEMP_MIN, min(TEMP_MAX, float(v)))

    @field_validator("hrv", mode="before")
    @classmethod
    def clamp_hrv(cls, v: int | None) -> int | None:
        if v is None:
            return v
        return max(HRV_MIN, min(HRV_MAX, int(v)))


class BiometricAverages(BaseModel):
    """Computed averages for one person over a time window."""

    avg_hr: float
    avg_spo2: float
    avg_temperature: float
    avg_hrv: float
    avg_accel_magnitude: float  # sqrt(x^2+y^2+z^2), movement intensity
    sample_count: int


class BiometricSnapshot(BaseModel):
    """Combined biometric view of both people over a time window."""

    window_start: datetime
    window_end: datetime
    person1: BiometricAverages
    person2: BiometricAverages
    combined_arousal: float  # 0-1 scale
    combined_valence: float  # 0-1 scale
    synchrony_score: float  # 0-1, how similar the two people are
    movement_intensity: float  # 0-1, how much physical movement
