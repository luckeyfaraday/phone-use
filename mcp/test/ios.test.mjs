import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { decodePng, downscale, encodePng, pngSize } from "../lib/ios/png.mjs";
import { readTree, MAX_ELEMENTS } from "../lib/ios/screen.mjs";
import { findRunner, jsonLines, logError, parseApps, selectIphone, userApps } from "../lib/ios/goios.mjs";
import { createIosHandler } from "../lib/ios/server.mjs";
import { WdaError } from "../lib/ios/wda.mjs";

// ------------------------------------------------------------------ PNG

// A 7×5 RGB pattern, encoded by libpng (ImageMagick) and by hand; every fixture decodes to it under libpng.
const PATTERN = Buffer.from("0000a525054d4a0aca6f0f18941425b91930de1ebb0b351d303a6d553f137a442c9f49dec44ed6e95323166a7b3b6f2e6074d985791eaa7e3fcf8372f4881f219fcb46a4196ba97190ae17b5b344dab894ffbdd62cd44951d93c76de9d9be35cc0e834e5ed600af2be", "hex");
const FIXTURES = {
  "8-bit RGB, Sub and Paeth rows (libpng)": "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqChYWOyfF2gc3AAAAa0lEQVQI1wXBsQ2CUBRAUUj+rW4cwBbzGmJH/ggUFBgmMHELGlzABazsSKy1cAMrB2AUSSw8pyyKObgHU3AINoHBJZlHGaSTrTzkK30yH+Upb2nlJI38knmQm1xlFaSSVzKfZSd7aWWRj9R/IjsTUxQAbzoAAAAASUVORK5CYII=",
  "16-bit RGB (libpng)": "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFEAIAAABWaL3MAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRP///////wlY99wAAAAHdElNRQfqChYWOyfF2gc3AAAAnUlEQVQI10XMoQ3CUBRA0U/Sq24YAEvzTFNH/giICkgnIGELDF2gC6DqSNCtYIMqBmAUSBAIBGeAs0gppes1Am63CDifI2C/j4DlMgI0Avq+0JxPJ4W2VWgahdVKYRwVXi+F3a7QnA8HhWlSmGeF7VbheFTYbBQ+n0Jz/n3DoHC5KLzfCqCwXivc74Xm3HUKZalQ1//1+VR4PBSq6gsfeSaUt7ZrDQAAAABJRU5ErkJggg==",
  "8-bit RGB, Up and Average rows": "iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAIAAAAG+GGPAAAAeUlEQVR4nAFuAJH/AgAApSUFTUoKym8PGJQUJbkZMN4euwMLNcsYHTgYHXgYHRcYHbYYHU8YHVsCCzVeCzXBCzXGCzXyCzVhCzWcCzX8AxZqjhgdnRgd+Bgd0BgdGRgdORgdfQEs1EklBfMlBWElBb8lBdglBSwlBV4jgRyc185kdQAAAABJRU5ErkJggg==",
};

for (const [name, b64] of Object.entries(FIXTURES)) {
  test(`PNG decoder: ${name}`, () => {
    const image = decodePng(Buffer.from(b64, "base64"));
    assert.deepEqual([image.width, image.height, image.channels], [7, 5, 3]);
    assert.deepEqual(image.data, PATTERN);
  });
}

test("PNG decoder reads RGBA and rejects what it can't read", () => {
  const rgba = decodePng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAYAAACJmvbYAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqChYWOyfF2gc3AAAAd0lEQVQI1y3LsQ2BUQBG0St5t/piAC15jejkjaBQkH8CiS00RG8BlU6iprCBygBGIVFonP704LyvXqhuqS6p9qmG6oGStiF2xDlxQLwS38QFJW1FvBEfxBlxTZwSv5S0jngiHokfosQh8U5J2xFHxMl/vohP4pgfx3kT09kQg60AAAAASUVORK5CYII=", "base64"));
  assert.equal(rgba.channels, 4);
  for (let i = 0; i < 35; i++) assert.deepEqual([...rgba.data.subarray(i * 4, i * 4 + 3)], [...PATTERN.subarray(i * 3, i * 3 + 3)]);
  assert.throws(() => decodePng(Buffer.from("not a png")), /Not a PNG/);
});

