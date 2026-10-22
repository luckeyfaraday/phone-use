// Thin wrapper around the `adb` command-line tool.
import { execFile } from "node:child_process";

export function adb(args, { serial = process.env.ANDROID_SERIAL, timeoutMs = 60_000, input } = {}) {
  const full = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = execFile("adb", full, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === "ENOENT") return reject(new Error("adb isn't installed or isn't on PATH (install Android platform-tools)"));
        return reject(new Error((stderr || stdout || error.message).trim()));
      }
      resolve(stdout.trim());
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

export async function hasAdb() {
  try {
    await adb(["version"], { serial: null, timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Connected devices: [{ serial, state, model }]. */
export async function devices() {
  const out = await adb(["devices", "-l"], { serial: null });
  return out.split("\n").slice(1).filter(Boolean).map((line) => {
    const [serial, state] = line.trim().split(/\s+/);
    const model = line.match(/model:(\S+)/)?.[1]?.replace(/_/g, " ") ?? null;
    return { serial, state, model };
  });
}

export const shell = (command, options) => adb(["shell", command], options);
