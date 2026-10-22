// Serves the Android app's HTTP API (docs/API.md) for an iPhone, from the computer it's connected
// to, so the CLI, the MCP server and remote clients work the same with either phone.
//
// Stopping works through the lock screen: while the iPhone is locked, everything except /status and
// /pause is refused, and nothing here unlocks it. The person holding the phone stops the agent with
// the side button and resumes it by unlocking with Face ID, Touch ID or their passcode.
//
// WebDriverAgent learns the lock state from notifications it receives while running, so one started
// while the iPhone was locked reports it unlocked. The lock screen is SpringBoard's cover sheet
// window, so that counts as locked too (it's also behind Notification Center, which pauses as well).
import crypto from "node:crypto";
import http from "node:http";
import { readTree } from "./screen.mjs";
import { decodePng, downscale, encodePng } from "./png.mjs";
import { WdaError } from "./wda.mjs";
import { userApps } from "./goios.mjs";

const MAX_BODY = 1 << 20;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (status, message) => Object.assign(new Error(message), { status });
const LOCKED = "The iPhone is locked, so phone-use is paused. Ask the person holding it to unlock it before continuing.";
const LOCKED_SCREEN = { app: null, text: "The iPhone is locked now; phone-use stays paused until someone unlocks it.\n", elements: [], paused: true };
const SPRINGBOARD = "com.apple.springboard";
const coverSheet = (node) => (node.type === "Window" && node.rawIdentifier === "SBCoverSheetWindow") || (node.children ?? []).some(coverSheet);

/**
 * wda: a Wda client; apps(): installed apps ({ package, label, system }); token: the shared secret;
 * device: { version, model } for /status; version: this package's version.
 */
