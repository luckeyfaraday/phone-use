#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
test_build=$(mktemp -d)
trap 'rm -rf "$test_build"' EXIT
javac --release 11 -d "$test_build" src/dev/phoneuse/HttpRequest.java test/HttpRequestTest.java
java -cp "$test_build" dev.phoneuse.HttpRequestTest
