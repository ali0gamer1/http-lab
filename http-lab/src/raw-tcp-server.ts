/**
 * HTTP is just text sent over a TCP connection. This server skips Node's `http`
 * module and speaks HTTP by hand using the lower-level `net` module.
 *
 *   npm run raw-server
 *   curl -i http://127.0.0.1:3001/hello
 */
import net from "node:net";

const PORT = Number(process.env.RAW_PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

/** Show \r\n explicitly so you can see the real line endings HTTP uses. */
const visible = (s: string) => s.replaceAll("\r\n", "\\r\\n\n");

const server = net.createServer((socket) => {
  console.log(`\n[tcp] connection from ${socket.remoteAddress}:${socket.remotePort}`);
  socket.setEncoding("utf8");
  socket.setTimeout(5_000, () => socket.destroy()); // don't let silent clients linger
  socket.on("error", (err) => console.log(`[tcp] socket error: ${err.message}`));

  let buffer = "";
  let answered = false;

  // TCP is a byte STREAM: one request may arrive in several 'data' events,
  // so we accumulate until we see the blank line that ends the HTTP head.
  socket.on("data", (chunk: string) => {
    if (answered) return;
    buffer += chunk;
    const headEnd = buffer.indexOf("\r\n\r\n");
    if (headEnd === -1) return;
    answered = true;

    const head = buffer.slice(0, headEnd);
    console.log("[http] raw request head:\n" + visible(head + "\r\n\r\n"));

    const [requestLine = "", ...headerLines] = head.split("\r\n");
    const [method, target, version] = requestLine.split(" ");
    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }

    let status = "200 OK";
    let body = [
      `You sent: ${method} ${target} (${version})`,
      `Host header: ${headers.get("host") ?? "(none)"}`,
      `User-Agent: ${headers.get("user-agent") ?? "(none)"}`,
      `Header count: ${headers.size}`,
      "",
      "This response was written by hand over a raw TCP socket.",
      "",
    ].join("\n");

    if (!method || !target || !version?.startsWith("HTTP/")) {
      status = "400 Bad Request";
      body = "That doesn't look like HTTP.\n";
    }

    // A response is: status line, headers, blank line, body. Every line ends with \r\n.
    const response = [
      `HTTP/1.1 ${status}`,
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`, // tells the client where the body ends
      "Connection: close", // we close after one response, so no keep-alive
      "",
      body,
    ].join("\r\n");

    socket.end(response); // write + half-close our side (FIN)
  });

  socket.on("close", () => console.log("[tcp] connection closed"));
});

server.listen(PORT, HOST, () => {
  console.log(`raw TCP "HTTP" server on ${HOST}:${PORT}  (try: curl -i http://${HOST}:${PORT}/hello)`);
});
