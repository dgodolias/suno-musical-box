import { NextResponse } from "next/server";
import type { ReadingInput } from "@/lib/db";
import { insertReadings } from "@/lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSOR_FIELDS = ["heartRate", "spo2", "temperature", "hrv", "rawPpg", "accelX", "accelY", "accelZ"] as const;

function parseReading(value: unknown): ReadingInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.sampleId !== "string" || !UUID.test(input.sampleId) ||
    (input.personId !== 1 && input.personId !== 2) ||
    typeof input.timestamp !== "number" || !Number.isSafeInteger(input.timestamp) || input.timestamp <= 0 ||
    !Number.isFinite(new Date(input.timestamp).getTime())) return null;
  const sensors = {} as Pick<ReadingInput, typeof SENSOR_FIELDS[number]>;
  for (const field of SENSOR_FIELDS) {
    const measurement = input[field];
    if (measurement !== undefined && measurement !== null &&
      (typeof measurement !== "number" || !Number.isFinite(measurement))) return null;
    sensors[field] = measurement === undefined || measurement === null ? null : measurement;
  }
  return { sampleId: input.sampleId.toLowerCase(), personId: input.personId, timestamp: input.timestamp, ...sensors };
}

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid readings body" }, { status: 400 });
  }
  const { sessionId, readings } = body as Record<string, unknown>;
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId) || sessionId <= 0 ||
    !Array.isArray(readings) || readings.length === 0 || readings.length > 1000) {
    return NextResponse.json({ error: "Invalid sessionId or readings batch" }, { status: 400 });
  }
  const parsed: ReadingInput[] = [];
  const identities = new Map<string, string>();
  for (const reading of readings) {
    const sample = parseReading(reading);
    if (!sample) return NextResponse.json({ error: "Invalid sample ID, timestamp, person, or sensor value" }, { status: 400 });
    const serialized = JSON.stringify(sample);
    const existing = identities.get(sample.sampleId);
    if (existing !== undefined && existing !== serialized) {
      return NextResponse.json({ error: "Sample ID identifies different observations" }, { status: 409 });
    }
    if (existing !== undefined) continue;
    identities.set(sample.sampleId, serialized);
    parsed.push(sample);
  }
  return NextResponse.json(await insertReadings(sessionId, parsed));
}
