# Contributing to Phone-Use

Thanks for helping. Bug reports, device compatibility notes, docs fixes and code are all welcome.

## Ways to help

- **Report a bug.** Open an issue with the bug report form. Include `phone-use-mcp doctor` output, which doesn't show your token.
- **Report device compatibility.** Tell us which phones and Android versions work or fail, especially Android 11+ and OEM builds (Samsung, Xiaomi, and so on).
- **Suggest a feature.** Open an issue with the feature request form before writing a large change, so we can agree on the approach.
- **Security issues** go through private reporting, not issues. See [SECURITY.md](SECURITY.md).

## Project layout

```
android/        Android app (Java, bare SDK tools, no Gradle)
  src/          accessibility service, screen capture, HTTP server, setup provider
  test/         host-JVM tests for the HTTP parser
  build.sh      builds and signs android/build/phone-use.apk
mcp/            Node.js CLI and MCP server (no npm dependencies)
  bin/          phone-use-mcp entry point
  lib/          adb wrapper, HTTP client, setup, MCP transport
  lib/ios/      iPhone host: go-ios, WebDriverAgent client, screen reader, PNG, API server
  test/         node:test suites
docs/           HTTP API, testing, releasing
```

## Development setup

You need JDK 11+, an Android SDK platform and build-tools, `zip`, Node.js 18+ and `adb`. iPhone work also needs [go-ios](https://github.com/danielpaulus/go-ios/releases) and an iPhone with WebDriverAgent installed (see [docs/IOS.md](docs/IOS.md)).

```sh
git clone https://github.com/luckeyfaraday/phone-use.git
cd phone-use
./android/build.sh
./android/test.sh
npm test --prefix mcp
```

To try your build, run `node mcp/bin/phone-use-mcp.mjs setup --apk android/build/phone-use.apk` with a phone or emulator on USB. Set `PHONE_USE_CONFIG_DIR` to a scratch folder so your test pairing doesn't replace your everyday one.

**Test on a spare phone or an emulator.** Phone-Use asks Android for accessibility and screen-sharing access, and that can clash with other accessibility tools on your daily phone. An Android 7 (API 24) emulator image covers the minimum supported version.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Keep the change focused: one fix or feature per pull request.
3. Add or update tests. The Node suites use fakes for `adb`, the phone and WebDriverAgent (see `mcp/test/setup.test.mjs` and `mcp/test/ios.test.mjs`). Changes to the Android HTTP parser belong in `android/test/HttpRequestTest.java`.
4. For behaviour on the phone, work through the hardware checklist in [docs/TESTING.md](docs/TESTING.md) and say in the pull request what you tested on.
5. Update the README, `docs/API.md` and `CHANGELOG.md` (under **Unreleased**) when behaviour changes.
6. Make sure CI passes.

## Guidelines

- **No new dependencies.** The APK uses only the Android SDK, and the CLI uses only Node's standard library. Discuss it in an issue first if you think one is unavoidable.
- **Consent stays on the phone.** Setup must never grant accessibility or screen-sharing permission on the user's behalf, nothing may resume access remotely after Stop, and nothing may unlock an iPhone.
- **Never log or print the token.**
- **Never retry a mutating action automatically:** its effect may already have happened.
- Match the style of the surrounding code. Keep error messages specific and actionable.
- Write commit messages in the imperative mood ("Fix network toggle…"), with a body explaining why when it isn't obvious.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
