export interface BiometricReading {
  personId: 1 | 2;
  timestamp: number;
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  hrv: number | null;
  rawPpg: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
}

export interface BiometricAverages {
  avgHr: number;
  avgSpo2: number;
  avgTemperature: number;
  avgHrv: number;
  avgAccelMagnitude: number;
  sampleCount: number;
}

export interface BiometricSnapshot {
  person1: BiometricAverages;
  person2: BiometricAverages;
  combinedArousal: number;
  combinedValence: number;
  synchronyScore: number;
  movementIntensity: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return clamp((value - min) / (max - min), 0, 1);
}

function accelMagnitude(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

function computeHrvFromHr(readings: BiometricReading[]): number {
  const hrValues = readings
    .map((r) => r.heartRate)
    .filter((hr): hr is number => hr !== null && hr > 0);
  if (hrValues.length < 3) return 60;

  const rrIntervals = hrValues.map((hr) => 60000 / hr);
  let sumSqDiff = 0;
  for (let i = 0; i < rrIntervals.length - 1; i++) {
    const diff = rrIntervals[i + 1] - rrIntervals[i];
    sumSqDiff += diff * diff;
  }
  const rmssd = Math.sqrt(sumSqDiff / (rrIntervals.length - 1));
  return clamp(rmssd, 15, 150);
}

export function computeAverages(
  readings: BiometricReading[]
): BiometricAverages {
  const hrs = readings
    .map((r) => r.heartRate)
    .filter((v): v is number => v !== null);
  const spo2s = readings
    .map((r) => r.spo2)
    .filter((v): v is number => v !== null);
  const temps = readings
    .map((r) => r.temperature)
    .filter((v): v is number => v !== null);
  const hrvs = readings
    .map((r) => r.hrv)
    .filter((v): v is number => v !== null);
  const accels = readings
    .filter((r) => r.accelX !== null && r.accelY !== null && r.accelZ !== null)
    .map((r) => accelMagnitude(r.accelX!, r.accelY!, r.accelZ!));

  const avg = (arr: number[], fallback: number) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : fallback;

  return {
    avgHr: avg(hrs, 70),
    avgSpo2: avg(spo2s, 97),
    avgTemperature: avg(temps, 36.5),
    avgHrv: hrvs.length > 0 ? avg(hrvs, 60) : computeHrvFromHr(readings),
    avgAccelMagnitude: avg(accels, 0),
    sampleCount: readings.length,
  };
}

function computeSynchrony(
  avg1: BiometricAverages,
  avg2: BiometricAverages
): number {
  const hrDiff = Math.abs(avg1.avgHr - avg2.avgHr);
  return clamp(1 - hrDiff / 40, 0, 1);
}

export function computeSnapshot(
  readingsP1: BiometricReading[],
  readingsP2: BiometricReading[]
): BiometricSnapshot {
  const avg1 = computeAverages(readingsP1);
  const avg2 = computeAverages(readingsP2);

  const combinedHr = (avg1.avgHr + avg2.avgHr) / 2;
  const combinedHrv = (avg1.avgHrv + avg2.avgHrv) / 2;
  const synchrony = computeSynchrony(avg1, avg2);

  const combinedAccel =
    (avg1.avgAccelMagnitude + avg2.avgAccelMagnitude) / 2;
  const movement = normalize(combinedAccel, 0, 2);

  const arousal =
    normalize(combinedHr, 55, 135) * 0.4 +
    (1 - normalize(combinedHrv, 15, 150)) * 0.3 +
    movement * 0.3;

  const combinedTemp =
    (avg1.avgTemperature + avg2.avgTemperature) / 2;
  const combinedSpo2 = (avg1.avgSpo2 + avg2.avgSpo2) / 2;
  const valence =
    normalize(combinedTemp, 35.5, 37.5) * 0.4 +
    normalize(combinedSpo2, 94, 99) * 0.2 +
    synchrony * 0.4;

  return {
    person1: avg1,
    person2: avg2,
    combinedArousal: Math.round(arousal * 1000) / 1000,
    combinedValence: Math.round(valence * 1000) / 1000,
    synchronyScore: Math.round(synchrony * 1000) / 1000,
    movementIntensity: Math.round(movement * 1000) / 1000,
  };
}
