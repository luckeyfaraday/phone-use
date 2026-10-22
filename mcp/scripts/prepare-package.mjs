import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const [source, target] of [["android/build/phone-use.apk", "phone-use.apk"], ["README.md", "README.md"], ["LICENSE", "LICENSE"]]) {
  const from = path.join(root, source), to = path.join(root, "mcp", target);
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
  if (!fs.existsSync(to)) throw new Error(`Missing ${source}. Build the Android APK before packaging.`);
}
