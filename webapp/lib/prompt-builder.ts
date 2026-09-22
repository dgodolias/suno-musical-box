export const DEFAULT_STYLE = "Instrumental house with cinematic orchestral touches";

// Suno ignores `prompt` for custom-mode instrumentals, so `style` is the only
// text it reads. `prompt` records who picked what, for the DB and the player.
export function buildPrompt(
  genre1: string | null,
  genre2: string | null
): { prompt: string; style: string } {
  const picked = Array.from(new Set([genre1, genre2].filter((g): g is string => !!g)));
  const style = picked.length > 0 ? picked.join(", ") : DEFAULT_STYLE;
  const prompt = `Person 1: ${genre1 ?? "—"} · Person 2: ${genre2 ?? "—"}`;

  return { prompt, style };
}
