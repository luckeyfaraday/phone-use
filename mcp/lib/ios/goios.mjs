// Runs go-ios (https://github.com/danielpaulus/go-ios), which talks to the iPhone over USB:
// device info, the iOS 17+ tunnel, the developer disk image, WebDriverAgent and port forwarding.
import { execFile } from "node:child_process";

/** go-ios binary: --go-ios, $GO_IOS, or `ios` on PATH. */
export const goIosPath = (explicit) => explicit ?? process.env.GO_IOS ?? "ios";

export function goIos(bin, args, { udid, timeoutMs = 30_000, env } = {}) {
  const full = [...args, ...(udid ? [`--udid=${udid}`] : [])];
  return new Promise((resolve, reject) => {
    execFile(bin, full, { timeout: timeoutMs, maxBuffer: 64 << 20, env: env ?? process.env }, (error, stdout, stderr) => {
      if (error?.code === "ENOENT") return reject(new Error(`go-ios isn't installed (looked for "${bin}"). Download it from https://github.com/danielpaulus/go-ios/releases and put \`ios\` on your PATH, or set GO_IOS.`));
      if (error) return reject(new Error(`go-ios ${args.join(" ")}: ${logError(stderr) ?? logError(stdout) ?? (String(stderr).trim().split("\n").pop() || error.message)}`));
      // go-ios reports many failures as log lines and still exits 0, so callers check for the data
      // they expect and use explain() for the reason when it's missing.
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** Why a go-ios call produced nothing useful: its first ERROR/FATAL log line, as "msg: err". */
export const explain = (output) => logError(output) ?? "no output";

/** The first ERROR/FATAL log line go-ios printed, as "msg: err". */
export function logError(output) {
  for (const entry of jsonLines(output)) {
    if (["ERROR", "FATAL"].includes(String(entry?.level).toUpperCase())) return [entry.msg, entry.err ?? entry.error].filter(Boolean).join(": ");
  }
  return null;
}

/** go-ios prints one JSON value per line, mixed with log lines. */
export function jsonLines(output) {
  const values = [];
  for (const line of String(output).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") && !t.startsWith("[")) continue;
    try { values.push(JSON.parse(t)); } catch {}
  }
  return values;
}

export async function listDevices(bin) {
  const output = await goIos(bin, ["list"]);
  const found = jsonLines(output).find((v) => Array.isArray(v?.deviceList));
  if (!found) {
    // On Linux, usbmuxd only runs while an iPhone is plugged in.
    if (/usbmuxd/.test(explain(output))) return [];
    throw new Error(`Couldn't list iPhones: ${explain(output)}`);
  }
  return found.deviceList;
}

/** Pick the iPhone to use: the given UDID, or the only one connected. */
export function selectIphone(udids, udid) {
  if (udid) {
    if (!udids.includes(udid)) throw new Error(`iPhone ${udid} isn't connected. Connected: ${udids.join(", ") || "none"}.`);
    return udid;
  }
  if (!udids.length) throw new Error("No iPhone found. Connect it with a USB cable, unlock it, and tap Trust on the phone if it asks.");
  if (udids.length > 1) throw new Error(`Several iPhones are connected; choose one with --udid: ${udids.join(", ")}`);
  return udids[0];
}

/** iOS version and model identifier (e.g. "26.1", "iPhone14,2"). The device name isn't read: it often contains the owner's name. */
export async function deviceInfo(bin, udid) {
  const output = await goIos(bin, ["info"], { udid });
  const info = jsonLines(output).find((v) => v?.ProductVersion);
  if (!info) throw Object.assign(new Error(`Couldn't read the iPhone's iOS version (${explain(output)}). Unlock it and tap Trust if it asks.`), { notReady: true });
  return { version: info.ProductVersion, model: info.ProductType ?? "iPhone" };
}

export const majorVersion = (version) => Number(String(version).split(".")[0]);

/** Apps a person can open, as the Android app reports them: { package, label, system }. */
export async function installedApps(bin, udid) {
  return parseApps(await goIos(bin, ["apps", "--all"], { udid, timeoutMs: 60_000 }));
}

/** `ios apps --all` also lists hidden system bundles (CarPlay settings, extensions…): drop those. */
export function parseApps(output) {
  const lists = jsonLines(output).filter(Array.isArray);
  if (!lists.length) throw new Error(`Couldn't list the iPhone's apps: ${explain(output)}`);
  return lists.flat()
    .filter((a) => a?.CFBundleIdentifier && a.ApplicationType !== "Hidden" && !(a.SBAppTags ?? []).includes("hidden"))
    .map((a) => ({ package: a.CFBundleIdentifier, label: a.CFBundleDisplayName || a.CFBundleName || a.CFBundleIdentifier, system: a.ApplicationType === "System" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

const isRunner = (app) => /xctrunner$/i.test(app.package) || /WebDriverAgent/i.test(app.label);

/** The installed WebDriverAgent runner's bundle ID: the given one, or the only one found. */
export function findRunner(apps, bundleId) {
  if (bundleId) {
    if (!apps.some((a) => a.package === bundleId)) throw new Error(`${bundleId} isn't installed on the iPhone. Sign and install WebDriverAgent first (see docs/IOS.md).`);
    return bundleId;
  }
  const runners = apps.filter(isRunner);
  if (!runners.length) throw new Error("WebDriverAgent isn't installed on the iPhone. Sign and install it first: see docs/IOS.md.");
  if (runners.length > 1) throw new Error(`Several WebDriverAgent builds are installed; choose one with --bundle-id: ${runners.map((a) => a.package).join(", ")}`);
  return runners[0].package;
}

/** Apps an agent may open: everything except test runners. */
export const userApps = (apps) => apps.filter((a) => !isRunner(a));
