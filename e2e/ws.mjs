/** Minimal RFC 6455 server side (text frames, ping/pong, close) for the mock Realtime endpoint. */
import { createHash } from "node:crypto";

export function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return void socket.destroy();
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  const ws = { onText: () => {}, onClose: () => {}, send: (t) => frame(socket, 0x1, Buffer.from(t)), close: () => { frame(socket, 0x8, Buffer.alloc(0)); socket.end(); } };
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, o = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
      const need = o + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(o + (masked ? 4 : 0), need);
      if (masked) { const m = buf.subarray(o, o + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
      buf = buf.subarray(need);
      if (op === 0x1) ws.onText(payload.toString("utf8"));
      else if (op === 0x9) frame(socket, 0xa, payload);
      else if (op === 0x8) { frame(socket, 0x8, Buffer.alloc(0)); socket.end(); }
    }
  });
  // HTTP servers keep half-open sockets; a client that went away must not keep the mock server from closing.
  socket.on("end", () => socket.destroy());
  socket.on("close", () => ws.onClose());
  socket.on("error", () => ws.onClose());
  return ws;
}

function frame(socket, op, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  socket.write(Buffer.concat([head, payload]));
}
