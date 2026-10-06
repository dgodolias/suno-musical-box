import type { Metadata } from "next";
import SyncWave from "@/components/syncwave";
import { getReplay } from "@/lib/db";

export const metadata: Metadata = {
  title: "SyncWave",
  description: "Live heartbeat waves from the Musical Box rings",
};

// Without rings: ?mock replays the latest recorded session with both people,
// ?mock=<session id> a chosen one; with &song the song arrives a little later
export default async function SyncWavePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { mock, song } = await searchParams;
  if (typeof mock !== "string") return <SyncWave />;
  const replay = await getReplay(Number(mock) || undefined).catch(() => null);
  return <SyncWave replay={replay} song={song !== undefined} />;
}
