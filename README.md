# Phone-Use

Let an AI agent use an Android phone: read the screen, tap, type, scroll, open apps, and take screenshots. Works with any agent that supports MCP over stdio, or directly from a terminal. No AthenaOS, root, cloud account, or Android-side Node installation required.

The agent runs on your computer; the phone runs a small Android app. Android accessibility supplies a numbered list of visible elements. Screenshots are optional and use Android's screen-sharing consent prompt. A Stop pill appears during screen reads and actions.

## Install

Requirements: Android 7.0 or newer, Node.js 18 or newer, [Android platform-tools (`adb`)](https://developer.android.com/tools/releases/platform-tools), and a USB data cable. Initial pairing uses USB debugging. This release targets older Android phones; emulator coverage and limitations are in [testing](docs/TESTING.md).

Install the package from the GitHub release (the APK is included):

```sh
npm install -g https://github.com/luckeyfaraday/phone-use/releases/download/v0.1.0/phone-use-mcp-0.1.0.tgz
phone-use-mcp setup
```

1. On the phone, enable Developer options and USB debugging. Connect the cable and approve Android's USB debugging prompt.
2. Run `phone-use-mcp setup`. It installs Phone-Use and opens its screen.
3. Tap **Enable accessibility**, choose **Phone-Use**, and enable it in Android's settings.
4. For screenshots, return to Phone-Use, tap **Allow screenshots**, and approve Android's screen-sharing prompt.

Setup waits for the service to connect, then saves the token and device selection in `~/.config/phone-use/config.json`. The token is not printed. Setup does not grant accessibility or screen-sharing consent on your behalf.

If multiple phones are connected, choose one with `--serial DEVICE_ID` (`adb devices` lists them). Use `--port 7444` if the computer's default port is occupied, `--apk /path/to/phone-use.apk` for another build, or `--timeout 300` to allow more time for setup.

## Connect your agent

```sh
phone-use-mcp config
```

This prints an MCP configuration with absolute paths for the installed CLI. Add the `phone-use` server to your agent's MCP configuration and restart or reconnect its tools. The generic form is:

```json
{
  "mcpServers": {
    "phone-use": {
      "command": "phone-use-mcp",
      "args": ["mcp"]
    }
  }
}
```

Client configuration formats vary; use the generated command and arguments in your client's equivalent server section. Phone-Use does not edit agent configuration files automatically.

Try: “Use phone_screen to see my phone, then open Settings and tell me the Android version.” The 11 tools are `phone_screen`, `phone_screenshot`, `phone_tap`, `phone_long_press`, `phone_type`, `phone_scroll`, `phone_swipe`, `phone_key`, `phone_open_app`, `phone_list_apps`, and `phone_status`.

The MCP server supports protocol revisions 2024-11-05 through 2025-11-25 using the initialize handshake. Newer clients must support that negotiation path. Tool calls execute in order. Use one controlling agent per phone: element numbers refer to the latest screen read, including reads returned by actions.

## Use the terminal

```sh
phone-use-mcp doctor
phone-use-mcp status
phone-use-mcp screen
phone-use-mcp apps
phone-use-mcp open Settings
phone-use-mcp tap 4
phone-use-mcp tap 360 800
phone-use-mcp type 'Hello 👋' --id 7
phone-use-mcp scroll down
phone-use-mcp key back
phone-use-mcp screenshot ./screen.jpg
phone-use-mcp pause
```

`screenshot FILE` saves a JPEG to the explicitly supplied path and refuses to overwrite an existing file. MCP screenshots are returned in memory; Phone-Use keeps no screenshot history and writes no images on the phone. The receiving agent may retain images in its own conversation history.

## Stop and resume

Tap **Stop** in the on-screen pill or in the Phone-Use app, or run `phone-use-mcp pause`. While paused, screen reads, app lists, screenshots, and actions return an error. Status remains available. Pause survives app restarts and stops the screen-sharing session.

Resume on the phone using the pill or the Phone-Use app. The network API cannot resume access. Allow screenshots again if you want them after resuming. Disable Phone-Use in Android's accessibility settings to revoke access entirely.

## Wi-Fi and Tailscale

Complete USB setup first so the computer has the phone's token. Then enable **Wi-Fi / Tailscale access** in the app, or explicitly enable it over USB:

```sh
phone-use-mcp network on
phone-use-mcp connect http://YOUR_PHONE_TAILSCALE_IP:7333
phone-use-mcp doctor
```

`connect` tests the new address before saving it. You can now unplug USB. Both devices must be reachable through your tailnet. Tailscale is installed and configured separately. `network off` over USB, or **Use USB only** in the app, disables the network listener. Rerun setup to save a USB connection again.

USB mode binds to the phone's loopback address. Network mode listens on all phone interfaces and requires the same random token for every request. The app's HTTP server does not provide TLS: use Tailscale or another trusted encrypted tunnel when traffic leaves the USB connection. Do not expose port 7333 to the internet.

Environment overrides: `PHONE_USE_URL`, `PHONE_USE_TOKEN`, `ANDROID_SERIAL`, `PHONE_USE_DEVICE_PORT` (default 7333), and `PHONE_USE_CONFIG_DIR`. A network-only client needs the URL and token, but not `adb`.

## Build from source

Linux build prerequisites: JDK 11+, Android SDK platform and build-tools, `zip`, Node.js 18+. The Java app uses the bare SDK tools, with no Gradle or third-party runtime dependencies.

```sh
git clone https://github.com/luckeyfaraday/phone-use.git
cd phone-use
./android/build.sh
./android/test.sh
cd mcp
npm test
npm pack
npm install -g ./phone-use-mcp-0.1.0.tgz
phone-use-mcp setup
```

`ANDROID_HOME` or `ANDROID_SDK_ROOT` selects the SDK (default `~/Android/Sdk`). `ANDROID_PLATFORM` and `BUILD_TOOLS_VERSION` pin installed SDK versions. The APK is `android/build/phone-use.apk`. `npm pack` copies the freshly built APK, README, and license into the package.

Local builds create `android/debug.keystore`, excluded from Git. Keep the signing key to install subsequent builds over the existing app. Release signing accepts `KEYSTORE=/absolute/path`, `KEY_PASS`, and optional `KEY_ALIAS`. CI artifacts use a newly generated debug key and are intended for testing; they may require uninstalling a differently signed build. This project is distributed as a sideloaded APK, not through Google Play.

See [the HTTP API](docs/API.md), [testing and compatibility](docs/TESTING.md), and [release instructions](docs/RELEASING.md).

## Troubleshooting

- **Unauthorized device:** unlock the phone and accept its USB debugging prompt. Rerun `adb devices`.
- **Accessibility is unavailable:** some Android versions restrict accessibility for sideloaded apps. Review Android's app information screen and its restricted-settings controls yourself, then return to accessibility settings.
- **Phone not answering:** run `phone-use-mcp doctor`. Check the cable or network, selected device, and accessibility setting. Rerun setup after reinstalling the app, because its token changes.
- **Screenshots need approval:** open Phone-Use and allow screen sharing. Android may end the session when the phone locks, the app stops, or you stop sharing. Protected app content can appear blank.
- **An action timed out:** read the screen before retrying. The action may have happened even if its response was lost; mutations are never retried automatically.
- **Wrong signature on update:** use the same signing key, or uninstall the previous standalone Phone-Use build before installing. Uninstalling resets its pairing token and permissions.

Phone-Use's package is `dev.phoneuse`. It is independent of AthenaOS (`os.athena.home`). Existing AthenaOS users can keep using AthenaOS's phone tools; installing this separate app is unnecessary for that setup.

MIT licensed.
