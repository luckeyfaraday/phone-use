import test from "node:test";
import assert from "node:assert/strict";
import { setup, selectDevice, parseSettings, network } from "../lib/setup.mjs";

const token = "a".repeat(48);
test("device selection requires a specific, authorized device", () => {
  assert.throws(() => selectDevice([]), /No Android/);
  assert.throws(() => selectDevice([{ serial: "a", state: "unauthorized" }]), /USB debugging prompt/);
  assert.throws(() => selectDevice([{ serial: "a", state: "offline" }]), /offline/);
  const list = [{ serial: "a", state: "device" }, { serial: "b", state: "device" }];
  assert.throws(() => selectDevice(list), /--serial/);
  assert.equal(selectDevice(list, "b").serial, "b");
  assert.throws(() => selectDevice(list, "c"), /not connected/);
});

test("settings parser validates credentials and port without echoing output", () => {
  assert.deepEqual(parseSettings(`Row: 0 token=${token}, port=7333, network=0, version=0.1.0`), { token, port: 7333, network: false });
  assert.throws(() => parseSettings(`Row: 0 token=${token}, port=99999`), /Could not read/);
  assert.throws(() => parseSettings("Permission denied"), /Could not read/);
});

function harness({ availableAfter = 1, installedApi = 29, existingForward = "", failure } = {}) {
  const calls = [], saved = [], logs = [];
  let attempts = 0, clock = 0;
  return { calls, saved, logs, deps: {
    exists: () => true,
    now: () => clock,
    delay: async (ms) => { clock += ms; },
    log: (s) => logs.push(s),
    devices: async () => [{ serial: "phone", state: "device", model: "Test" }],
    saveConfig: (c) => saved.push(c),
    adb: async (args, options) => {
      calls.push({ args, options });
      if (args.includes("getprop")) return String(installedApi);
      if (args.includes("query")) return `Row: 0 token=${token}, port=7333, network=0`;
      if (args.includes("--list")) return existingForward;
      return "Success";
    },
    makePhone: (config) => ({ get: async (route) => {
      assert.equal(route, "/status");
      assert.equal(config.devicePort, 7333);
      if (++attempts < availableAfter) throw failure ?? new Error("Not enabled");
      return { device: "Android test phone", connected: true };
    } }),
  } };
}

test("setup waits for phone consent, maps a custom port, and saves only a working connection", async () => {
  const h = harness({ availableAfter: 3 });
  await setup({ apk: "/test.apk", port: 7444, timeout: 5 }, h.deps);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].url, "http://127.0.0.1:7444");
  assert(h.calls.some(({ args }) => args.join(" ") === "forward --no-rebind tcp:7444 tcp:7333"));
  assert(h.calls.some(({ args }) => args.includes("dev.phoneuse/.MainActivity")));
  assert(!h.calls.some(({ args }) => args.some((a) => /appops|settings|input|grant/.test(a))));
  assert(!h.logs.join("\n").includes(token));
});

test("consent timeout preserves the user's existing connection", async () => {
  const h = harness({ availableAfter: Infinity });
  await assert.rejects(setup({ timeout: 2 }, h.deps), /not enabled yet/);
  assert.deepEqual(h.saved, []);
});

test("setup rejects unsupported Android before installing", async () => {
  const h = harness({ installedApi: 23 });
  await assert.rejects(setup({}, h.deps), /Android 7/);
  assert(!h.calls.some(({ args }) => args[0] === "install"));
});

test("setup preserves an existing correct forward and reports authentication failures", async () => {
  const h = harness({ existingForward: "phone tcp:7333 tcp:7333\n", availableAfter: Infinity, failure: Object.assign(new Error("wrong token"), { status: 401 }) });
  await assert.rejects(setup({}, h.deps), /wrong token/);
  assert(!h.calls.some(({ args }) => args.includes("--no-rebind")));
  assert.deepEqual(h.saved, []);
});

test("network toggle reports a phone-side failure instead of claiming success", async () => {
  const devices = async () => [{ serial: "phone", state: "device" }];
  const failed = "Error while accessing provider:dev.phoneuse.token\njava.lang.IllegalStateException: could not reopen the listener; network access is still off\n\tat android.os.Parcel.readException(Parcel.java:1691)";
  await assert.rejects(network(true, "phone", { devices, adb: async () => failed }), /Could not turn network access on: could not reopen the listener; network access is still off\./);
  assert.deepEqual(await network(false, "phone", { devices, adb: async () => "" }), { network: false });
});
