# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-23

### Added

- iPhone support. `phone-use-mcp ios setup` and `phone-use-mcp ios up` run [WebDriverAgent](https://github.com/appium/WebDriverAgent) over USB with [go-ios](https://github.com/danielpaulus/go-ios) and serve the same HTTP API and MCP tools as the Android app. Locking the iPhone pauses the agent; unlocking it on the phone resumes. See [docs/IOS.md](docs/IOS.md).
- `phone-use-mcp connect` remembers whether the remote phone is an iPhone.

### Changed

- Tool descriptions and agent instructions now cover both Android and iPhone.

### Fixed

- `phone_list_apps` now matches package names regardless of case, like `phone_open_app`.

## [0.1.0] - 2026-10-22

First development preview.

### Added

- Android app (Android 7.0+): an accessibility service that reads the screen as numbered elements and performs taps, long presses, typing, scrolling, swipes, system keys and app launches.
- Optional screenshots through Android's screen-sharing consent. Images are returned in memory and never saved on the phone.
- A **Stop** pill and in-app control that block all reads and actions. Resuming is possible only on the phone, and the pause survives restarts.
- `phone-use-mcp`: a CLI and MCP server (stdio, protocol revisions 2024-11-05 to 2025-11-25) with 11 tools.
- One-command USB setup that waits for the user to enable accessibility on the phone, and saves the connection only once it works.
- Optional network mode for Wi-Fi or Tailscale, token-authenticated, with `network on|off` and `connect`.

[Unreleased]: https://github.com/luckeyfaraday/phone-use/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/luckeyfaraday/phone-use/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/luckeyfaraday/phone-use/releases/tag/v0.1.0
