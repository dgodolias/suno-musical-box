// Local test tone: mock sessions never contact a music provider.
export function GET() {
  const rate = 8000;
  const samples = rate * 5;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / 400, (samples - i) / 400);
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 3000 * fade), 44 + i * 2);
  }
  return new Response(wav, { headers: { "Content-Type": "audio/wav", "Cache-Control": "public, max-age=86400" } });
}
