const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";

// educoach.io is DNS-authenticated in Brevo, so this sender needs no mailbox.
const SENDER = { name: "EduCoach Musical Box", email: "musicalbox@educoach.io" };

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Downloads the song and emails it as an MP3 attachment via Brevo. Throws on failure. */
export async function sendSongEmail(opts: {
  to: string;
  audioUrl: string;
  title: string;
}): Promise<void> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error("BREVO_API_KEY is not set");

  const audioRes = await fetch(opts.audioUrl);
  if (!audioRes.ok) throw new Error(`Audio download failed: ${audioRes.status}`);
  const audio = Buffer.from(await audioRes.arrayBuffer());

  const res = await fetch(BREVO_SEND_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: SENDER,
      to: [{ email: opts.to }],
      subject: "Το τραγούδι σας από το Musical Box 🎵",
      htmlContent: `
        <p>Γεια σας!</p>
        <p>Σας στέλνουμε το τραγούδι που δημιουργήσατε στο Musical Box. Το βρίσκετε συνημμένο σε αυτό το email.</p>
        <p>— Η ομάδα του EduCoach</p>
      `,
      attachment: [{ name: `${opts.title}.mp3`, content: audio.toString("base64") }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Brevo send failed: ${res.status} ${detail.slice(0, 300)}`);
  }
}
