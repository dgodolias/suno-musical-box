# Zoho email migration verification

Verified on 7 October 2026 (Europe/Athens). Implementation commit: `abba314`.

| Requirement | Evidence | Result |
| --- | --- | --- |
| Athens Voice sender through Zoho | SMTP authentication succeeded for `piastitestaxeria@athensvoice.gr` on `smtp.zoho.eu:465` using TLS. Received messages show the same From address and Athens Voice display name. | Pass |
| Credentials configured locally and on Vercel | Local `.env.local` is ignored by Git. `SMTP_USER`, `SMTP_HOST`, and `SMTP_PASS` are configured for Vercel Production and Preview; `SMTP_PASS` is a Secret, shown as Hidden by `vercel env ls production`. No password is in tracked source. | Pass |
| Local end-to-end delivery | Optimized Next.js build served on port 3011. A POST to `/api/send-song` with existing song task `d126c54690c4cb820583c8a60f7616ca` and the user's supplied Gmail recipient returned HTTP 200 with `{"ok":true}`. Message received in Gmail Inbox at 16:26, with `Musical Box.mp3`. | Pass |
| Production end-to-end delivery | Vercel deployment `dpl_EcBMis99ivR2emxYWquqN3J5ZKVp` reached Ready and was aliased to `https://suno-musical-box.vercel.app`. The same POST to the public production API returned HTTP 200 with `{"ok":true}`. Message received in Gmail Inbox at 16:28, with `Musical Box.mp3`. | Pass |
| Real song attachment | Database lookup selected a completed song whose MP3 download returned HTTP 200, content type `audio/mpeg`, and 4,259,562 bytes. Both received emails expose the MP3 attachment, scanned by Gmail. Unit test verifies the exact downloaded bytes are supplied to SMTP. | Pass |
| Error behavior | Production API returned 400 for an invalid email address and 404 for a nonexistent song. Tests cover download failures, empty audio, missing credentials, SMTP failures, recipient rejection, transport cleanup, database-only audio lookup, and 502 responses. | Pass |
| Regression checks | All 120 tests pass. `npx tsc --noEmit` and `npm run build` pass. `npm run lint` exits successfully with one existing warning in `components/music-player.tsx:123` and no errors. | Pass |

The initial `smtppro.zoho.eu` suggestion was incorrect for this mailbox and
returned SMTP 554 Access Restricted. The verified host is `smtp.zoho.eu`.
Zoho's application name is an account-side password label, not a transport
setting. The existing Brevo key is unused by the new implementation.

Gmail receipt was verified in the user's signed-in browser by searching only
messages from the configured sender with the Musical Box subject. Two distinct
messages were visible in the same conversation, each with its own attachment.
Tests reused an existing song and did not create a new recording or incur a
Suno generation request. Attachment playback and Gmail authentication headers
were not inspected; inbox receipt and attachment presence were verified.
