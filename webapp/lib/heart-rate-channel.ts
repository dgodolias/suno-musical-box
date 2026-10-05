// The Musical Box page sends each ring's latest heart rate to the SyncWave
// display (/syncwave), which runs in another window of the same browser.

export interface HeartRateSample {
  bpm: number;
  at: number; // when the ring measured it, ms since the epoch
}

export type LiveHeartRates = [HeartRateSample | null, HeartRateSample | null];

export type HeartRateMessage =
  | { type: "rates"; rates: LiveHeartRates }
  | { type: "hello" }; // a display that just opened asks for the current rates

export const HEART_RATE_CHANNEL = "musical-box:heart-rates";
