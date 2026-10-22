// The computer side of iPhone support.
//   phone-use-mcp ios setup   checks the iPhone and WebDriverAgent, then saves the configuration
//   phone-use-mcp ios up      keeps go-ios and WebDriverAgent running and serves the phone-use API
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, CONFIG_FILE, DEFAULT_IOS_PORT, loadConfig, saveConfig } from "../client.mjs";
import { VERSION } from "../version.mjs";
import { deviceInfo, explain, findRunner, goIos, goIosPath, installedApps, jsonLines, listDevices, majorVersion, selectIphone } from "./goios.mjs";
import { createIosHandler, listen } from "./server.mjs";
import { connector } from "./usbmux.mjs";
import { Wda } from "./wda.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATE_DIR = path.join(CONFIG_DIR, "ios"); // go-ios runs here, so anything it writes stays private
const LOG_DIR = path.join(STATE_DIR, "logs");
const APPLE_ROOT = fileURLToPath(new URL("./apple-root-ca.pem", import.meta.url));
const SYSTEM_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"];
// go-ios's tunnel info API: its help says port 28100, while 1.3.2's tunnel agent listens on 60105.
const TUNNEL_INFO = ["http://127.0.0.1:60105", "http://127.0.0.1:28100"];
const WDA_DEVICE_PORT = 8100;

/** Developer Mode is required on iOS 16+ to run WebDriverAgent. */
export async function developerMode(bin, udid) {
  const output = await goIos(bin, ["devmode", "get"], { udid });
  const value = jsonLines(output).map((v) => v?.DeveloperModeEnabled).find((v) => v !== undefined); // {"DeveloperModeEnabled":true}
  if (value === undefined) throw new Error(`Couldn't read Developer Mode from go-ios: ${explain(output)}`);
  return value === true;
}

export async function iosSetup(options = {}, deps = {}) {
  const log = deps.log ?? console.error;
  const bin = goIosPath(options.goIos);
  const udid = selectIphone(await listDevices(bin), options.udid ?? process.env.PHONE_USE_UDID);
  const device = await deviceInfo(bin, udid);
  log(`Found an iPhone (${device.model}) with iOS ${device.version}.`);
  if (majorVersion(device.version) >= 16 && !(await developerMode(bin, udid))) {
    throw new Error("Developer Mode is off. On the iPhone, open Settings → Privacy & Security → Developer Mode, turn it on, and restart when asked. If the setting is missing, run `ios devmode reveal` with the iPhone connected.");
  }
  const bundleId = findRunner(await installedApps(bin, udid), options.bundleId);
  const previous = loadConfig({ env: false });
  const config = {
    platform: "ios",
    url: `http://127.0.0.1:${options.port ?? DEFAULT_IOS_PORT}`,
    // Keep the token across setups so other computers stay connected.
    token: previous.platform === "ios" && previous.token ? previous.token : crypto.randomBytes(24).toString("hex"),
    udid,
    bundleId,
    ...(options.goIos ? { goIos: options.goIos } : {}),
  };
  (deps.saveConfig ?? saveConfig)(config);
  log(`Using WebDriverAgent ${bundleId}. Settings saved in ${CONFIG_FILE}.`);
  log("Next, run `phone-use-mcp ios up` and leave it running while agents use the iPhone.");
  return { platform: "ios", device: device.model, ios: device.version, bundleId };
}

/** Starts and restarts the go-ios processes, logging each to a size-capped file. */
class Supervisor {
  constructor() {
    this.children = new Set();
    this.stopping = false;
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  }

  logFile(name) {
    return path.join(LOG_DIR, `${name}.log`);
  }

  note(name, message) {
    fs.appendFileSync(this.logFile(name), `${new Date().toISOString()} [phone-use] ${message}\n`);
  }

