import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // /syncwave opens the current SyncWave design; ?mock is carried along
  async redirects() {
    return [{ source: "/syncwave", destination: "/syncwave/v2", permanent: false }];
  },
};

export default nextConfig;
