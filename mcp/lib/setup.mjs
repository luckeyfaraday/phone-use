import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { adb, devices } from "./adb.mjs";
import { Phone, loadConfig, saveConfig, CONFIG_FILE } from "./client.mjs";

const TOKEN_URI = "content://dev.phoneuse.token/token";
const APK = fileURLToPath(new URL("../phone-use.apk", import.meta.url));

export function selectDevice(list, serial) {
  const candidates = serial ? list.filter((d) => d.serial === serial) : list;
  if (!candidates.length) throw new Error(serial ? `Device ${serial} is not connected.` : "No Android device found. Connect a USB data cable and enable USB debugging on the phone.");
  if (candidates.length > 1) throw new Error(`Choose a phone with --serial: ${candidates.map((d) => `${d.serial} (${d.state})`).join(", ")}`);
  const device = candidates[0];
  if (device.state === "unauthorized") throw new Error("Unlock the phone and accept its USB debugging prompt, then run setup again.");
  if (device.state !== "device") throw new Error(`Device ${device.serial} is ${device.state}. Reconnect it and try again.`);
  return device;
}

export function parseSettings(output) {
  const token = output.match(/\btoken=([a-f0-9]{48})(?=,|\s|$)/)?.[1];
  const port = Number(output.match(/\bport=(\d+)/)?.[1]);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Could not read Phone-Use settings. Install the current APK and try again.");
  return { token, port, network: /\bnetwork=1(?:,|\s|$)/.test(output) };
}

export async function setup(options = {}, deps = {}) {
  const run = deps.adb ?? adb;
  const list = deps.devices ?? devices;
  const save = deps.saveConfig ?? saveConfig;
  const makePhone = deps.makePhone ?? ((config) => new Phone(config));
  const wait = deps.delay ?? delay;
  const log = deps.log ?? console.error;
  const now = deps.now ?? Date.now;
  const device = selectDevice(await list(), options.serial ?? process.env.ANDROID_SERIAL);
  const target = { serial: device.serial };
  const apk = options.apk ?? APK;
  if (!(deps.exists ?? fs.existsSync)(apk)) throw new Error(`APK missing: ${apk}. Run ./android/build.sh and npm pack in mcp/, or pass --apk /path/to/phone-use.apk.`);
  const api = Number(await run(["shell", "getprop", "ro.build.version.sdk"], target));
  if (!Number.isInteger(api) || api < 24) throw new Error("Phone-Use requires Android 7.0 (API 24) or later.");
  log(`Installing Phone-Use on ${device.model ?? device.serial}…`);
  await run(["install", "-r", apk], { ...target, timeoutMs: 120_000 });
  const settings = parseSettings(await run(["shell", "content", "query", "--uri", TOKEN_URI], target));
  const localPort = options.port ?? settings.port;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("--port must be between 1 and 65535.");
  // --no-rebind avoids silently taking a port already forwarded to a different phone.
  const forwards = await run(["forward", "--list"], target);
  const wanted = `${device.serial} tcp:${localPort} tcp:${settings.port}`;
  if (!forwards.split(/\r?\n/).some((line) => line.trim() === wanted)) {
    await run(["forward", "--no-rebind", `tcp:${localPort}`, `tcp:${settings.port}`], target);
  }
  const config = { url: `http://127.0.0.1:${localPort}`, token: settings.token, serial: device.serial, devicePort: settings.port };
  await run(["shell", "am", "start", "-n", "dev.phoneuse/.MainActivity"], target);
  log("On the phone, tap Enable accessibility, select Phone-Use, and enable it in Android's settings.");
  log("Screenshots are optional: tap Allow screenshots in Phone-Use and approve Android's screen-sharing prompt.");
  log("Waiting for accessibility to connect…");
  const phone = makePhone(config);
  const deadline = now() + (options.timeout ?? 180) * 1000;
  while (now() < deadline) {
    try {
      const status = await phone.get("/status", { timeoutMs: 1000, reconnect: false });
      save(config);
      log(`Connected to ${status.device}. Settings saved in ${CONFIG_FILE}.`);
      if (status.paused) log("Phone-Use is paused. Tap Resume on the phone when you're ready.");
      return status;
    } catch (error) {
      if (error.status) throw error;
    }
    if (now() < deadline) await wait(Math.min(1000, deadline - now()));
  }
  throw new Error("Phone-Use is not enabled yet. Complete the accessibility step on the phone, then rerun setup. Existing computer settings were kept.");
}

export async function network(enabled, serial = loadConfig().serial) {
  const device = selectDevice(await devices(), serial);
  await adb(["shell", "content", "update", "--uri", TOKEN_URI, "--bind", `network:i:${enabled ? 1 : 0}`], { serial: device.serial });
  return { network: enabled };
}

export async function connect(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Use an HTTP(S) origin such as http://100.x.y.z:7333, without a path or credentials.");
  }
  const config = { ...loadConfig(), url: parsed.origin };
  const status = await new Phone(config).get("/status", { reconnect: false, timeoutMs: 5000 });
  saveConfig(config);
  return status;
}

export async function doctor() {
  const config = loadConfig();
  const checks = [];
  try {
    const found = await devices();
    checks.push({ check: "adb", ok: true, devices: found });
  } catch (error) {
    checks.push({ check: "adb", ok: false, detail: error.message });
  }
  checks.push({ check: "configuration", ok: Boolean(config.token), url: config.url, serial: config.serial ?? null });
  try {
    const status = await new Phone(config).get("/status", { timeoutMs: 5000 });
    checks.push({ check: "phone", ok: true, ...status });
  } catch (error) {
    checks.push({ check: "phone", ok: false, detail: error.message });
  }
  return { ok: checks.find((c) => c.check === "phone").ok, checks };
}
