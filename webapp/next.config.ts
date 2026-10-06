import type { NextConfig } from "next";
import { loadMockConfig } from "./lib/config-env";

const nextConfig: NextConfig = {
  // There used to be several SyncWave designs at /syncwave/v1-v3; old links
  // open the one that is left, keeping ?mock
  async redirects() {
    return [{ source: "/syncwave/:version(v1|v2|v3)", destination: "/syncwave", permanent: false }];
  },
};

export default async function config(): Promise<NextConfig> {
  return { ...nextConfig, env: await loadMockConfig(process.env, process.cwd()) };
}
