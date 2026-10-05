import { NextResponse } from "next/server";
import { createSession, endSession } from "@/lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 &&
    Number.isFinite(new Date(value).getTime());
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid session body" }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (typeof input.clientSessionId !== "string" || !UUID.test(input.clientSessionId)) {
    return NextResponse.json({ error: "Invalid clientSessionId" }, { status: 400 });
  }
  const clientSessionId = input.clientSessionId.toLowerCase();

  if (input.action === "end") {
    if (typeof input.sessionId !== "number" || !Number.isSafeInteger(input.sessionId) ||
      input.sessionId <= 0 || !validTimestamp(input.endedAt)) {
      return NextResponse.json({ error: "Invalid sessionId or endedAt" }, { status: 400 });
    }
    const ended = await endSession(input.sessionId, clientSessionId, input.endedAt);
    return ended
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "Session identity mismatch or end precedes start" }, { status: 409 });
  }

  if ((input.action !== undefined && input.action !== "create") || !validTimestamp(input.startedAt) ||
    (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 10_000))) {
    return NextResponse.json({ error: "Invalid session start, action, or notes" }, { status: 400 });
  }
  const sessionId = await createSession(clientSessionId, input.startedAt, input.notes as string | undefined);
  return NextResponse.json({ sessionId, clientSessionId });
}
