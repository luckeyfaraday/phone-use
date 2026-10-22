import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "phone-use-test-"));
process.env.PHONE_USE_CONFIG_DIR = temporary;
delete process.env.PHONE_USE_URL;
delete process.env.PHONE_USE_TOKEN;
delete process.env.ANDROID_SERIAL;
const { Phone, saveConfig, loadConfig, CONFIG_FILE } = await import("../lib/client.mjs");
const cli = new URL("../bin/phone-use-mcp.mjs", import.meta.url).pathname;
const token = "test-secret";
let requests = [];
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ method: req.method, url: req.url, body, token: req.headers["x-phone-use-token"] });
  res.setHeader("content-type", "application/json");
  if (req.url === "/drop") { req.socket.destroy(); return; }
  if (req.url === "/invalid") { res.end("not json"); return; }
  if (req.url === "/paused") { res.statusCode = 423; res.end(JSON.stringify({ error: "Phone-use is paused" })); return; }
  if (req.headers["x-phone-use-token"] !== token) { res.statusCode = 401; res.end(JSON.stringify({ error: "wrong token" })); return; }
  if (req.url === "/apps") return res.end(JSON.stringify({ apps: [{ label: "Settings", package: "android.settings" }, { label: "Test one", package: "test.one" }, { label: "Test two", package: "test.two" }] }));
  if (req.url.startsWith("/screenshot")) return res.end(JSON.stringify({ data: "aW1hZ2U=", width: 10, height: 20, screen_width: 20, screen_height: 40, scale_to_screen: 2 }));
  res.end(JSON.stringify({ connected: true, text: "[0] Hello", screen: { text: "[0] Updated" } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const phone = new Phone({ url, token });
test.after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(temporary, { recursive: true, force: true });
});

const run = (args) => exec(process.execPath, [cli, ...args], { env: { ...process.env, PHONE_USE_URL: url, PHONE_USE_TOKEN: token }, timeout: 10000 });

test("client sends authenticated Unicode JSON", async () => {
  await phone.post("/type", { text: "café 日本語 👋" });
  assert.equal(JSON.parse(requests.at(-1).body).text, "café 日本語 👋");
  assert.equal(requests.at(-1).token, token);
});

test("HTTP errors and malformed responses remain errors", async () => {
  await assert.rejects(phone.get("/paused"), (e) => e.status === 423 && /paused/.test(e.message));
  await assert.rejects(phone.get("/invalid"), /invalid JSON/);
  await assert.rejects(new Phone({ url, token: "bad" }).get("/screen"), (e) => e.status === 401);
});

test("failed mutations are not retried", async () => {
  requests = [];
  await assert.rejects(phone.post("/drop"), /may have completed/);
  assert.equal(requests.filter((r) => r.url === "/drop").length, 1);
});

test("app matching refuses ambiguous names", async () => {
  assert.equal((await phone.findApp("settings")).package, "android.settings");
  await assert.rejects(phone.findApp("Test"), /several apps/);
  await assert.rejects(phone.findApp("missing"), /No installed app/);
});

test("configuration is private and malformed files are reported", () => {
  saveConfig({ url, token });
  assert.equal(loadConfig().token, token);
  if (process.platform !== "win32") assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
  fs.chmodSync(CONFIG_FILE, 0o644);
  saveConfig({ url, token });
  if (process.platform !== "win32") assert.equal(fs.statSync(CONFIG_FILE).mode & 0o777, 0o600);
  fs.writeFileSync(CONFIG_FILE, "broken");
  assert.throws(loadConfig, /Cannot read/);
  saveConfig({ url, token });
});

test("CLI dispatches Unicode text and validates arguments before sending", async () => {
  await run(["type", "café 👋", "--id", "2", "--append"]);
  assert.deepEqual(JSON.parse(requests.at(-1).body), { text: "café 👋", id: 2, append: true });
  const before = requests.length;
  await assert.rejects(run(["tap", "NaN"]), /Expected a number/);
  await assert.rejects(run(["scroll", "sideways"]), /must be one of/);
  await assert.rejects(run(["setup", "--port", "-1"]), /--port/);
  assert.equal(requests.length, before);
});

test("CLI explicitly saves a screenshot and refuses to overwrite it", async () => {
  const output = path.join(temporary, "shot.jpg");
  await run(["screenshot", output]);
  assert.equal(fs.readFileSync(output, "utf8"), "image");
  await assert.rejects(run(["screenshot", output]), /EEXIST/);
});

test("CLI provides a runnable MCP config without credentials", async () => {
  const { stdout } = await run(["config"]);
  const config = JSON.parse(stdout).mcpServers["phone-use"];
  assert.equal(config.command, process.execPath);
  assert.equal(config.args[1], "mcp");
  assert(!stdout.includes(token));
});
