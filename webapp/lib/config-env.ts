import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Only these non-secret flags are bundled into both browser and server code.
export async function loadMockConfig(env: NodeJS.ProcessEnv, directory: string) {
  let root: Record<string, string | undefined> = {};
  if (!env.VERCEL) {
    try {
      root = parseEnv(await readFile(resolve(directory, "../.env"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const flag = (name: string) => {
    const value = (env[name] ?? root[name] ?? "false").trim().toLowerCase();
    if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
    return value;
  };
  return {
    USE_MOCK_SUNO: flag("USE_MOCK_SUNO"),
    USE_MOCK_BIOMETRICS: flag("USE_MOCK_BIOMETRICS"),
  };
}
