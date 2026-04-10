import { NextResponse } from "next/server";
import { insertReadings, type ReadingInput } from "@/lib/db";

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, readings } = body as {
    sessionId: number;
    readings: ReadingInput[];
  };

  if (!sessionId || !readings?.length) {
    return NextResponse.json({ error: "Missing sessionId or readings" }, { status: 400 });
  }

  const count = await insertReadings(sessionId, readings);
  return NextResponse.json({ count });
}
