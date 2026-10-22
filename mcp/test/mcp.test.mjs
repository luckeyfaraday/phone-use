import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { serveMcp } from "../lib/mcp.mjs";

async function rpc(messages, phone = {}) {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const done = serveMcp(phone, { input, output });
  input.end(messages.map((m) => typeof m === "string" ? m : JSON.stringify(m)).join("\n") + "\n");
  await done;
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}
const initialize = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } };
const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("MCP initializes, lists tools, ignores notifications and negotiates unsupported versions", async () => {
  const results = await rpc([
    { ...initialize, params: { protocolVersion: "future" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].result.protocolVersion, "2025-11-25");
  assert.equal(results[1].result.tools.length, 11);
  assert(results[1].result.tools.every((t) => !t.run && t.inputSchema.additionalProperties === false));
});

test("malformed input produces protocol errors and never crashes", async () => {
  const result = await rpc(["{", null, [], { jsonrpc: "2.0", id: 3, method: "tools/list" }, initialize, { jsonrpc: "2.0", id: 4, method: "missing" }]);
  assert.equal(result.find((r) => r.error?.code === -32700).id, null);
  assert.equal(result.filter((r) => r.error?.code === -32600).length, 3);
  assert.equal(result.find((r) => r.id === 4).error.code, -32601);
});

test("invalid tool arguments cannot dispatch phone actions", async () => {
  let requests = 0;
  const phone = { get: async () => { requests++; }, post: async () => { requests++; } };
  const result = await rpc([initialize,
    call(1, "phone_tap", {}), call(2, "phone_tap", { x: 5 }), call(3, "phone_type", { text: 9 }),
    call(4, "phone_scroll", { direction: "sideways" }), call(5, "phone_screenshot", { scale: 0 }),
    call(6, "phone_tap", { id: -1 }), call(7, "phone_type", { text: "ok", hidden: true }),
    call(8, "phone_type", []),
  ], phone);
  assert.equal(requests, 0);
  assert(result.slice(1).every((r) => r.result.isError));
});

test("pipelined calls execute sequentially so a tap sees the preceding screen ids", async () => {
  const order = [];
  const phone = {
    get: async () => { order.push("read"); await new Promise((r) => setTimeout(r, 20)); order.push("read done"); return { text: "[0] Button" }; },
    post: async (path, body) => { order.push("tap"); assert.equal(path, "/tap"); assert.deepEqual(body, { id: 0 }); return { screen: { text: "Opened" } }; },
  };
  const result = await rpc([initialize, call(1, "phone_screen", {}), call(2, "phone_tap", { id: 0 })], phone);
  assert.deepEqual(order, ["read", "read done", "tap"]);
  assert.equal(result[2].result.content[0].text, "Opened");
});

test("screenshots are image blocks and paused errors reach the agent", async () => {
  const phone = { get: async (route) => {
    if (route.startsWith("/screenshot")) return { data: "eA==", width: 100, height: 200, screen_width: 200, screen_height: 400, scale_to_screen: 2 };
    throw new Error("Phone-use is paused");
  } };
  const result = await rpc([initialize, call(1, "phone_screenshot", {}), call(2, "phone_screen", {})], phone);
  assert.equal(result[1].result.content[0].type, "image");
  assert.equal(result[1].result.content[0].mimeType, "image/jpeg");
  assert.equal(result[2].result.isError, true);
  assert.match(result[2].result.content[0].text, /paused/);
});
