// Talks to the Phone-Use app on the phone. Settings come from the environment or from
// ~/.config/phone-use/config.json (written by `phone-use-mcp setup`):
//   PHONE_USE_URL     default http://127.0.0.1:7333 (USB, through `adb forward`)
//   PHONE_USE_TOKEN   the phone's token
//   ANDROID_SERIAL    which phone, if several are plugged in
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adb, hasAdb } from "./adb.mjs";

export const CONFIG_DIR = process.env.PHONE_USE_CONFIG_DIR ?? path.join(os.homedir(), ".config", "phone-use");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const DEFAULT_PORT = 7333;

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Cannot read ${CONFIG_FILE}: ${error.message}`);
  }
  return {
    url: process.env.PHONE_USE_URL ?? saved.url ?? `http://127.0.0.1:${DEFAULT_PORT}`,
    token: process.env.PHONE_USE_TOKEN ?? saved.token ?? "",
    serial: process.env.ANDROID_SERIAL ?? saved.serial ?? undefined,
    devicePort: Number(process.env.PHONE_USE_DEVICE_PORT ?? saved.devicePort ?? DEFAULT_PORT),
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
  if (!config.serial || !isLocal(config.url) || !(await hasAdb())) return false;
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
        return attempt();
      }
      if (error.status === undefined) {
        throw new Error(`The phone isn't answering at ${this.config.url}. Check the connection and run \`phone-use-mcp doctor\`.${method === "POST" ? " The action may have completed; check the screen before repeating it." : ""}`, { cause: error });
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