test("PNG encoder round-trips, and downscaling averages pixel blocks", () => {
  const image = { width: 7, height: 5, channels: 3, data: PATTERN };
  const png = encodePng(image);
  assert.deepEqual(pngSize(png), { width: 7, height: 5 });
  assert.deepEqual(decodePng(png).data, PATTERN);

  const square = { width: 2, height: 2, channels: 4, data: Buffer.from([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 40, 80, 120, 255]) };
  const one = downscale(square, 1, 1);
  assert.deepEqual([...one.data], [85, 95, 105]);
  assert.throws(() => downscale(square, 3, 1), /shrink/);
});

// ------------------------------------------------------------------ screen

const node = (type, rect, extra = {}, children = []) => ({ type, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, ...extra, children });

test("screen reading lists useful elements with tap points and skips noise", () => {
  const tree = node("Application", [0, 0, 390, 844], { label: "Example" }, [
    node("NavigationBar", [0, 47, 390, 44], { label: "Inbox" }, [node("Button", [0, 47, 80, 44], { label: "Back" })]),
    node("Other", [0, 100, 390, 300], { label: "Inbox" }), // repeats a label: dropped
    node("Other", [0, 100, 390, 300]), // unlabeled container: dropped
    node("Other", [380, 120, 3, 40], { label: "Vertical scroll bar" }), // scroll indicator: dropped
    node("Table", [0, 100, 390, 600], {}, [
      node("Cell", [0, 100, 390, 60], { label: "Message from Sam", value: "Unread", rawIdentifier: "row-1" }),
      node("Cell", [0, 900, 390, 60], { label: "Below the screen" }), // off screen: dropped
    ]),
    node("SearchField", [16, 720, 358, 36], { label: "Search", isFocused: true }),
    node("Button", [0, 760, 100, 40], { label: "Disabled", isEnabled: "0" }),
    node("Keyboard", [0, 560, 390, 284], {}, [node("Key", [0, 600, 39, 42], { label: "q" }), node("Key", [300, 800, 90, 42], { label: "search" })]),
  ]);
  const screen = readTree(tree, { width: 390, height: 844 }, { bundleId: "com.example.mail", name: "Mail" });
  assert.equal(screen.app, "com.example.mail");
  const lines = screen.text.trim().split("\n");
  assert.equal(lines[0], "app: com.example.mail (Mail)   screen: 390x844 points");
  assert.deepEqual(lines.slice(1), [
    '[0] NavigationBar "Inbox" @195,69',
    ' [1] Button "Back" @40,69 tap',
    "[2] Table @195,400 scroll",
    ' [3] Cell "Message from Sam" value="Unread" #row-1 @195,130 tap',
    '[4] SearchField "Search" @195,738 tap edit focused',
    '[5] Button "Disabled" @50,780 tap disabled',
    "[6] Keyboard @195,702",
    ' [7] Key "search" @345,821 tap',
  ]);
  assert.deepEqual(screen.elements[3], { id: 3, role: "Cell", text: "Message from Sam", desc: "Unread", view_id: "row-1", bounds: [0, 100, 390, 160], clickable: true, scrollable: false, editable: false });
  assert.deepEqual(screen.centers[7], { x: 345, y: 821, rect: { x: 300, y: 800, width: 90, height: 42 } });
  assert.deepEqual(screen.centers[2].rect, { x: 0, y: 100, width: 390, height: 600 });
});

test("screen reading clips to the screen, caps the list, and explains an empty screen", () => {
  const many = node("Application", [0, 0, 100, 100], {}, Array.from({ length: MAX_ELEMENTS + 5 }, (_, i) => node("Button", [-50, 0, 100, 10], { label: `b${i}` })));
  const screen = readTree(many, { width: 100, height: 100 });
  assert.equal(screen.elements.length, MAX_ELEMENTS);
  assert.deepEqual(screen.elements[0].bounds, [0, 0, 50, 10]);
  assert.deepEqual(screen.centers[0], { x: 25, y: 5, rect: { x: 0, y: 0, width: 50, height: 10 } }); // only the on-screen part
  assert.match(screen.text, /truncated at 300 elements; 5 more/);
  assert.match(readTree(node("Application", [0, 0, 10, 10]), { width: 10, height: 10 }).text, /no readable elements/);
});

// ------------------------------------------------------------------ go-ios

