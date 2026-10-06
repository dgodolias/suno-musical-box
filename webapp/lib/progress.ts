// A bar standing in for a wait of unknown length (Suno composing the song).
// Nobody knows how long it will take, so the bar moves at a steady pace for
// most of the time the wait usually takes, then slows down smoothly, with no
// sudden change: about 82% at the expected time, 89% at one and a half times
// it and 94% at two and a half, still moving, never finished.
const STEADY_UNTIL = 0.7; // share of the expected time at a steady pace
const PACE = 95; // % per expected time while steady

export function placebo(elapsedMs: number, expectedMs: number) {
  if (elapsedMs <= 0) return 0;
  const x = elapsedMs / expectedMs;
  if (x <= STEADY_UNTIL) return PACE * x;
  // After the bend, what is left to 99% shrinks like 1 / (1 + k·t): at the
  // steady pace to begin with, then ever slower, never stopping
  const bend = PACE * STEADY_UNTIL;
  const left = 99 - bend;
  return 99 - left / (1 + (PACE / left) * (x - STEADY_UNTIL));
}
