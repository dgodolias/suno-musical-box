import { NextResponse } from "next/server";
import { updateSongAudio } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  const apiKey = request.headers.get("x-suno-key") || process.env.SUNO_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "No Suno API key" }, { status: 500 });
  }

  const response = await fetch(
    `https://apibox.erweima.ai/api/v1/generate/record-info?taskId=${taskId}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  const data = await response.json();
  const respData = data?.data || {};
  const responseObj = respData?.response || {};
  const sunoData = responseObj?.sunoData || [];
  const status = respData?.status || "unknown";

  if (sunoData.length > 0 && sunoData[0]?.audioUrl) {
    const audioUrl = sunoData[0].audioUrl;
    const duration = sunoData[0].duration || 60;

    await updateSongAudio(taskId, audioUrl, duration);

    return NextResponse.json({
      status: "ready",
      audioUrl,
      duration,
      title: sunoData[0].title || "Musical Box",
    });
  }

  return NextResponse.json({ status });
}
