This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Song email (Zoho)

`POST /api/send-song` looks up the finished song by `taskId`, downloads that MP3,
and sends it through Zoho SMTP as an attachment. The sender name and email
signature are Athens Voice. It uses the authenticated mailbox as the From
address; client-supplied audio URLs are ignored.

Configure these variables in `.env.local` and Vercel Production/Preview:

| Variable | Value |
| --- | --- |
| `SMTP_USER` | `piastitestaxeria@athensvoice.gr` |
| `SMTP_PASS` | Zoho application password; store as a Vercel Secret |
| `SMTP_HOST` | `smtp.zoho.eu` (also the default) |

The provider uses port 465 with TLS and bounded connection/download timeouts.
This mailbox authenticated against `smtp.zoho.eu`; `smtppro.zoho.eu` rejected
it. If the Zoho account configuration changes, use the server shown in
[Zoho Mail's SMTP settings](https://www.zoho.com/mail/help/zoho-smtp.html).
The application name assigned when generating the password is a label in Zoho,
and is not an SMTP setting. `BREVO_API_KEY` is no longer used.

After changing Vercel variables, redeploy. Never commit application passwords.
Run `npm test`, `npx tsc --noEmit`, `npm run lint`, and `npm run build` before
deployment. For a delivery smoke test, submit a real finished song's `taskId`
and an inbox you control to `/api/send-song`; check the actual received MP3,
since `{ "ok": true }` confirms SMTP acceptance rather than inbox placement.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
