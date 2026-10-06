# Application configuration

Both flags default to `false`:

| Flag | `false` | `true` |
| --- | --- | --- |
| `USE_MOCK_SUNO` | Real Suno generation (uses credits when a session generates music) | Local five-second test tone; no Suno requests or credits |
| `USE_MOCK_BIOMETRICS` | Real Bluetooth ring measurements | Synthetic readings, explicitly labelled in the UI |

The web app reads the flags at Next.js startup/build. Vercel environment variables
and `webapp/.env*` take precedence; the repository root `.env` is a local fallback.
Only these two non-secret flags are bundled into the browser. Restart the local
dev server after changing them; on Vercel, redeploy after changing Config values.
The root `.env` is not consulted on Vercel. Invalid values fail startup/build.

The old `SUNO_DISABLED` and `NEXT_PUBLIC_SUNO_DISABLED` pause switches are obsolete
and ignored. The main page displays both active modes.

The separate SyncWave `?mock` recorded-session replay is unchanged and independent
of these flags. The existing development-only `/?mock` demo is also preserved as
an explicit synthetic mode, labelled on the main page.
