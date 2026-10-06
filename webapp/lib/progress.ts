// A bar standing in for a wait of unknown length (Suno composing the song).
// Nobody knows how long it will take, so the bar reaches EXPECTED_SHARE at the
// time the wait usually takes, and the end can come anywhere around there.
// Past that it creeps on ever more slowly, never finished and never stuck a
// hair short of it: each further one and a half times the expected time
// halves what is left to 99%.
export const EXPECTED_SHARE = 80;

export function placebo(elapsedMs: number, expectedMs: number) {
  if (elapsedMs <= 0) return 0;
  if (elapsedMs <= expectedMs) return (elapsedMs / expectedMs) * EXPECTED_SHARE;
  const late = (elapsedMs - expectedMs) / (1.5 * expectedMs);
  return EXPECTED_SHARE + (99 - EXPECTED_SHARE) * (1 - 2 ** -late);
}
