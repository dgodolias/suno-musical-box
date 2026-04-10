/**
 * Real-time signal processing for biometric data.
 * Smoothing, HRV computation, outlier rejection.
 */

const HR_BUFFER_SIZE = 10;
const HRV_WINDOW_SIZE = 15;

export interface ProcessedMetrics {
  heartRate: number | null;
  heartRateRaw: number | null;
  spo2: number | null;
  hrv: number | null;
  rawPpg: number | null;
  signalQuality: "good" | "weak" | "none";
}

export class SignalProcessor {
  private hrBuffer: number[] = [];
  private hrTimestamps: number[] = [];
  private spo2Buffer: number[] = [];
  private ppgBuffer: number[] = [];
  private lastProcessed: ProcessedMetrics = {
    heartRate: null,
    heartRateRaw: null,
    spo2: null,
    hrv: null,
    rawPpg: null,
    signalQuality: "none",
  };

  addHeartRate(value: number): void {
    const now = Date.now();
    this.hrBuffer.push(value);
    this.hrTimestamps.push(now);

    // Keep buffer bounded
    if (this.hrBuffer.length > HR_BUFFER_SIZE) {
      this.hrBuffer.shift();
      this.hrTimestamps.shift();
    }
  }

  addSpo2(value: number): void {
    this.spo2Buffer.push(value);
    if (this.spo2Buffer.length > 5) this.spo2Buffer.shift();
  }

  addRawPpg(value: number): void {
    this.ppgBuffer.push(value);
    if (this.ppgBuffer.length > 50) this.ppgBuffer.shift();
  }

  getProcessed(): ProcessedMetrics {
    const hr = this.getSmoothedHR();
    const hrv = this.computeHRV();
    const spo2 = this.getSmoothedSpO2();
    const rawPpg = this.ppgBuffer.length > 0 ? this.ppgBuffer[this.ppgBuffer.length - 1] : null;

    let signalQuality: "good" | "weak" | "none" = "none";
    if (hr !== null) {
      signalQuality = this.hrBuffer.length >= 5 ? "good" : "weak";
    }

    this.lastProcessed = {
      heartRate: hr,
      heartRateRaw: this.hrBuffer.length > 0 ? this.hrBuffer[this.hrBuffer.length - 1] : null,
      spo2,
      hrv,
      rawPpg,
      signalQuality,
    };

    return this.lastProcessed;
  }

  private getSmoothedHR(): number | null {
    if (this.hrBuffer.length === 0) return null;
    if (this.hrBuffer.length < 3) return this.hrBuffer[this.hrBuffer.length - 1];

    // Median filter: take last 5 values, return median
    const recent = this.hrBuffer.slice(-5);
    const sorted = [...recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private getSmoothedSpO2(): number | null {
    if (this.spo2Buffer.length === 0) return null;
    // Simple average for SpO2 (less noisy than HR)
    return Math.round(this.spo2Buffer.reduce((a, b) => a + b, 0) / this.spo2Buffer.length);
  }

  computeHRV(): number | null {
    // Need at least 5 HR readings with timestamps to compute HRV
    if (this.hrBuffer.length < 5) return null;

    // Convert BPM readings to RR intervals (ms)
    const rrIntervals: number[] = [];
    for (let i = 0; i < this.hrBuffer.length; i++) {
      if (this.hrBuffer[i] > 0) {
        rrIntervals.push(60000 / this.hrBuffer[i]);
      }
    }

    if (rrIntervals.length < 4) return null;

    // RMSSD: root mean square of successive differences
    let sumSqDiff = 0;
    let count = 0;
    for (let i = 1; i < rrIntervals.length; i++) {
      const diff = rrIntervals[i] - rrIntervals[i - 1];
      sumSqDiff += diff * diff;
      count++;
    }

    if (count === 0) return null;
    const rmssd = Math.sqrt(sumSqDiff / count);
    return Math.round(Math.max(5, Math.min(200, rmssd)));
  }

  reset(): void {
    this.hrBuffer = [];
    this.hrTimestamps = [];
    this.spo2Buffer = [];
    this.ppgBuffer = [];
  }
}