test("go-ios output parsing, device choice and WebDriverAgent detection", () => {
  const output = 'starting\n{"deviceList":["A","B"]}\n{"level":"ERROR","msg":"failed getting device list","err":"no usbmuxd"}\n';
  assert.deepEqual(jsonLines(output)[0], { deviceList: ["A", "B"] });
  assert.equal(logError(output), "failed getting device list: no usbmuxd");
  assert.equal(logError('{"level":"WARN","msg":"tunnel"}'), null);
  assert.throws(() => selectIphone([]), /No iPhone found/);
  assert.throws(() => selectIphone(["A", "B"]), /--udid/);
  assert.throws(() => selectIphone(["A"], "C"), /isn't connected/);
  assert.equal(selectIphone(["A", "B"], "B"), "B");
  const apps = [{ package: "com.apple.Preferences", label: "Settings", system: true }, { package: "com.example.wda.xctrunner", label: "WebDriverAgentRunner-Runner", system: false }];
  assert.equal(findRunner(apps), "com.example.wda.xctrunner");
  assert.throws(() => findRunner(apps.slice(0, 1)), /isn't installed/);
  assert.throws(() => findRunner(apps, "com.other"), /isn't installed/);
  assert.deepEqual(userApps(apps).map((a) => a.package), ["com.apple.Preferences"]);
  const listed = parseApps('{"level":"INFO","msg":"x"}\n' + JSON.stringify([
    { CFBundleIdentifier: "com.apple.mobilesafari", CFBundleDisplayName: "Safari", ApplicationType: "System" },
    { CFBundleIdentifier: "com.apple.CarPlaySettings", CFBundleDisplayName: "Ajustes", ApplicationType: "System", SBAppTags: ["hidden"] },
    { CFBundleIdentifier: "com.apple.Hidden.thing", CFBundleName: "Thing", ApplicationType: "Hidden" },
    { CFBundleIdentifier: "com.example.app", CFBundleName: "Example", ApplicationType: "User" },
  ]));
  assert.deepEqual(listed, [{ package: "com.example.app", label: "Example", system: false }, { package: "com.apple.mobilesafari", label: "Safari", system: true }]);
});

// ------------------------------------------------------------------ server

class FakeWda {
  constructor() {
    this.calls = [];
    this.isLocked = false;
    this.down = false;
    this.size = { width: 390, height: 844 };
    this.lockAfter = null; // lock the "iPhone" right after this call, as a person might
    this.app = "com.apple.Preferences";
    this.onLockScreen = false; // a WebDriverAgent started while locked: says unlocked, shows the cover sheet
    // A 2x-scale device: 780×1688-pixel screenshot of the 390×844-point screen.
    this.png = encodePng({ width: 780, height: 1688, data: Buffer.alloc(780 * 1688 * 3, 200) });
  }
  record(name, ...args) {
    this.calls.push([name, ...args]);
    if (this.lockAfter === name) this.isLocked = true;
  }
  async status() { if (this.down) throw new WdaError("WebDriverAgent isn't answering"); return { ready: true }; }
  async locked() { if (this.down) throw new WdaError("WebDriverAgent isn't answering"); return this.isLocked; }
  async lock() { this.record("lock"); this.isLocked = true; }
  async activeApp() { return { bundleId: this.onLockScreen ? "com.apple.springboard" : this.app, name: "Settings" }; }
  async windowSize() { return this.size; }
  async source() {
    this.record("source");
    if (this.onLockScreen) return node("Application", [0, 0, 390, 844], {}, [node("Window", [0, 0, 390, 844], { rawIdentifier: "SBCoverSheetWindow" }, [node("StaticText", [0, 300, 390, 40], { label: "New message from Sam" })])]);
    return node("Application", [0, 0, 390, 844], {}, [node("Button", [0, 100, 390, 44], { label: "General" })]);
  }
  async screenshot() { return this.png; }
  async tap(x, y) { this.record("tap", x, y); }
  async touchAndHold(x, y) { this.record("hold", x, y); }
  async home() { this.record("home"); }
  async activate(bundleId) { this.record("activate", bundleId); }
  async type(text, append) { this.record("type", text, append); }
  async swipe(...args) { this.record("swipe", ...args); }
  async gesture(points, options) { this.record("gesture", points, options); }
}

async function serve(wda) {
  const apps = async () => [{ package: "com.apple.Preferences", label: "Settings", system: true }, { package: "x.wda.xctrunner", label: "WebDriverAgentRunner-Runner", system: false }];
  const server = http.createServer(createIosHandler({ wda, apps, token: "secret", device: { version: "26.1", model: "iPhone14,2" }, version: "9.9.9" }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, token = "secret") => {
    const response = await fetch(base + route, { method, headers: { "x-phone-use-token": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { server, call };
}

test("iPhone server speaks the Android app's API, with the lock screen as Stop", async () => {
  const wda = new FakeWda();
  const { server, call } = await serve(wda);
  try {
    assert.equal((await call("GET", "/status", undefined, "wrong")).status, 401);
    assert.deepEqual((await call("GET", "/status")).body, { connected: true, paused: false, locked: false, screenshots: true, version: "9.9.9", platform: "ios", ios: "26.1", device: "iPhone14,2" });

    const screen = (await call("GET", "/screen")).body;
    assert.match(screen.text, /\[0\] Button "General" @195,122 tap/);
    assert.equal(screen.paused, false);

    const tapped = await call("POST", "/tap", { id: 0, settle_ms: 0 });
    assert.equal(tapped.body.ok, true);
    assert.deepEqual(wda.calls.findLast((c) => c[0] === "tap"), ["tap", 195, 122]);
    assert.match((await call("POST", "/tap", { id: 9 })).body.error, /No element \[9\]/);

    await call("POST", "/type", { text: "hello\n", id: 0, settle_ms: 0 });
    assert.deepEqual(wda.calls.filter((c) => c[0] !== "source").slice(-2), [["tap", 195, 122], ["type", "hello\n", false]]);
    await call("POST", "/key", { key: "back", settle_ms: 0 });
    assert.deepEqual(wda.calls.findLast((c) => c[0] === "swipe"), ["swipe", 5, 422, 312, 422, 400]);
    await call("POST", "/key", { key: "recents", settle_ms: 0 });
    assert.equal(wda.calls.findLast((c) => c[0] !== "source")[0], "gesture");
    assert.equal((await call("POST", "/key", { key: "power" })).status, 400);
    assert.match((await call("POST", "/key", { key: "notifications" })).body.error, /Notification Center isn't available on iPhone/);
    await call("POST", "/open", { package: "com.apple.Preferences", settle_ms: 0 });
    assert.deepEqual(wda.calls.findLast((c) => c[0] === "activate"), ["activate", "com.apple.Preferences"]);
    assert.deepEqual((await call("GET", "/apps")).body.apps.map((a) => a.package), ["com.apple.Preferences"]);

    const shot = (await call("GET", "/screenshot?scale=0.5")).body;
    assert.deepEqual([shot.mime, shot.width, shot.height, shot.screen_width, shot.scale_to_screen], ["image/png", 390, 844, 390, 1]);
    assert.deepEqual(pngSize(Buffer.from(shot.data, "base64")), { width: 390, height: 844 });

    // Pausing locks the iPhone; while locked only status and pause work, and nothing here unlocks it.
    assert.deepEqual((await call("POST", "/pause")).body, { paused: true });
    assert.equal(wda.isLocked, true);
    const blocked = await call("GET", "/screen");
    assert.equal(blocked.status, 423);
    assert.match(blocked.body.error, /locked/);
    assert.equal((await call("POST", "/tap", { x: 1, y: 1 })).status, 423);
    assert.equal((await call("GET", "/status")).body.paused, true);
    assert.match((await call("POST", "/resume")).body.error, /Unlock the iPhone/);

    wda.isLocked = false;
    // Locked during an action or a read: the screen isn't handed over.
    wda.lockAfter = "swipe";
    const during = await call("POST", "/scroll", { direction: "down", settle_ms: 0 });
    assert.equal(during.body.ok, true);
    assert.equal(during.body.screen.paused, true);
    assert.equal(during.body.screen.elements.length, 0);
    wda.isLocked = false;
    wda.lockAfter = "source";
    assert.equal((await call("GET", "/screen")).status, 423);
    wda.isLocked = false;
    wda.lockAfter = "tap";
    assert.equal((await call("POST", "/type", { text: "secret", id: 0, settle_ms: 0 })).status, 423);
    assert.notEqual(wda.calls.at(-1)[0], "type");
    wda.isLocked = false;
    wda.lockAfter = null;

    // A WebDriverAgent started while the iPhone was locked says "unlocked": the cover sheet still counts.
    wda.onLockScreen = true;
    const lockScreen = await call("GET", "/screen");
    assert.equal(lockScreen.status, 423);
    assert.doesNotMatch(JSON.stringify(lockScreen.body), /Sam/);
    assert.equal((await call("POST", "/tap", { x: 1, y: 1 })).status, 423);
    assert.equal((await call("GET", "/status")).body.locked, true);
    wda.onLockScreen = false;

    // iPhones with a Home button use other gestures for these.
    wda.size = { width: 375, height: 667 };
    assert.match((await call("POST", "/key", { key: "recents" })).body.error, /Home button/);
    wda.size = { width: 390, height: 844 };

    assert.equal((await call("POST", "/nope", {})).status, 400);
    assert.equal((await call("POST", "/tap", [1, 2])).status, 400);
    wda.down = true;
    const down = await call("GET", "/screen");
    assert.equal(down.status, 502);
    assert.match(down.body.error, /isn't answering/);
    assert.equal((await call("GET", "/status")).body.connected, false);
  } finally {
    server.close();
  }
});

test("an unreachable iPhone host suggests starting `ios up`", async () => {
  const { Phone } = await import("../lib/client.mjs");
  const phone = new Phone({ platform: "ios", url: "http://127.0.0.1:9", token: "secret" });
  await assert.rejects(phone.get("/status", { timeoutMs: 2000 }), /Is `phone-use-mcp ios up` running\?/);
  const remote = new Phone({ platform: "ios", url: "http://192.0.2.1:7334", token: "secret" });
  await assert.rejects(remote.get("/status", { timeoutMs: 500 }), (error) => !/ios up/.test(error.message));
});

test("connect keeps an iPhone host's settings, and drops them for an Android phone", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-use-connect-"));
  const env = { ...process.env, PHONE_USE_CONFIG_DIR: dir };
  for (const k of ["PHONE_USE_URL", "PHONE_USE_TOKEN", "ANDROID_SERIAL"]) delete env[k];
  // A child process, so the config folder is read at import time.
  const script = `
    import { connect } from ${JSON.stringify(new URL("../lib/setup.mjs", import.meta.url).href)};
    import { saveConfig, loadConfig } from ${JSON.stringify(new URL("../lib/client.mjs", import.meta.url).href)};
    saveConfig({ platform: "ios", url: "http://127.0.0.1:7334", token: "t", udid: "U", bundleId: "B" });
    const phone = (platform) => ({ makePhone: () => ({ get: async () => ({ connected: true, platform }) }) });
    await connect("http://127.0.0.1:7334", phone("ios"));
    const a = loadConfig({ env: false });
    await connect("http://100.64.0.2:7333", phone(undefined));
    console.log(JSON.stringify([a, loadConfig({ env: false })]));
  `;
  try {
    const [ios, android] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" }));
    assert.deepEqual(ios, { platform: "ios", url: "http://127.0.0.1:7334", token: "t", udid: "U", bundleId: "B" });
    assert.equal(android.platform, "android");
    assert.equal(android.url, "http://100.64.0.2:7333");
    assert.equal(android.udid, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel calls after a WebDriverAgent restart share one new session", async () => {
  const { Wda } = await import("../lib/ios/wda.mjs");
  let current = null, created = 0;
  // Like WebDriverAgent: opening a session ends the previous one.
  const server = http.createServer(async (req, res) => {
    for await (const _ of req);
    const reply = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify({ value })); };
    if (req.method === "POST" && req.url === "/session") { current = `s${++created}`; return reply(200, { sessionId: current }); }
    if (req.url.endsWith("/appium/settings")) return reply(200, {});
    const id = req.url.split("/")[2];
    if (id !== current) return reply(404, { error: "invalid session id", message: "Session does not exist" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return reply(200, { width: 390, height: 844 });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const wda = new Wda(`http://127.0.0.1:${server.address().port}`);
    await wda.windowSize();
    current = null; // WebDriverAgent restarted: s1 is gone
    const results = await Promise.all([wda.windowSize(), wda.windowSize(), wda.call("GET", "/window/size")]);
    assert.deepEqual(results.map((r) => r.width), [390, 390, 390]);
    assert.equal(created, 2);
  } finally {
    server.close();
  }
});
