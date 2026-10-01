import http from "node:http";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, sendJson } from "./http-utils.js";
import { compose, errorHandler, logger } from "./middleware.js";
import { createRouter } from "./routes.js";
import type { Context } from "./types.js";

const PORT = Number(process.env.PORT ?? 3000);
// 127.0.0.1 = only this machine. Use HOST=0.0.0.0 to accept connections from your LAN.
const HOST = process.env.HOST ?? "127.0.0.1";

const router = createRouter();
const chain = compose([logger, errorHandler]);

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Cancellation plumbing: abort `signal` if the client goes away mid-response.
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  let url: URL;
  try {
    // req.url is just the "request target" (e.g. "/echo?x=1"); the base is only needed to parse it.
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendJson(res, 400, { error: "Malformed request target", status: 400 });
    return;
  }

  const ctx: Context = { req, res, url, params: {}, signal: controller.signal };

  await chain(ctx, async () => {
    const match = router.match(req.method ?? "GET", url.pathname);
    switch (match.kind) {
      case "found":
        ctx.params = match.params;
        await match.handler(ctx);
        return;
      case "method-not-allowed":
        throw new HttpError(405, "Method Not Allowed", { Allow: match.allowed.join(", ") });
      case "not-found":
        throw new HttpError(404, `No route for ${url.pathname}`);
    }
  });
}

const server = http.createServer((req, res) => {
  // Node ignores the return value of this listener, so a rejected promise would
  // become an "unhandled rejection" (which crashes modern Node). Always .catch(). 
  handle(req, res).catch((err) => {
    console.error("Fatal error in request handler:", err);
    res.destroy();
  });
});

// Timeouts protect the server from slow or stalled clients.
server.keepAliveTimeout = 5_000; // close idle keep-alive connections after 5s
server.headersTimeout = 10_000; // client must finish sending headers within 10s
server.requestTimeout = 30_000; // client must finish sending the whole request within 30s

// A "connection" is one TCP connection; many HTTP requests can share it.
server.on("connection", (socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[tcp] + opened  ${peer}`);
  socket.once("close", () => console.log(`[tcp] - closed  ${peer}`));
});

// Emitted when bytes arrive that aren't valid HTTP. Try: `printf 'garbage\r\n\r\n' | nc 127.0.0.1 3000`
server.on("clientError", (err, socket) => {
  console.log(`[http] bad request: ${err.message}`);
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  } else {
    socket.destroy();
  }
});

try {
  server.listen(PORT, HOST);
  await once(server, "listening"); // rejects if 'error' fires first (e.g. EADDRINUSE)
} catch (err) {
  console.error(`Could not listen on ${HOST}:${PORT}:`, (err as Error).message);
  process.exit(1);
}
console.log(`http-lab listening on http://${HOST}:${PORT}  (open it in a browser for the lesson index)`);

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal}: no longer accepting connections, draining...`);
  server.close(); // stop accepting; 'close' is emitted once all connections end
  server.closeIdleConnections(); // drop keep-alive connections that are doing nothing
  // Long-lived responses (SSE, /stream) would hold us open forever, so set a deadline.
  setTimeout(() => {
    console.log("Grace period over: closing remaining connections.");
    server.closeAllConnections();
  }, 3_000).unref();
  await once(server, "close");
  console.log("Bye.");
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
