// The Musical Box page sends each ring's latest heart rate to the SyncWave
// display (/syncwave), which runs in another window of the same browser.

export interface HeartRateSample {
  bpm: number;
  at: number; // when the ring measured it, ms since the epoch
}

export type LiveHeartRates = [HeartRateSample | null, HeartRateSample | null];

// The wait the display shows a bar for: when the session began and how long
// after that the song usually comes (from the page's timings, see placebo())
export interface SessionPlan {
  startedAt: number;
  expectedMs: number;
}

export type HeartRateMessage =
  // `plan` while a song is on its way; `song` once it is ready, until a new
  // session begins
  | { type: "rates"; rates: LiveHeartRates; plan: SessionPlan | null; song: boolean }
  | { type: "hello" }; // a display that just opened asks for the current rates

export const HEART_RATE_CHANNEL = "musical-box:heart-rates";
