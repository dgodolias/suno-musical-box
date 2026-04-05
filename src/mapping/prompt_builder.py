"""Translate biometric snapshots into Suno text prompts.

Each function maps a normalized biometric dimension to a musical description.
The final build_prompt() composes them into a coherent prompt + style tag.
"""

from src.biometrics.models import BiometricSnapshot
from src.helpers import normalize


def map_tempo(arousal: float) -> str:
    """Map arousal [0-1] to tempo/energy description."""
    if arousal < 0.25:
        return "very slow and meditative"
    if arousal < 0.45:
        return "gentle and flowing"
    if arousal < 0.65:
        return "moderate groove with steady rhythm"
    if arousal < 0.85:
        return "upbeat and lively"
    return "fast-paced and energetic"


def map_genre(arousal: float, valence: float) -> str:
    """Map arousal + valence to a genre/style tag."""
    if arousal < 0.3:
        if valence > 0.6:
            return "ambient electronic"
        return "dark ambient"
    if arousal < 0.5:
        if valence > 0.6:
            return "indie folk"
        return "downtempo trip-hop"
    if arousal < 0.7:
        if valence > 0.6:
            return "jazz fusion"
        return "alternative rock"
    if valence > 0.6:
        return "electronic pop"
    return "industrial electronic"


def map_mood(valence: float) -> str:
    """Map valence [0-1] to mood/tonality description."""
    if valence < 0.25:
        return "dark and melancholic minor key"
    if valence < 0.45:
        return "contemplative and bittersweet"
    if valence < 0.65:
        return "balanced between light and shadow"
    if valence < 0.85:
        return "warm and hopeful"
    return "bright uplifting major key, joyful"


def map_instruments(spo2_norm: float, temp_norm: float) -> str:
    """Map SpO2 + temperature to instrument/timbre description."""
    brightness = (spo2_norm + temp_norm) / 2

    if brightness < 0.3:
        return "deep cello and dark synth pads"
    if brightness < 0.5:
        return "piano and soft strings"
    if brightness < 0.7:
        return "acoustic guitar and warm brass"
    return "bright synths and sparkling keys"


def map_harmony(synchrony: float) -> str:
    """Map synchrony score [0-1] to harmony/interaction description."""
    if synchrony < 0.3:
        return "contrasting call-and-response between two distinct voices"
    if synchrony < 0.6:
        return "complementary dialogue weaving together"
    return "intimate harmonious duet with intertwining melodies"


def map_complexity(hrv_norm: float) -> str:
    """Map HRV (normalized) to musical complexity description."""
    if hrv_norm < 0.3:
        return "simple repetitive hypnotic patterns"
    if hrv_norm < 0.6:
        return "moderately evolving phrases"
    return "complex layered evolving progressions"


def map_rhythm(movement: float) -> str:
    """Map movement intensity [0-1] to rhythmic texture description."""
    if movement < 0.2:
        return "still and spacious with minimal percussion"
    if movement < 0.4:
        return "gentle subtle rhythmic pulse"
    if movement < 0.6:
        return "steady grooving rhythm"
    if movement < 0.8:
        return "driving percussive beat"
    return "intense pounding rhythm with powerful drums"


def build_prompt(snapshot: BiometricSnapshot) -> tuple[str, str]:
    """Build a Suno prompt + style tag from a biometric snapshot.

    Returns:
        Tuple of (prompt_text, style_tag).
    """
    arousal = snapshot.combined_arousal
    valence = snapshot.combined_valence
    synchrony = snapshot.synchrony_score

    avg_spo2 = (snapshot.person1.avg_spo2 + snapshot.person2.avg_spo2) / 2
    avg_temp = (snapshot.person1.avg_temperature + snapshot.person2.avg_temperature) / 2
    avg_hrv = (snapshot.person1.avg_hrv + snapshot.person2.avg_hrv) / 2

    spo2_norm = normalize(avg_spo2, 94.0, 99.0)
    temp_norm = normalize(avg_temp, 35.5, 37.5)
    hrv_norm = normalize(avg_hrv, 15.0, 150.0)

    movement = snapshot.movement_intensity

    genre = map_genre(arousal, valence)
    tempo = map_tempo(arousal)
    mood = map_mood(valence)
    instruments = map_instruments(spo2_norm, temp_norm)
    harmony = map_harmony(synchrony)
    complexity = map_complexity(hrv_norm)
    rhythm = map_rhythm(movement)

    prompt = (
        f"A {genre} instrumental song that is {tempo}. "
        f"{mood.capitalize()}. "
        f"{instruments.capitalize()}. "
        f"{harmony.capitalize()}. "
        f"{complexity.capitalize()}. "
        f"{rhythm.capitalize()}."
    )

    return prompt, genre
