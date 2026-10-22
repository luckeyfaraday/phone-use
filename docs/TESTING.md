# Testing

Run `npm test` in `mcp/` for Node tests covering setup consent waiting, device selection, configuration storage, authenticated HTTP requests, Unicode text, CLI actions, screenshots, MCP negotiation, malformed input, and sequential tool dispatch.

Run `./android/test.sh` for host-JVM tests of the HTTP parser: UTF-8 byte lengths, incomplete bodies, oversized requests, malformed headers, and duplicate lengths. `./android/build.sh` compiles and signs the Android app. GitHub Actions runs these checks and builds both the APK and npm tarball.

Run `npm test` for the iPhone side too: PNG decoding against libpng-encoded fixtures (8- and 16-bit; Sub, Up, Average and Paeth rows), screen reading, go-ios output parsing, and the iPhone API server against a fake WebDriverAgent, including lock-as-Stop.

Android hardware acceptance checklist (use a spare phone or emulator):

1. Install and run setup. Verify it waits until you explicitly enable accessibility.
2. Read the screen and open Android Settings. Type non-ASCII text in a search field.
3. Request a screenshot before consent; verify that it instructs you to approve on the phone.
4. Open Phone-Use, allow screenshots, and approve Android's prompt. Take two screenshots, including one after rotating the device.
5. Tap Stop. Verify status still works, screen and actions fail, and a remote resume fails. Restart the app/service and confirm it remains paused.
6. Resume on the phone and approve screen sharing again. Verify reads and screenshots recover.
7. With network mode enabled, check authenticated access over the selected private network. Disable network mode and confirm the network listener closes.

iPhone hardware acceptance checklist (an iPhone with WebDriverAgent installed, see [IOS.md](IOS.md)):

1. Run `ios setup`, then `ios up`. Verify WebDriverAgent becomes ready and `phone-use-mcp status` reports `"platform": "ios"`.
2. Read the screen in Settings and a third-party app. Open apps by name and bundle ID. Type non-ASCII text, and end text with `\n` to submit a search.
3. Try each key (back, home, recents, quick_settings; notifications must be refused), and take screenshots at scales 0.25, 0.5 and 1.
4. Lock the iPhone with the side button. Verify status still works and that reads and actions fail with "locked". Unlock it and verify they recover without restarting `ios up`.
5. Run `phone-use-mcp pause` and verify the iPhone locks.
6. From the iPhone's Wi-Fi network, verify WebDriverAgent's port 8100 is not reachable.
7. Unplug and replug the iPhone. Verify `ios up` reconnects without a restart.

Minimum Android API is 24 (Android 7). The manifest currently targets API 29 for the project's older-phone use case. New Android/OEM releases may add sideloading, background-service, or screen-sharing restrictions; do not assume that a successful build establishes compatibility with every device.

The MCP transport implements the [2025-11-25 initialize lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and negotiates older supported revisions. A client using only newer protocol eras without initialize fallback is not supported.

## Verified for v0.1.0

On 2026-10-22, local tests passed on an isolated Android 7.0 (API 24) x86_64 emulator: setup waiting for Android accessibility consent; authenticated status and screen trees; app launching; element taps; Unicode typing (`café 日本語 👋`); scrolling and Back; screenshot refusal before consent; action refusal while the consent prompt is open; repeated JPEG screenshots; portrait-to-landscape resizing; Stop blocking reads/actions and remote resume; pause surviving force-stop and re-enabling accessibility; on-device resume requiring fresh screenshot consent; 30 consecutive network on/off toggles (the external listener opens and closes, USB stays reachable); and a refused toggle (port taken by another process) reporting an error while keeping the previous listener.

Node tests passed on Node 18, 22, and 24 in GitHub Actions. The Android HTTP parser's 10 checks, APK build, and npm packaging also passed in CI. Tailscale on a physical phone has not been tested yet.

## Verified for v0.2.0 (iPhone)

On 2026-10-23, on an iPhone 13 Pro with iOS 26 (Spanish locale), from Linux with go-ios 1.3.2: `ios setup` detecting the iPhone, Developer Mode and an installed WebDriverAgent; `ios up` bringing up the userspace tunnel, developer disk image and WebDriverAgent in under 40 seconds, and the first request right after "ready" succeeding; screen reads in Settings, Safari and the home screen; taps by element number; scrolling; Unicode typing (`café 日本語`) and `\n` submitting a search; back, home, recents and quick_settings, with notifications refused; screenshots at scales 0.25, 0.5 and 1, and through MCP; opening apps by their localized name. Each action, including the returned screen, took about 2.5–4.6 seconds.

Locking: `pause` locked the iPhone; status reported it paused; reads, taps, screenshots and remote resume were refused; unlocking on the phone resumed without restarting `ios up`. A WebDriverAgent started while the iPhone was locked reported it unlocked, and phone-use still refused access by detecting the lock screen. WebDriverAgent's ports 8100 and 9100 were closed on the iPhone's Wi-Fi address, and nothing listened on port 8100 on the computer. Unplugging and replugging while `ios up` runs has not been tested.
