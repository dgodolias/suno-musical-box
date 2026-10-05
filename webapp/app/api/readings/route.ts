import { NextResponse } from "next/server";
import type { ReadingInput } from "@/lib/db";
import { insertReadings } from "@/lib/db";

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, readings } = body as {
    sessionId: number;
    readings: ReadingInput[];
  };

  if (
    !Number.isSafeInteger(sessionId) || sessionId <= 0 ||
    !Array.isArray(readings) || readings.length === 0 || readings.length > 1000
  ) {
    return NextResponse.json({ error: "Invalid sessionId or readings batch" }, { status: 400 });
  }

  if (readings.some((reading) => !reading ||
    (reading.personId !== 1 && reading.personId !== 2) ||
    !Number.isFinite(reading.timestamp) || reading.timestamp <= 0 ||
    !Number.isFinite(new Date(reading.timestamp).getTime())
  )) {
    return NextResponse.json({ error: "Invalid personId or measurement timestamp" }, { status: 400 });
  }

  const count = await insertReadings(sessionId, readings);
  return NextResponse.json({ count });
}
