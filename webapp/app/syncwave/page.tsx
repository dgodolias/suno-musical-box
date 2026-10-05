import type { Metadata } from "next";
import SyncWave from "@/components/syncwave";
import { getReplay } from "@/lib/db";

export const metadata: Metadata = {
  title: "SyncWave",
  description: "Live heartbeat waves from the Musical Box rings",
};

// Preview without rings (dev only): /syncwave?mock replays the latest recorded
// session with both people, /syncwave?mock=<session id> a chosen one
export default async function SyncWavePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (process.env.NODE_ENV === "production") return <SyncWave />;
  const { mock } = await searchParams;
  if (typeof mock !== "string") return <SyncWave />;
  const replay = await getReplay(Number(mock) || undefined).catch(() => null);
  return <SyncWave replay={replay} />;
}
