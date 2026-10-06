import { NextResponse } from "next/server";
import { updateSongAudio } from "@/lib/db";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const { taskId } = await params;
  if (/^mock-[0-9a-f-]{36}$/.test(taskId)) {
    return NextResponse.json({ status: "ready", audioUrl: "/api/mock-audio", duration: 5, title: "Mock audio (test tone)", mock: true });
  }
  if (process.env.USE_MOCK_SUNO === "true") {
    return NextResponse.json({ error: "Live Suno polling is disabled in mock mode" }, { status: 423 });
  }
  const apiKey = process.env.SUNO_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: "SUNO_API_KEY is not set" }, { status: 500 });
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
