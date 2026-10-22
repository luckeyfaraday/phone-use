// A minimal usbmuxd client, to reach WebDriverAgent's port on the iPhone over USB. It replaces
// `ios forward`, which listens on every interface of this computer: WebDriverAgent has no
// authentication, so it gets no port here at all, and only `ios up` (behind the token) reaches it.
import net from "node:net";

const MUXD = process.platform === "win32" ? { host: "127.0.0.1", port: 27015 } : { path: "/var/run/usbmuxd" };

// ------------------------------------------------------------------ XML property lists

const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** A flat dictionary of strings and integers, as usbmuxd requests need. */
export function encodePlist(dict) {
  const body = Object.entries(dict).map(([k, v]) => `<key>${escape(k)}</key>${Number.isInteger(v) ? `<integer>${v}</integer>` : `<string>${escape(v)}</string>`}`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

/** Parses the dict, array, string, integer, real, boolean, data and date values usbmuxd sends. */
export function parsePlist(xml) {
  const tokens = [...String(xml).matchAll(/<(\/?)([A-Za-z]+)\b[^>]*?(\/?)>|([^<]+)/g)];
  let i = tokens.findIndex((t) => t[2] === "plist" && !t[1]) + 1;
  const text = () => (tokens[i]?.[4] !== undefined ? tokens[i++][4] : "");
  const close = (name) => {
    if (tokens[i]?.[1] !== "/" || tokens[i]?.[2] !== name) throw new Error(`Bad plist: expected </${name}>`);
    i++;
  };
  const value = () => {
    while (tokens[i]?.[4] !== undefined) i++; // whitespace between elements
    const [, end, name, selfClosing] = tokens[i++] ?? [];
    if (!name || end) throw new Error("Bad plist");
    if (selfClosing) return name === "true" ? true : name === "false" ? false : name === "dict" ? {} : name === "array" ? [] : "";
    switch (name) {
      case "dict": {
        const out = {};
        for (;;) {
          while (tokens[i]?.[4] !== undefined) i++;
          if (tokens[i]?.[1] === "/") { close("dict"); return out; }
          if (tokens[i++]?.[2] !== "key") throw new Error("Bad plist: expected <key>");
          const key = unescape(text());
          close("key");
          out[key] = value();
        }
      }
      case "array": {
        const out = [];
        for (;;) {
          while (tokens[i]?.[4] !== undefined) i++;
          if (tokens[i]?.[1] === "/") { close("array"); return out; }
          out.push(value());
        }
      }
      case "string": case "date": case "data": { const s = unescape(text()); close(name); return name === "data" ? s.replace(/\s/g, "") : s; }
      case "integer": { const n = Number(text().trim()); close(name); return n; }
      case "real": { const n = Number(text().trim()); close(name); return n; }
      default: throw new Error(`Bad plist: unexpected <${name}>`);
    }
  };
  return value();
}

// ------------------------------------------------------------------ usbmuxd protocol

/** One request on a fresh connection; resolves with the reply and the still-open socket. */
function request(message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(MUXD);
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      socket.destroy();
      reject(error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? new Error("usbmuxd isn't running. Connect the iPhone by USB (on Linux, install usbmuxd).")
        : error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error("usbmuxd didn't answer")));
    socket.on("error", fail);
    socket.on("connect", () => {
      const payload = Buffer.from(encodePlist({ ...message, ClientVersionString: "phone-use", ProgName: "phone-use" }));
      const header = Buffer.alloc(16);
      header.writeUInt32LE(16 + payload.length, 0);
      header.writeUInt32LE(1, 4); // version: plist
      header.writeUInt32LE(8, 8); // message type: plist
      header.writeUInt32LE(1, 12); // tag
      socket.write(Buffer.concat([header, payload]));
    });
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < buffer.readUInt32LE(0)) return;
      const length = buffer.readUInt32LE(0);
      socket.off("data", onData);
      socket.setTimeout(0);
      socket.off("error", fail);
      try {
        resolve({ reply: parsePlist(buffer.subarray(16, length).toString("utf8")), socket, rest: buffer.subarray(length) });
      } catch (error) {
        fail(error);
      }
    };
    socket.on("data", onData);
  });
}

/** USB-connected devices: [{ id, udid }]. */
export async function usbDevices() {
  const { reply, socket } = await request({ MessageType: "ListDevices" });
  socket.destroy();
  return (reply.DeviceList ?? [])
    .filter((d) => d.Properties?.ConnectionType === "USB")
    .map((d) => ({ id: d.DeviceID, udid: d.Properties.SerialNumber }));
}

/** A raw TCP connection to `port` on the device, through usbmuxd. */
export async function connectDevice(deviceId, port) {
  // usbmuxd wants the port in network byte order, read as a little-endian integer.
  const { reply, socket, rest } = await request({ MessageType: "Connect", DeviceID: deviceId, PortNumber: ((port & 0xff) << 8) | (port >> 8) });
  if (reply.MessageType !== "Result" || reply.Number !== 0) {
    socket.destroy();
    throw new Error(`usbmuxd couldn't connect to port ${port} on the iPhone (result ${reply.Number}).`);
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}

/** () => Promise<socket> to devicePort on the iPhone with this UDID, for the WebDriverAgent client. */
export function connector(udid, devicePort) {
  return async () => {
    // Look the device up each time: its usbmuxd ID changes when it's replugged.
    const device = (await usbDevices()).find((d) => d.udid === udid);
    if (!device) throw Object.assign(new Error("The iPhone isn't connected by USB."), { code: "ENODEV" });
    return connectDevice(device.id, devicePort);
  };
}
