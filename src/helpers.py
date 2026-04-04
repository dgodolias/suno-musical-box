"""Pure utility functions. No state, no side effects."""

from datetime import datetime, timezone

from src.biometrics.models import BiometricAverages, BiometricReading, BiometricSnapshot


def clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp a value between min and max bounds."""
    return max(min_val, min(max_val, value))


def normalize(value: float, min_val: float, max_val: float) -> float:
    """Normalize a value to [0, 1] range given known min/max bounds."""
    if max_val == min_val:
        return 0.5
    return clamp((value - min_val) / (max_val - min_val), 0.0, 1.0)


def compute_averages(readings: list[BiometricReading]) -> BiometricAverages:
    """Compute average biometrics from a list of readings for one person."""
    hr_values = [r.heart_rate for r in readings if r.heart_rate is not None]
    spo2_values = [r.spo2 for r in readings if r.spo2 is not None]
    temp_values = [r.temperature for r in readings if r.temperature is not None]
    hrv_values = [r.hrv for r in readings if r.hrv is not None]

    return BiometricAverages(
        avg_hr=sum(hr_values) / len(hr_values) if hr_values else 70.0,
        avg_spo2=sum(spo2_values) / len(spo2_values) if spo2_values else 97.0,
        avg_temperature=sum(temp_values) / len(temp_values) if temp_values else 36.5,
        avg_hrv=sum(hrv_values) / len(hrv_values) if hrv_values else 60.0,
        sample_count=len(readings),
    )


def compute_synchrony(avg1: BiometricAverages, avg2: BiometricAverages) -> float:
    """Compute synchrony score [0-1] between two people based on HR similarity.

    1.0 = identical heart rates, 0.0 = very different (>40 bpm apart).
    """
    hr_diff = abs(avg1.avg_hr - avg2.avg_hr)
    return clamp(1.0 - hr_diff / 40.0, 0.0, 1.0)


def compute_snapshot(
    readings_p1: list[BiometricReading],
    readings_p2: list[BiometricReading],
) -> BiometricSnapshot:
    """Build a BiometricSnapshot from raw readings of both people."""
    avg1 = compute_averages(readings_p1)
    avg2 = compute_averages(readings_p2)

    combined_hr = (avg1.avg_hr + avg2.avg_hr) / 2
    combined_hrv = (avg1.avg_hrv + avg2.avg_hrv) / 2
    synchrony = compute_synchrony(avg1, avg2)

    # Arousal: high HR + low HRV = high arousal
    arousal = normalize(combined_hr, 55.0, 135.0) * 0.6 + (1.0 - normalize(combined_hrv, 15.0, 150.0)) * 0.4

    # Valence: high temp + high SpO2 + high synchrony = positive valence
    combined_temp = (avg1.avg_temperature + avg2.avg_temperature) / 2
    combined_spo2 = (avg1.avg_spo2 + avg2.avg_spo2) / 2
    valence = (
        normalize(combined_temp, 35.5, 37.5) * 0.4
        + normalize(combined_spo2, 94.0, 99.0) * 0.2
        + synchrony * 0.4
    )

    now = datetime.now(timezone.utc)
    return BiometricSnapshot(
        window_start=now,
        window_end=now,
        person1=avg1,
        person2=avg2,
        combined_arousal=round(arousal, 3),
        combined_valence=round(valence, 3),
        synchrony_score=round(synchrony, 3),
    )
