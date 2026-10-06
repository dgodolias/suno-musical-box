# Ring connection recovery

Implemented and physically exercised on 2026-10-06. Longer-term stability remains unproven.

- Each participant card remembers the browser-granted device ID in local storage.
  On page load, `getDevices()` restores only that selection, without connecting
  or starting sensors. The Reconnect button uses it directly; Choose another ring
  still opens Chrome's chooser. Revoked permissions fall back to the chooser.
- Transient setup failures and unexpected GATT disconnects schedule at most
  three retries, after 1, 2 and 4 seconds, without reopening the chooser.
  Receiving a fresh HR sample resets the retry budget. Intentional Disconnect
  cancels retries. Optical diagnostic failures remain manual recovery only.
- Connection setup is bounded to 20 seconds. On timeout the GATT connection is
  closed and the UI permits a manual retry; it does not automatically overlap
  retries with an unresolved native operation. Late completions cannot restart
  measurement or disconnect a newer successful connection.
- Reconnection clears stale BPM, retrieves fresh GATT characteristics and installs
  one notification listener. It does not create or reset an application session.
- Browser selection, GATT connection and service discovery are distinct diagnostic
  stages. The UI distinguishes Chrome's chooser from actual connection setup.

These changes do not establish why the rings sometimes fail to advertise or why
the physical link drops. First-time discovery remains controlled by Chrome and
the Bluetooth devices. Neither firmware nor measurement protocol was changed.

Validation: regression tests cover saved-device restoration, transient setup
failure, automatic recovery with one fresh-reading callback, retry exhaustion,
manual cancellation, and late completion of a timed-out connection. Existing BLE,
storage and application tests also pass. Source TypeScript validation and scoped
ESLint pass; the normal `tsc` command currently encounters malformed generated
`.next/dev/types` files, separately from these source changes.

API references: [Chrome Web Bluetooth guide](https://developer.chrome.com/docs/capabilities/bluetooth)
and [Chrome automatic reconnect sample](https://googlechrome.github.io/samples/web-bluetooth/automatic-reconnect-async-await.html).

## Physical trial with no source edits

Both rings worn; no Start Session, Suno requests, firmware changes or optical tests.
The user explicitly stopped concurrent source edits for the controlled repetitions.
Raw timestamped reports are saved locally in `%TEMP%/suno-ring-measurements/connection-stability-2026-10-06.json`.

Six immediate Disconnect/Reconnect cycles completed without a new chooser or page
refresh. Each needed one automatic retry: a GATT disconnect occurred during setup,
before notifications became ready. The other ring continued streaming throughout.

| Ring | Trial | Connect click to notifications ready | Click to first fresh BPM |
| --- | --- | --- | --- |
| 9 | 1 | 16.705 s | 30.834 s |
| 9 | 2 | 9.747 s | 25.869 s |
| 9 | 3 | 11.810 s | 27.909 s |
| 11 | 1 | 6.862 s | 23.901 s |
| 11 | 2 | 9.210 s | 26.208 s |
| 11 | 3 | 8.550 s | 25.534 s |

Times begin at the diagnostic `Connecting GATT` event, immediately following the
Reconnect click, and include the automatic retry. Once streaming, no unexpected
disconnect was observed during the controlled intervals; the longest uninterrupted
interval was roughly three minutes. This is not evidence of hours-long reliability.

Two additional trials allowed a release interval after Disconnect. Ring 9's actual
interval was 12.532 s and ring 11's was 24.644 s (including tool overhead). Both
connected without retry: 6.823 s and 5.301 s respectively. An earlier ring 9 trial
with a 5.377 s interval also succeeded without retry (5.924 s setup).
This suggests immediate native reconnection races physical link teardown, but does
not prove a minimum required delay or rule out other Bluetooth causes. No extra
delay was added to production solely from these small samples.

Before the controlled repetitions, ring 11 recovered automatically after two
native connection failures and one setup disconnect, taking 35.597 s from its
first attempt to notifications ready. Concurrent recompilation at that earlier
point cannot be ruled out. The later no-edit setup failures show that recompilation
does not explain every failure.
