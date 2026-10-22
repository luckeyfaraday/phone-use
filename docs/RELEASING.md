# Releasing

Keep the APK signing key private and stable between releases. Keystores, APK build output, tokens, and local agent configuration must not be committed.

1. Update the version in `mcp/package.json`, `mcp/lib/version.mjs`, `android/AndroidManifest.xml`, and `android/src/dev/phoneuse/BuildInfo.java`. Increment the Android version code. Update the install URLs in the README.
2. Run `./android/test.sh` and `npm test --prefix mcp`.
3. Build with `KEYSTORE=/absolute/path/to/release.keystore KEY_PASS=... ./android/build.sh`. Keep the password in an environment variable or CI secret. Optional `KEY_ALIAS` selects a key in a multi-key store.
4. Run `npm pack` in `mcp/`. Check `npm pack --dry-run` for exactly the intended files. Install the tarball in a temporary prefix and test `phone-use-mcp --help` and the MCP handshake.
5. Commit the tested source. Upload the APK, npm tarball, and SHA256SUMS to a GitHub release whose tag identifies that commit. Check download URLs against the README.

The v0.x releases are development previews, signed with the maintainer's local development key. CI builds use temporary debug keys and are test artifacts, not replacements for a release APK. A future switch to release signing requires uninstalling the development preview once.

GitHub tarball installation works independently of the npm registry. Publishing to npm is a separate action requiring ownership of the package name and npm authentication. No npm credentials are stored in this repository, and CI does not publish packages automatically.
