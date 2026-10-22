// Talks to the phone-use API: the Phone-Use app on an Android phone, or `phone-use-mcp ios up` for
// an iPhone. Settings come from the environment or from ~/.config/phone-use/config.json (written by
// `phone-use-mcp setup` or `phone-use-mcp ios setup`):
//   PHONE_USE_URL     default http://127.0.0.1:7333 (Android over USB, through `adb forward`)
//   PHONE_USE_TOKEN   the phone's token
//   ANDROID_SERIAL    which Android phone, if several are plugged in
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adb, hasAdb } from "./adb.mjs";

export const CONFIG_DIR = process.env.PHONE_USE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "phone-use");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DEFAULT_PORT = 7333;
export const DEFAULT_IOS_PORT = 7334; // 7333 stays free for an Android phone on the same computer

/** Settings for clients. { env: false } reads only the saved file (for `ios up`, which serves them). */
export function loadConfig({ env = true } = {}) {
  const e = env ? process.env : {};
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`);
  }
  const platform = saved.platform === "ios" ? "ios" : "android";
  const common = {
    url: e.PHONE_USE_URL ?? saved.url ?? `http://127.0.0.1:${platform === "ios" ? DEFAULT_IOS_PORT : DEFAULT_PORT}`,
    token: e.PHONE_USE_TOKEN ?? saved.token ?? "",
  };
  if (platform === "ios") {
    // udid, bundleId and goIos are used by `ios up` on the computer the iPhone is connected to.
    return { platform, ...common, udid: saved.udid, bundleId: saved.bundleId, ...(saved.goIos ? { goIos: saved.goIos } : {}) };
  }
  return {
    platform,
    ...common,
    serial: e.ANDROID_SERIAL ?? saved.serial ?? undefined,
    devicePort: Number(e.PHONE_USE_DEVICE_PORT ?? saved.devicePort ?? DEFAULT_PORT),
  };
}

export function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${CONFIG_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, CONFIG_FILE);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);

/** Over USB the phone is reached through `adb forward`; (re)create it, since a replug or adb restart drops it. */
export async function ensureForward(config) {
  if (config.platform === "ios" || !config.serial || !isLocal(config.url) || !(await hasAdb())) return false;
  const port = Number(new URL(config.url).port || DEFAULT_PORT);
  try {
    const target = { serial: config.serial, timeoutMs: 10_000 };
    const existing = await adb(["forward", "--list"], target);
    const wanted = `${config.serial} tcp:${port} tcp:${config.devicePort ?? DEFAULT_PORT}`;
    if (!existing.split(/\r?\n/).some((line) => line.trim() === wanted)) {
      await adb(["forward", "--no-rebind", `tcp:${port}`, `tcp:${config.devicePort ?? DEFAULT_PORT}`], target);
    }
    return true;
  } catch {
    return false;
  }
}

export class Phone {
  constructor(config = loadConfig()) {
    this.config = config;
    this.forwarded = false;
  }

  async request(method, route, body, { timeoutMs = 30_000, reconnect = true } = {}) {
    if (!this.config.token) throw new Error("No phone-use token yet: run `phone-use-mcp setup` with the phone on USB.");
    const attempt = async () => {
      const response = await fetch(this.config.url.replace(/\/$/, "") + route, {
        method,
        headers: { "x-phone-use-token": this.config.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let data;
      try { data = await response.json(); }
      catch { throw Object.assign(new Error("Phone returned an invalid JSON response."), { status: response.status }); }
      if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { status: response.status });
      return data;
    };
    if (reconnect && !this.forwarded) this.forwarded = await ensureForward(this.config);
    try {
      return await attempt();
    } catch (error) {
      // Not reachable over USB? Re-create the adb forward once and retry.
      if (method === "GET" && reconnect && error.status === undefined && (await ensureForward(this.config))) {
        this.forwarded = true;
        try { return await attempt(); }
        catch (retryError) { error = retryError; }
      }
      if (error.status === undefined) {
        const check = this.config.platform === "ios" && isLocal(this.config.url) ? " Is `phone-use-mcp ios up` running?" : "";
        throw new Error(`The phone isn't answering at ${this.config.url}.${check} Check the connection and run \`phone-use-mcp doctor\`.${method === "POST" ? " The action may have completed; check the screen before repeating it." : ""}`, { cause: error });
      }
      throw error;
    }
  }

  get(route, options) {
    return this.request("GET", route, undefined, options);
  }

  post(route, body = {}) {
    return this.request("POST", route, body);
  }

  async findApp(query) {
    const { apps = [] } = await this.get("/apps");
    const q = String(query).toLowerCase();
    const exact = apps.find((a) => a.package === query || a.label.toLowerCase() === q);
    if (exact) return exact;
    const matches = apps.filter((a) => a.label.toLowerCase().includes(q) || a.package.toLowerCase().includes(q));
    if (matches.length === 1) return matches[0];
    if (!matches.length) throw new Error(`No installed app matches "${query}".`);
    throw new Error(`"${query}" matches several apps: ${matches.map((a) => `${a.label} (${a.package})`).join(", ")}`);
  }
}