export function createIosHandler({ wda, apps, token, device, version }) {
  let centers = []; // tap points of the latest screen read, indexed by element number
  let queue = Promise.resolve();
  const serialized = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  /** The current screen, or null if it's the lock screen. */
  async function screen() {
    const [tree, size, app] = await Promise.all([wda.source(), wda.windowSize(), wda.activeApp()]);
    if (app?.bundleId === SPRINGBOARD && coverSheet(tree)) return null;
    const result = readTree(tree, size, app);
    centers = result.centers;
    return { app: result.app, text: result.text, elements: result.elements, paused: false };
  }

  async function locked() {
    if (await wda.locked()) return true;
    if ((await wda.activeApp())?.bundleId !== SPRINGBOARD) return false;
    return coverSheet(await wda.source());
  }

  function target(args) {
    if (args.id !== undefined && args.id !== null) {
      const center = centers[args.id];
      if (!Number.isInteger(args.id) || !center) throw fail(400, `No element [${args.id}] on the latest screen; read the screen again.`);
      return center;
    }
    if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw fail(400, "Give an element id, or both x and y.");
    return { x: args.x, y: args.y, rect: null };
  }

  async function screenshot(scaleArg) {
    const scale = Math.min(1, Math.max(0.25, Number(scaleArg) || 0.5));
    const [png, size] = await Promise.all([wda.screenshot(), wda.windowSize()]);
    const image = decodePng(png);
    const small = downscale(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    return {
      mime: "image/png", width: small.width, height: small.height, screen_width: size.width, screen_height: size.height,
      scale_to_screen: size.width / small.width, data: encodePng(small).toString("base64"),
    };
  }

  async function key(name) {
    const { width: W, height: H } = await wda.windowSize();
    // iPhones with a Home button (568–736 points tall) use other gestures for these.
    if (H < 800 && (name === "recents" || name === "quick_settings")) throw fail(400, `${name} isn't supported on iPhones with a Home button.`);
    switch (name) {
      case "home": return wda.home();
      // iOS has no Back key: swipe in from the left edge. Starting at x=1 doesn't register; x=5 does.
      case "back": return wda.swipe(5, H * 0.5, W * 0.8, H * 0.5, 400);
      // App switcher: a slow swipe up from just above the bottom edge, then a hold.
      case "recents": return wda.gesture([[W / 2, H - 5], [W / 2, H * 0.75], [W / 2, H * 0.55]], { ms: 900, holdMs: 1200 });
      case "notifications":
        // Notification Center is the lock screen's cover sheet, and WebDriverAgent reports it as locked,
        // so opening it would pause phone-use with no way for the agent to close it.
        throw fail(400, "Notification Center isn't available on iPhone: it shares the lock screen, which pauses phone-use.");
      case "quick_settings": return wda.swipe(W - 12, 1, W - 12, H * 0.6, 350); // Control Center
      case "lock": return wda.lock();
      default: throw fail(400, `unknown key ${name} (back, home, recents, quick_settings, lock)`);
    }
  }

  async function act(path, args) {
    switch (path) {
      case "/tap": { const t = target(args); return wda.tap(t.x, t.y); }
      case "/longpress": { const t = target(args); return wda.touchAndHold(t.x, t.y); }
      case "/swipe":
        for (const k of ["x1", "y1", "x2", "y2"]) if (!Number.isFinite(args[k])) throw fail(400, `${k} must be a number`);
        return wda.swipe(args.x1, args.y1, args.x2, args.y2, Math.min(Math.max(Number(args.ms) || 350, 50), 3000));
      case "/scroll": {
        const { width: W, height: H } = await wda.windowSize();
        const r = (args.id !== undefined ? target(args).rect : null) ?? { x: 0, y: H * 0.15, width: W, height: H * 0.7 };
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2, dx = r.width * 0.3, dy = r.height * 0.3;
        const moves = { down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy], right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy] };
        const m = moves[args.direction ?? "down"];
        if (!m) throw fail(400, "direction must be up, down, left or right");
        return wda.swipe(...m, 300);
      }
      case "/type": {
        if (typeof args.text !== "string") throw fail(400, "text must be a string");
        if (args.id !== undefined) {
          const t = target(args);
          await wda.tap(t.x, t.y);
          await sleep(500);
          if (await locked()) throw fail(423, LOCKED); // locked between focusing and typing
        }
        return wda.type(args.text, Boolean(args.append));
      }
      case "/key": return key(args.key);
      case "/open":
        if (typeof args.package !== "string" || !args.package) throw fail(400, "package must be an app's bundle ID");
        return wda.activate(args.package);
      default: throw fail(400, `unknown route POST ${path}`);
    }
  }

  async function status() {
    let connected = false, isLocked = null;
    try {
      connected = Boolean((await wda.status())?.ready);
      isLocked = connected ? await locked() : null;
    } catch {}
    return { connected, paused: isLocked === true, locked: isLocked, screenshots: connected, version, platform: "ios", ios: device.version, device: device.model };
  }

  async function route(method, path, args) {
    if (method === "GET" && path === "/status") return status();
    if (method === "POST" && path === "/pause") {
      await wda.lock();
      return { paused: true };
    }
    if (method === "POST" && path === "/resume") throw fail(400, "Unlock the iPhone to resume.");
    return serialized(async () => {
      if (await locked()) throw fail(423, LOCKED);
      if (method === "GET") {
        if (path === "/screen") {
          const result = await screen();
          if (!result || (await wda.locked())) throw fail(423, LOCKED); // locked while reading: don't hand it over
          return result;
        }
        if (path === "/apps") return { apps: userApps(await apps()) };
        if (path === "/screenshot") return screenshot(args.scale);
        throw fail(400, `unknown route GET ${path}`);
      }
      if (method !== "POST") throw fail(400, `unknown route ${method} ${path}`);
      await act(path, args);
      if (path === "/key" && args.key === "lock") return { ok: true, screen: LOCKED_SCREEN };
      await sleep(Math.max(0, Math.min(Number(args.settle_ms ?? 700) || 0, 5000)));
      // The person may have locked the iPhone during the action: check before and after reading.
      if (await wda.locked()) return { ok: true, screen: LOCKED_SCREEN };
      const after = await screen();
      if (!after || (await wda.locked())) return { ok: true, screen: LOCKED_SCREEN };
      return { ok: true, screen: after };
    });
  }

  return async (req, res) => {
    const reply = (code, body) => {
      const bytes = Buffer.from(JSON.stringify(body));
      res.writeHead(code, { "content-type": "application/json", "content-length": bytes.length, connection: "close" });
      res.end(bytes);
    };
    const given = Buffer.from(String(req.headers["x-phone-use-token"] ?? ""));
    const expected = Buffer.from(token);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      req.resume();
      return reply(401, { error: "missing or wrong token (header x-phone-use-token)" });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return reply(413, { error: "request body too large" });
      chunks.push(chunk);
    }
    const url = new URL(req.url, "http://phone");
    let args;
    try {
      args = req.method === "GET" ? Object.fromEntries(url.searchParams) : (size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error();
    } catch {
      return reply(400, { error: "body must be a JSON object" });
    }
    try {
      reply(200, await route(req.method, url.pathname, args));
    } catch (error) {
      reply(error.status ?? (error instanceof WdaError ? 502 : 500), { error: error.message });
    }
  };
}

/** Listen on each host (127.0.0.1, and 0.0.0.0 for network access). Resolves once all are listening. */
export async function listen(handler, hosts, port) {
  return Promise.all(hosts.map((host) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", (error) => reject(new Error(`Can't listen on ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => resolve(server));
  })));
}
