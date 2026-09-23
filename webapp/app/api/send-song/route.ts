import { NextResponse } from "next/server";
import { getSongAudioUrl } from "@/lib/db";
import { EMAIL_RE, sendSongEmail } from "@/lib/email";

export async function POST(request: Request) {
  const { taskId, email } = await request.json();

  if (typeof taskId !== "string" || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: "Invalid taskId or email" }, { status: 400 });
  }

  // The audio comes from our own DB row (the clip the UI played), never from a
  // client-supplied URL, so this route can't be used to mail arbitrary files.
  const audioUrl = await getSongAudioUrl(taskId);
  if (!audioUrl) {
    return NextResponse.json({ error: "Song not found" }, { status: 404 });
  }

  try {
    await sendSongEmail({ to: email.trim(), audioUrl, title: "Musical Box" });
  } catch (err) {
    console.error("send-song failed:", err);
    return NextResponse.json({ error: "Email could not be sent" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
