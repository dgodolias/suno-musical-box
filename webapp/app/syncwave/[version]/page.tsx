import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SyncWave from "@/components/syncwave";
import { getReplay } from "@/lib/db";

export const metadata: Metadata = {
  title: "SyncWave",
  description: "Live heartbeat waves from the Musical Box rings",
};

// /syncwave/v1, /v2 and /v3 are the designs; /syncwave redirects to the
// current one (next.config.ts)
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ version: "v1" }, { version: "v2" }, { version: "v3" }];
}

// Without rings: ?mock replays the latest recorded session with both people,
// ?mock=<session id> a chosen one
export default async function SyncWavePage({
  params,
  searchParams,
}: {
  params: Promise<{ version: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { version } = await params;
  if (version !== "v1" && version !== "v2" && version !== "v3") notFound();
  const { mock } = await searchParams;
  if (typeof mock !== "string") return <SyncWave version={version} />;
  const replay = await getReplay(Number(mock) || undefined).catch(() => null);
  return <SyncWave version={version} replay={replay} />;
}
