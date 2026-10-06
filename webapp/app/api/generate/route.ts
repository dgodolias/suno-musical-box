import { NextResponse } from "next/server";
import { insertSong } from "@/lib/db";

// A full-length song. Measured on 2026-10-06 with V6: every request costs 12
// credits whatever the length (60, 180 or 240 s, or none), 180 s songs were
// ready in about 40 s, 240 s ones in about 54 s. Without a duration V6 picks
// its own (about 3 min), despite the docs' "default 20".
const SONG_DURATION_SEC = 180;

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, prompt, style, snapshot } = body;

  if (!prompt || !style) {
    return NextResponse.json({ error: "Missing prompt or style" }, { status: 400 });
  }

  if (process.env.USE_MOCK_SUNO === "true") {
    const taskId = `mock-${crypto.randomUUID()}`;
    if (sessionId) await insertSong({
      sessionId, prompt, styleTag: style, sunoTaskId: taskId,
      audioUrl: "/api/mock-audio", durationSec: 5, biometricSnapshot: snapshot || {},
    });
    return NextResponse.json({ taskId, mock: true });
  }

  const apiKey = process.env.SUNO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "SUNO_API_KEY is not set" }, { status: 500 });
  }

  const response = await fetch("https://apibox.erweima.ai/api/v1/generate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      style,
      title: `Musical Box`,
      customMode: true,
      instrumental: true,
      model: "V6",
      duration: SONG_DURATION_SEC,
      callBackUrl: "https://example.com/callback",
    }),
  });

  const data = await response.json();
  const taskId = data?.data?.taskId;

  if (!taskId) {
    return NextResponse.json({ error: "No taskId from Suno", data }, { status: 502 });
  }

  if (sessionId) {
    await insertSong({
      sessionId,
      prompt,
      styleTag: style,
      sunoTaskId: taskId,
      audioUrl: "",
      durationSec: 0,
      biometricSnapshot: snapshot || {},
    });
  }

  return NextResponse.json({ taskId });
}
