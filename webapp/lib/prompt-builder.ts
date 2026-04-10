import { type BiometricSnapshot } from "./biometrics";

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function mapTempo(arousal: number): string {
  if (arousal < 0.25) return "very slow and meditative";
  if (arousal < 0.45) return "gentle and flowing";
  if (arousal < 0.65) return "moderate groove with steady rhythm";
  if (arousal < 0.85) return "upbeat and lively";
  return "fast-paced and energetic";
}

function mapGenre(arousal: number, valence: number): string {
  if (arousal < 0.3) return valence > 0.6 ? "ambient electronic" : "dark ambient";
  if (arousal < 0.5) return valence > 0.6 ? "indie folk" : "downtempo trip-hop";
  if (arousal < 0.7) return valence > 0.6 ? "jazz fusion" : "alternative rock";
  return valence > 0.6 ? "electronic pop" : "industrial electronic";
}

function mapMood(valence: number): string {
  if (valence < 0.25) return "dark and melancholic minor key";
  if (valence < 0.45) return "contemplative and bittersweet";
  if (valence < 0.65) return "balanced between light and shadow";
  if (valence < 0.85) return "warm and hopeful";
  return "bright uplifting major key, joyful";
}

function mapInstruments(spo2Norm: number, tempNorm: number): string {
  const brightness = (spo2Norm + tempNorm) / 2;
  if (brightness < 0.3) return "deep cello and dark synth pads";
  if (brightness < 0.5) return "piano and soft strings";
  if (brightness < 0.7) return "acoustic guitar and warm brass";
  return "bright synths and sparkling keys";
}

function mapHarmony(synchrony: number): string {
  if (synchrony < 0.3)
    return "contrasting call-and-response between two distinct voices";
  if (synchrony < 0.6) return "complementary dialogue weaving together";
  return "intimate harmonious duet with intertwining melodies";
}

function mapComplexity(hrvNorm: number): string {
  if (hrvNorm < 0.3) return "simple repetitive hypnotic patterns";
  if (hrvNorm < 0.6) return "moderately evolving phrases";
  return "complex layered evolving progressions";
}

function mapRhythm(movement: number): string {
  if (movement < 0.2) return "still and spacious with minimal percussion";
  if (movement < 0.4) return "gentle subtle rhythmic pulse";
  if (movement < 0.6) return "steady grooving rhythm";
  if (movement < 0.8) return "driving percussive beat";
  return "intense pounding rhythm with powerful drums";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildPrompt(
  snapshot: BiometricSnapshot
): { prompt: string; style: string } {
  const { combinedArousal: arousal, combinedValence: valence, synchronyScore: synchrony, movementIntensity: movement } = snapshot;

  const avgSpo2 = (snapshot.person1.avgSpo2 + snapshot.person2.avgSpo2) / 2;
  const avgTemp = (snapshot.person1.avgTemperature + snapshot.person2.avgTemperature) / 2;
  const avgHrv = (snapshot.person1.avgHrv + snapshot.person2.avgHrv) / 2;

  const spo2Norm = normalize(avgSpo2, 94, 99);
  const tempNorm = normalize(avgTemp, 35.5, 37.5);
  const hrvNorm = normalize(avgHrv, 15, 150);

  const genre = mapGenre(arousal, valence);
  const tempo = mapTempo(arousal);
  const mood = mapMood(valence);
  const instruments = mapInstruments(spo2Norm, tempNorm);
  const harmony = mapHarmony(synchrony);
  const complexity = mapComplexity(hrvNorm);
  const rhythm = mapRhythm(movement);

  const prompt = `A ${genre} instrumental song that is ${tempo}. ${capitalize(mood)}. ${capitalize(instruments)}. ${capitalize(harmony)}. ${capitalize(complexity)}. ${capitalize(rhythm)}.`;

  return { prompt, style: genre };
}
