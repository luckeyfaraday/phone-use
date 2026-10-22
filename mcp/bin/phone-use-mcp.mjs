#!/usr/bin/env node
import fs from "node:fs";
import { Phone } from "../lib/client.mjs";
import { setup, doctor, connect, network } from "../lib/setup.mjs";
import { serveMcp, tools, validateArguments } from "../lib/mcp.mjs";
import { iosSetup, iosUp } from "../lib/ios/host.mjs";
import { VERSION } from "../lib/version.mjs";

const HELP = `Phone-Use — let an agent use your Android phone or iPhone

Android (USB setup, then optionally Wi-Fi/Tailscale):
  phone-use-mcp setup [--serial ID] [--apk FILE] [--port N] [--timeout SECONDS]
  phone-use-mcp network on|off [--serial ID] Enable/disable phone network access via USB

iPhone (runs on the computer the iPhone is plugged into; needs go-ios and WebDriverAgent):
  phone-use-mcp ios setup [--udid ID] [--bundle-id ID] [--port N] [--go-ios PATH]
  phone-use-mcp ios up [--network] [--wda-url URL] Keep the iPhone connected and serve it

Both:
  phone-use-mcp doctor
  phone-use-mcp mcp                         MCP over stdio (also the default)
  phone-use-mcp config                      Print an MCP client configuration
  phone-use-mcp connect URL                 Save a tested Wi-Fi/Tailscale connection
  phone-use-mcp status
  phone-use-mcp screen
  phone-use-mcp apps [SEARCH]
  phone-use-mcp open APP
  phone-use-mcp tap ID | X Y
  phone-use-mcp longpress ID | X Y
  phone-use-mcp type TEXT [--id N] [--append]
  phone-use-mcp scroll down|up|left|right [ID]
  phone-use-mcp swipe X1 Y1 X2 Y2 [MS]
  phone-use-mcp key back|home|recents|notifications|quick_settings
  phone-use-mcp screenshot FILE [--scale 0.25..1]
  phone-use-mcp pause                       Android: resume on the phone. iPhone: locks it; unlock to resume

Android setup requires Android 7+, USB debugging and adb. iPhone setup is in
docs/IOS.md. Use --help or --version for information.
`;

function parseOptions(args, allowed) {
  const values = [], options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") { values.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { values.push(arg); continue; }
    const name = arg.slice(2);
    const type = allowed[name];
    if (!type) throw new Error(`Unknown option ${arg}. See --help.`);
    if (type === "boolean") { options[name] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
    options[name] = type === "number" ? number(value) : value;
  }
  return { values, options };
}

function number(value) {
  const n = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(n)) throw new Error(`Expected a number, got ${JSON.stringify(value)}.`);
  return n;
}

function port(value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 65535)) throw new Error("--port must be an integer between 1 and 65535.");
}

function count(values, min, max = min) {
  if (values.length < min || values.length > max) throw new Error("Wrong number of arguments. See phone-use-mcp --help.");
}

async function main() {
  const [command = "mcp", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return console.log(HELP);
  if (["version", "--version", "-v"].includes(command)) return console.log(VERSION);
  if (command === "mcp") { count(args, 0); return serveMcp(); }
  if (command === "config") {
    count(args, 0);
    return console.log(JSON.stringify({ mcpServers: { "phone-use": { command: process.execPath, args: [fs.realpathSync(process.argv[1]), "mcp"] } } }, null, 2));
  }
  if (command === "setup") {
    const { values, options } = parseOptions(args, { serial: "string", apk: "string", port: "number", timeout: "number" });
    count(values, 0);
    if (options.timeout !== undefined && (options.timeout <= 0 || options.timeout > 3600)) throw new Error("--timeout must be between 0 and 3600 seconds.");
    port(options.port);
    await setup(options);
    console.error("Run phone-use-mcp config for the agent configuration, or phone-use-mcp screen to try it.");
    return;
  }
  if (command === "doctor") {
    count(args, 0);
    const result = await doctor();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (command === "ios") {
    const [sub, ...rest] = args;
    if (sub === "setup") {
      const { values, options } = parseOptions(rest, { udid: "string", "bundle-id": "string", port: "number", "go-ios": "string" });
      count(values, 0);
      port(options.port);
      await iosSetup({ udid: options.udid, bundleId: options["bundle-id"], port: options.port, goIos: options["go-ios"] });
      return;
    }
    if (sub === "up") {
      const { values, options } = parseOptions(rest, { network: "boolean", "wda-url": "string", "go-ios": "string" });
      count(values, 0);
      return iosUp({ network: options.network, wdaUrl: options["wda-url"], goIos: options["go-ios"] });
    }
    throw new Error("Use phone-use-mcp ios setup or phone-use-mcp ios up. See --help.");
  }
  if (command === "connect") { count(args, 1); return console.log(JSON.stringify(await connect(args[0]), null, 2)); }
  if (command === "network") {
    const { values, options } = parseOptions(args, { serial: "string" });
    count(values, 1);
    if (!["on", "off"].includes(values[0])) throw new Error("Use network on or network off.");
    return console.log(JSON.stringify(await network(values[0] === "on", options.serial)));
  }
  const phone = new Phone();
  if (command === "pause") { count(args, 0); return console.log(JSON.stringify(await phone.post("/pause"))); }
  let name, input = {}, outputFile;
  switch (command) {
    case "screen": case "status":
      count(args, 0); name = `phone_${command}`; break;
    case "apps":
      count(args, 0, 1); name = "phone_list_apps"; input = { search: args[0] ?? "" }; break;
    case "open":
      count(args, 1); name = "phone_open_app"; input = { app: args[0] }; break;
    case "tap": case "longpress":
      count(args, 1, 2); name = command === "tap" ? "phone_tap" : "phone_long_press";
      input = args.length === 1 ? { id: number(args[0]) } : { x: number(args[0]), y: number(args[1]) }; break;
    case "type": {
      const { values, options } = parseOptions(args, { id: "number", append: "boolean" });
      count(values, 1); name = "phone_type"; input = { text: values[0], ...options }; break;
    }
    case "scroll":
      count(args, 1, 2); name = "phone_scroll"; input = { direction: args[0], ...(args[1] === undefined ? {} : { id: number(args[1]) }) }; break;
    case "swipe":
      count(args, 4, 5); name = "phone_swipe"; input = Object.fromEntries(["x1", "y1", "x2", "y2", "ms"].slice(0, args.length).map((k, i) => [k, number(args[i])])); break;
    case "key":
      count(args, 1); name = "phone_key"; input = { key: args[0] }; break;
    case "screenshot": {
      const { values, options } = parseOptions(args, { scale: "number" });
      count(values, 1); name = "phone_screenshot"; input = options; outputFile = values[0]; break;
    }
    default: throw new Error(`Unknown command ${command}. See --help.`);
  }
  const tool = tools(phone).find((t) => t.name === name);
  validateArguments(tool.inputSchema, input);
  const result = await tool.run(input);
  if (outputFile) {
    fs.writeFileSync(outputFile, Buffer.from(result.find((item) => item.type === "image").data, "base64"), { flag: "wx", mode: 0o600 });
    console.log(`Saved ${outputFile}`);
  } else console.log(result);
}

main().catch((error) => { console.error(`phone-use: ${error.message}`); process.exitCode = 1; });
