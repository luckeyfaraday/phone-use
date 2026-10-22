## What and why

<!-- What does this change, and what problem does it solve? Link the issue: Fixes #123 -->

## How it was tested

<!-- Phone or emulator model and Android version, connection mode, and which steps of docs/TESTING.md you ran. -->

## Checklist

- [ ] `npm test --prefix mcp` and `./android/test.sh` pass
- [ ] Tests added or updated
- [ ] README, `docs/API.md` and `CHANGELOG.md` updated if behaviour changed
- [ ] No new dependencies, and the token is never logged or printed
- [ ] Consent stays on the phone (no remote resume or permission grants)
