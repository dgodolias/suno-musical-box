import nodemailer from "nodemailer";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Downloads the song and emails it as an MP3 attachment via Zoho SMTP. */
export async function sendSongEmail(opts: {
  to: string;
  audioUrl: string;
  title: string;
}): Promise<void> {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) throw new Error("SMTP_USER and SMTP_PASS must be set");
  if (!EMAIL_RE.test(user)) throw new Error("SMTP_USER must be an email address");

  const audioRes = await fetch(opts.audioUrl, { signal: AbortSignal.timeout(20_000) });
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
  const audio = Buffer.from(await audioRes.arrayBuffer());
  if (audio.length === 0) throw new Error("Audio download is empty");

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST?.trim() || "smtp.zoho.eu",
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });

  try {
    const result = await transport.sendMail({
      from: { name: "Athens Voice", address: user },
      to: opts.to,
      subject: "Your song from the Musical Box 🎵",
      text: "Hello!\n\nHere is the song you created at the Musical Box. You will find it attached to this email.\n\n— The Athens Voice team",
      html: "<p>Hello!</p><p>Here is the song you created at the Musical Box. You will find it attached to this email.</p><p>— The Athens Voice team</p>",
      attachments: [{ filename: `${opts.title}.mp3`, content: audio, contentType: "audio/mpeg" }],
    });
    if (result.accepted.length === 0 || result.rejected.length > 0) {
      throw new Error("Zoho did not accept the recipient");
    }
  } finally {
    transport.close();
  }
}
