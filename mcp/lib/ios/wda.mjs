// HTTP client for WebDriverAgent (https://github.com/appium/WebDriverAgent), the XCUITest runner
// that reads and operates the iPhone's UI. iOS doesn't let an app on the phone control other apps,
// so this runs on the computer the iPhone is connected to.

import http from "node:http";

export class WdaError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One HTTP exchange on a fresh connection. WebDriverAgent closes idle keep-alive connections, and
 * reusing one that just closed fails, so nothing is pooled. `connect` (optional) supplies the socket,
 * e.g. straight to the iPhone over USB. → { status, data }
 */
function exchange(url, method, body, timeoutMs, connect) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request(url, {
      method,
      // Node uses createConnection only when no agent is given; agent: false means a fresh connection.
      ...(connect ? { createConnection: (_options, done) => { connect().then((socket) => done(null, socket), done); } } : { agent: false }),
      headers: { connection: "close", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        let data = {};
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        resolve({ status: response.statusCode, data });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    request.on("error", reject);
    request.end(payload);
  });
}

export class Wda {
  /**
   * url: WebDriverAgent's address. connect: optional () => Promise<socket> to reach it instead of
   * dialing the URL; `ios up` uses usbmux so WebDriverAgent never gets a port on this computer.
   */
  constructor(url, { connect } = {}) {
    this.url = url.replace(/\/$/, "");
    this.connect = connect;
    this.sessionPromise = null; // shared, so concurrent calls don't each open a session
  }

  async request(method, route, body, timeoutMs = 30_000, retried = false) {
    let response;
    try {
      response = await exchange(this.url + route, method, body, timeoutMs, this.connect);
    } catch (error) {
      // A dropped connection (WebDriverAgent restarting) is retried once, but only for requests
      // that change nothing on the iPhone: actions are never repeated.
      if (!retried && error.name !== "TimeoutError" && (method === "GET" || route === "/session")) {
        await sleep(500);
        return this.request(method, route, body, timeoutMs, true);
      }
      const why = error.name === "TimeoutError" ? "timed out" : `not running: ${error.code ?? error.message}`;
      throw new WdaError(`WebDriverAgent isn't answering (${method} ${route.replace(/\/session\/[^/?]+/, "/session/…")}, ${why}). Check that the iPhone is connected and \`phone-use-mcp ios up\` is running.`);
    }
    const { status, data } = response;
    if (status < 200 || status >= 300 || data?.value?.error) {
      const error = new WdaError(String(data?.value?.message ?? data?.value?.error ?? `HTTP ${status}`).split("\n")[0]);
      error.code = data?.value?.error;
      throw error;
    }
    return data.value;
  }

  session() {
    this.sessionPromise ??= (async () => {
      const { sessionId } = await this.request("POST", "/session", { capabilities: { alwaysMatch: {}, firstMatch: [{}] } });
      // Don't wait for the app to go idle before each action: apps that keep animating (Settings,
      // video feeds) made every swipe take ~15 s. The server settles after each action and returns
      // the screen as it is then, so the agent always acts on what's actually shown.
      await this.request("POST", `/session/${sessionId}/appium/settings`, {
        settings: { waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 60 },
      }).catch(() => {});
      return sessionId;
    })().catch((error) => {
      this.sessionPromise = null;
      throw error;
    });
    return this.sessionPromise;
  }

  /** Session-scoped call; re-creates the session once if WebDriverAgent dropped it (e.g. after a restart). */
  async call(method, route, body, timeoutMs) {
    const current = this.session();
    const id = await current;
    try {
      return await this.request(method, `/session/${id}${route}`, body, timeoutMs);
    } catch (error) {
      if (error.code !== "invalid session id") throw error;
      // Parallel calls fail together: only the first resets, the rest share its new session.
      // (Opening a session ends the previous one, so two would invalidate each other.)
      if (this.sessionPromise === current) this.sessionPromise = null;
      return this.request(method, `/session/${await this.session()}${route}`, body, timeoutMs);
    }
  }

  // WebDriverAgent handles one request at a time, so status can wait behind a long screen read.
  status() { return this.request("GET", "/status", undefined, 20_000); }
  locked() { return this.request("GET", "/wda/locked", undefined, 10_000); }
  lock() { return this.request("POST", "/wda/lock"); }
  activeApp() { return this.request("GET", "/wda/activeAppInfo").catch(() => ({})); }
  windowSize() { return this.call("GET", "/window/size"); }
  source() { return this.call("GET", "/source?format=json&excluded_attributes=visible,accessible,hittable", undefined, 45_000); }
  screenshot() { return this.request("GET", "/screenshot", undefined, 30_000).then((b64) => Buffer.from(b64, "base64")); }
  tap(x, y) { return this.call("POST", "/wda/tap", { x, y }); }
  touchAndHold(x, y) { return this.call("POST", "/wda/touchAndHold", { x, y, duration: 1.0 }); }
  home() { return this.request("POST", "/wda/homescreen"); }
  activate(bundleId) { return this.call("POST", "/wda/apps/activate", { bundleId }); }

  async type(text, append) {
    if (!append) {
      const active = await this.call("GET", "/element/active").catch(() => null);
      const uuid = active?.ELEMENT ?? active?.["element-6066-11e4-a52f-4ce4b4b6e7"];
      if (uuid) await this.call("POST", `/element/${uuid}/clear`).catch(() => {});
    }
    return this.call("POST", "/wda/keys", { value: [text] }, 60_000);
  }

  /** One-finger gesture through the given points; `holdMs` pauses before lifting. */
  gesture(points, { ms = 350, holdMs = 0 } = {}) {
    const [start, ...rest] = points.map(([x, y]) => [Math.round(x), Math.round(y)]);
    const actions = [{ type: "pointerMove", duration: 0, x: start[0], y: start[1] }, { type: "pointerDown", button: 0 }, { type: "pause", duration: 60 }];
    for (const [x, y] of rest) actions.push({ type: "pointerMove", duration: Math.round(ms / rest.length), x, y });
    if (holdMs) actions.push({ type: "pause", duration: holdMs });
    actions.push({ type: "pointerUp", button: 0 });
    return this.call("POST", "/actions", { actions: [{ type: "pointer", id: "finger1", parameters: { pointerType: "touch" }, actions }] });
  }

  swipe(x1, y1, x2, y2, ms = 350) { return this.gesture([[x1, y1], [x2, y2]], { ms }); }

  /** Wait until WebDriverAgent reports ready, up to timeoutMs. */
  async waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if ((await this.status())?.ready) return true;
      } catch {}
      await sleep(1000);
    }
    return false;
  }
}
