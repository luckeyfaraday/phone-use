# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-22

First development preview.

### Added

- Android app (Android 7.0+): an accessibility service that reads the screen as numbered elements and performs taps, long presses, typing, scrolling, swipes, system keys and app launches.
- Optional screenshots through Android's screen-sharing consent. Images are returned in memory and never saved on the phone.
- A **Stop** pill and in-app control that block all reads and actions. Resuming is possible only on the phone, and the pause survives restarts.
- `phone-use-mcp`: a CLI and MCP server (stdio, protocol revisions 2024-11-05 to 2025-11-25) with 11 tools.
- One-command USB setup that waits for the user to enable accessibility on the phone, and saves the connection only once it works.
- Optional network mode for Wi-Fi or Tailscale, token-authenticated, with `network on|off` and `connect`.

[Unreleased]: https://github.com/luckeyfaraday/phone-use/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/luckeyfaraday/phone-use/releases/tag/v0.1.0