  run(name, [bin, ...args], env) {
    if (this.stopping) return Promise.resolve("stopped");
    return new Promise((resolve) => {
      const child = spawn(bin, args, { cwd: STATE_DIR, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      this.children.add(child);
      const write = (chunk) => {
        const file = this.logFile(name);
        try {
          if (fs.statSync(file).size > 5_000_000) fs.renameSync(file, `${file}.old`);
        } catch {}
        fs.appendFileSync(file, chunk);
      };
      child.stdout.on("data", write);
      child.stderr.on("data", write);
      const done = (result) => {
        this.children.delete(child);
        resolve(result);
      };
      child.on("error", (error) => done(error.message));
      child.on("exit", (code, signal) => done(signal ?? `exit ${code}`));
    });
  }

  /** Run `command` (argv, or async (run) => …) again and again until stop(). */
  keep(name, command, env, delayMs) {
    fs.writeFileSync(this.logFile(name), "");
    (async () => {
      while (!this.stopping) {
        const result = typeof command === "function" ? await command((argv) => this.run(name, argv, env)) : await this.run(name, command, env);
        if (this.stopping) break;
        this.note(name, `${name} stopped (${result}); restarting in ${delayMs / 1000} s`);
        await sleep(delayMs);
      }
    })();
  }

  stop() {
    this.stopping = true;
    for (const child of this.children) {
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
}

/** go-ios's environment. On Linux, add Apple's root CA so it can download developer disk images. */
function goIosEnv() {
  if (process.platform !== "linux" || process.env.SSL_CERT_FILE) return process.env;
  const system = SYSTEM_BUNDLES.find((file) => fs.existsSync(file));
  if (!system) return process.env;
  const bundle = path.join(STATE_DIR, "ca-bundle.pem");
  fs.writeFileSync(bundle, `${fs.readFileSync(system, "utf8")}\n${fs.readFileSync(APPLE_ROOT, "utf8")}`);
  return { ...process.env, SSL_CERT_FILE: bundle };
}

/** Wait until the iPhone is connected, trusted and readable: → { udid, device }. */
async function waitForIphone(bin, wanted, log, stopped) {
  let told = null;
  const tell = (message) => {
    if (told !== message) log(message);
    told = message;
  };
  while (!stopped()) {
    try {
      const udid = selectIphone(await listDevices(bin), wanted);
      return { udid, device: await deviceInfo(bin, udid) };
    } catch (error) {
      if (/No iPhone found|isn't connected/.test(error.message)) tell("Waiting for the iPhone: connect it with a USB cable and unlock it.");
      else if (error.notReady) tell(`Waiting for the iPhone: ${error.message}`);
      else throw error;
    }
    await sleep(3000);
  }
  return null;
}

async function waitForTunnel(udid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const api of TUNNEL_INFO) {
      try {
        if ((await fetch(`${api}/tunnel/${udid}`, { signal: AbortSignal.timeout(2000) })).ok) return true;
      } catch {}
    }
    await sleep(1000);
  }
  return false;
}

const HINTS = `WebDriverAgent hasn't started yet. Check that:
  • the iPhone is unlocked;
  • you trusted the developer: Settings → General → VPN & Device Management;
  • its signing profile hasn't expired (free Apple IDs: 7 days). Re-sign and reinstall it if so (docs/IOS.md).
Logs: ${LOG_DIR}. Still trying…`;

export async function iosUp(options = {}, deps = {}) {
  const log = deps.log ?? console.error;
  // The saved settings, not PHONE_USE_URL/PHONE_USE_TOKEN, which are for clients.
  const config = loadConfig({ env: false });
  if (config.platform !== "ios" || !config.token || !config.bundleId) throw new Error("Run `phone-use-mcp ios setup` with the iPhone connected first.");
  const port = Number(new URL(config.url).port) || DEFAULT_IOS_PORT;
  const hosts = options.network ? ["0.0.0.0"] : ["127.0.0.1"];
  const bin = goIosPath(options.goIos ?? config.goIos);
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const device = { version: null, model: "iPhone" };
  let udid = config.udid;
  // Without --wda-url, WebDriverAgent is reached over USB through usbmux and gets no port here.
  const wda = new Wda(options.wdaUrl ?? "http://wda", options.wdaUrl ? {} : { connect: () => connector(udid, WDA_DEVICE_PORT)() });
  let appsCache = { at: 0, apps: null };
  const apps = async () => {
    if (!appsCache.apps || Date.now() - appsCache.at > 60_000) appsCache = { at: Date.now(), apps: await installedApps(bin, udid) };
    return appsCache.apps;
  };

  const servers = await listen(createIosHandler({ wda, apps, token: config.token, device, version: VERSION }), hosts, port);
  log(`Serving the iPhone at ${hosts.map((h) => `http://${h}:${port}`).join(", ")}${options.network ? " (all network interfaces; requires the token)" : ""}.`);

  const supervisor = new Supervisor();
  const shutdown = (code = 0) => {
    supervisor.stop();
    for (const server of servers) server.close();
    setTimeout(() => process.exit(code), 500).unref();
  };
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());

  try {
    if (!options.wdaUrl) {
      const env = goIosEnv();
      const found = await waitForIphone(bin, udid, log, () => supervisor.stopping);
      if (!found) return;
      udid = found.udid;
      Object.assign(device, found.device);
      log(`Connected to an iPhone (${device.model}) with iOS ${device.version}. Starting WebDriverAgent…`);
      if (majorVersion(device.version) >= 17) {
        // iOS 17+ reaches developer services through a tunnel; userspace mode needs no root. Its
        // pairing keys go in the state folder, not wherever this was started from.
        const pairing = path.join(STATE_DIR, "pairing"); // go-ios needs it to exist
        fs.mkdirSync(pairing, { recursive: true, mode: 0o700 });
        supervisor.keep("tunnel", [bin, "tunnel", "start", "--userspace", `--pair-record-path=${pairing}`], env, 5000);
        if (!(await waitForTunnel(udid, 30_000))) log(`The iOS tunnel isn't up yet; see ${supervisor.logFile("tunnel")}.`);
      }
      const images = path.join(STATE_DIR, "images");
      supervisor.keep("wda", async (run) => {
        await run([bin, "image", "auto", `--basedir=${images}`, `--udid=${udid}`]); // no-op once mounted
        // USE_IP keeps WebDriverAgent off the iPhone's Wi-Fi: it's only reachable over USB.
        return run([bin, "runwda", `--bundleid=${config.bundleId}`, `--testrunnerbundleid=${config.bundleId}`,
          "--xctestconfig=WebDriverAgentRunner.xctest", "--env=USE_IP=127.0.0.1", `--log-output=${path.join(LOG_DIR, "wda-device.log")}`, `--udid=${udid}`]);
      }, env, 10_000);
    }

    let ready = false, hinted = false;
    const started = Date.now();
    while (!supervisor.stopping) {
      const status = await wda.status().catch(() => null);
      const now = Boolean(status?.ready);
      device.version ??= status?.os?.version ?? null; // with --wda-url, go-ios may not be in use
      if (now !== ready) log(now ? "WebDriverAgent is ready: agents can use the iPhone now. Press Ctrl+C to stop." : "WebDriverAgent stopped (iPhone unplugged?). Restarting it…");
      ready = now;
      if (!ready && !hinted && Date.now() - started > 90_000) {
        log(HINTS);
        hinted = true;
      }
      await sleep(ready ? 10_000 : 2000);
    }
  } catch (error) {
    // Exit (instead of serving forever without an iPhone) so a service manager can restart us.
    log(`phone-use: ${error.message}`);
    shutdown(1);
  }
}
