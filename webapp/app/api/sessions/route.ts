import { NextResponse } from "next/server";
import { createSession, endSession } from "@/lib/db";

export async function POST(request: Request) {
  const body = await request.json();

  if (body.action === "end" && body.sessionId) {
    await endSession(body.sessionId);
    return NextResponse.json({ ok: true });
  }

  const sessionId = await createSession(body.notes || "Musical Box session");
  return NextResponse.json({ sessionId });
}
