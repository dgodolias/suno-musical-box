import type { NextConfig } from "next";
import { loadMockConfig } from "./lib/config-env";

const nextConfig: NextConfig = {
  // /syncwave opens the current SyncWave design; ?mock is carried along
  async redirects() {
    return [{ source: "/syncwave", destination: "/syncwave/v2", permanent: false }];
  },
};

export default async function config(): Promise<NextConfig> {
  return { ...nextConfig, env: await loadMockConfig(process.env, process.cwd()) };
}
