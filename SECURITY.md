# Security policy

Phone-Use lets software read and operate a phone, so security reports are taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

Until 1.0, only the latest release receives fixes.

## Reporting a vulnerability

**Please don't open a public issue.** Report privately through GitHub instead: go to the repository's **Security** tab and choose **[Report a vulnerability](https://github.com/luckeyfaraday/phone-use/security/advisories/new)**.

Include what you can:

- the affected version and Android version
- the connection mode (USB or network)
- steps to reproduce, or a proof of concept
- the impact you expect

You should get an acknowledgement within a few days. Once a fix is ready, it will be released and credited to you in the advisory unless you prefer otherwise.

## Scope

In scope:

- reading the screen or acting on the phone without the pairing token
- bypassing **Stop**, or resuming access from anywhere other than the phone
- obtaining the token from another app on the phone
- screenshots captured without the user's screen-sharing consent
- the CLI or MCP server leaking the token or writing files it shouldn't

Out of scope, because these are documented limitations:

- traffic in network mode on an untrusted network: the phone's HTTP server has no TLS, so use Tailscale or another encrypted tunnel
- anyone who already holds the token, or who has USB debugging access to the phone
- what an agent you've connected chooses to do with the access you've given it
