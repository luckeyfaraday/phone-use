# Testing

Run `npm test` in `mcp/` for Node tests covering setup consent waiting, device selection, configuration storage, authenticated HTTP requests, Unicode text, CLI actions, screenshots, MCP negotiation, malformed input, and sequential tool dispatch.

Run `./android/test.sh` for host-JVM tests of the HTTP parser: UTF-8 byte lengths, incomplete bodies, oversized requests, malformed headers, and duplicate lengths. `./android/build.sh` compiles and signs the Android app. GitHub Actions runs these checks and builds both the APK and npm tarball.

Hardware acceptance checklist (use a spare phone or emulator):

1. Install and run setup. Verify it waits until you explicitly enable accessibility.
2. Read the screen and open Android Settings. Type non-ASCII text in a search field.
3. Request a screenshot before consent; verify that it instructs you to approve on the phone.
4. Open Phone-Use, allow screenshots, and approve Android's prompt. Take two screenshots, including one after rotating the device.
5. Tap Stop. Verify status still works, screen and actions fail, and a remote resume fails. Restart the app/service and confirm it remains paused.
6. Resume on the phone and approve screen sharing again. Verify reads and screenshots recover.
7. With network mode enabled, check authenticated access over the selected private network. Disable network mode and confirm the network listener closes.

Minimum Android API is 24 (Android 7). The manifest currently targets API 29 for the project's older-phone use case. New Android/OEM releases may add sideloading, background-service, or screen-sharing restrictions; do not assume that a successful build establishes compatibility with every device. Existing AthenaOS installations do not need this app.

The MCP transport implements the [2025-11-25 initialize lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and negotiates older supported revisions. A client using only newer protocol eras without initialize fallback is not supported.
