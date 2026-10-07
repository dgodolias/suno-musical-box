import nodemailer from "nodemailer";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Downloads the song and emails it as an MP3 attachment via Zoho SMTP, with
 * Athens Voice's copy for "Πιαστείτε στα χέρια". */
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
      subject: "Η μουσική σας από το «Πιαστείτε στα χέρια» 🎵",
      text: [
        "Μόλις δημιουργήσατε κάτι που δεν υπήρχε πριν.",
        "",
        "Δύο άνθρωποι.",
        "Μία επαφή.",
        "Ένα μοναδικό μουσικό αποτέλεσμα.",
        "",
        "Αυτή είναι η μουσική που δημιουργήθηκε τη στιγμή που πιαστήκατε στα χέρια.",
        "",
        "Άκουσέ την ξανά εδώ:",
        opts.audioUrl,
        "(και στο συνημμένο αρχείο)",
        "",
        "ΠΙΑΣΤΕΙΤΕ ΣΤΑ ΧΕΡΙΑ by Athens Voice",
        "",
        "Concept by Επιστήμη Μπινάζη",
        "Developed by Δήμος Γκοντόλιας",
        "in collaboration with EduCoach",
      ].join("\n"),
      html: [
        "<p>Μόλις δημιουργήσατε κάτι που δεν υπήρχε πριν.</p>",
        "<p>Δύο άνθρωποι.<br>Μία επαφή.<br>Ένα μοναδικό μουσικό αποτέλεσμα.</p>",
        "<p>Αυτή είναι η μουσική που δημιουργήθηκε τη στιγμή που πιαστήκατε στα χέρια.</p>",
        `<p><strong>Άκουσέ την ξανά εδώ:</strong><br><a href="${escape(opts.audioUrl)}">${escape(opts.title)}.mp3</a> (και στο συνημμένο αρχείο)</p>`,
        "<p><strong>ΠΙΑΣΤΕΙΤΕ ΣΤΑ ΧΕΡΙΑ by Athens Voice</strong></p>",
        "<p>Concept by <strong>Επιστήμη Μπινάζη</strong><br>Developed by <strong>Δήμος Γκοντόλιας</strong><br>in collaboration with <strong>EduCoach</strong></p>",
      ].join(""),
      attachments: [{ filename: `${opts.title}.mp3`, content: audio, contentType: "audio/mpeg" }],
    });
    if (result.accepted.length === 0 || result.rejected.length > 0) {
      throw new Error("Zoho did not accept the recipient");
    }
  } finally {
    transport.close();
  }
}
