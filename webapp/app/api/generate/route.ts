import { NextResponse } from "next/server";
import { insertSong } from "@/lib/db";

// V6 defaults to 20s clips when duration is omitted
const SONG_DURATION_SEC = 60;

export async function POST(request: Request) {
  const body = await request.json();
  const { sessionId, prompt, style, snapshot } = body;

  if (!prompt || !style) {
    return NextResponse.json({ error: "Missing prompt or style" }, { status: 400 });
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
