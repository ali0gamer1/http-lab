import { createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { STATUS_CODES } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { request } from "./http-client.js";
import { HttpError, clamp, escapeHtml, readBody, sendJson, sendText, sleep } from "./http-utils.js";
import { requestsOnConnection } from "./middleware.js";
import { Router } from "./router.js";

interface Lesson {
  path: string;
  title: string;
  teaches: string;
  example: string;
}

/** The index page is generated from this list, so docs can't drift from code. */
export const lessons: Lesson[] = [
  { path: "/echo", title: "Anatomy of a request", teaches: "Request line, headers, body, and the TCP connection underneath.", example: "curl -i -X PUT -d 'hello' localhost:3000/echo" },
  { path: "/query", title: "Query strings", teaches: "URL parsing; repeated keys.", example: "curl 'localhost:3000/query?tag=a&tag=b&name=Ada'" },
  { path: "/json", title: "JSON bodies & validation", teaches: "Content-Type, 400 vs 415 vs 413, reading a body stream.", example: "curl -i -X POST -H 'Content-Type: application/json' -d '{\"hi\":1}' localhost:3000/json" },
  { path: "/status/:code", title: "Status codes", teaches: "What each status class means; 204/304 have no body.", example: "curl -i localhost:3000/status/418" },
  { path: "/redirect", title: "Redirects", teaches: "3xx + Location header.", example: "curl -i localhost:3000/redirect   (add -L to follow)" },
  { path: "/cache", title: "Caching with ETag", teaches: "Conditional requests and 304 Not Modified.", example: "curl -i localhost:3000/cache   then repeat with -H 'If-None-Match: <etag>'" },
  { path: "/slow", title: "Non-blocking I/O", teaches: "Slow requests don't block each other; cancellation on disconnect.", example: "curl 'localhost:3000/slow?ms=3000'  (Ctrl-C and watch the server log)" },
  { path: "/concurrency", title: "Sequential vs parallel", teaches: "await in a loop vs Promise.all; the server calls itself over HTTP.", example: "curl 'localhost:3000/concurrency?n=5&ms=300'" },
  { path: "/timeout-demo", title: "Timeouts & 504", teaches: "AbortSignal.timeout, AbortSignal.any, gateway errors.", example: "curl -i 'localhost:3000/timeout-demo?limit=300&upstream=2000'" },
  { path: "/stream", title: "Chunked streaming", teaches: "Transfer-Encoding: chunked, streams, async generators, backpressure.", example: "curl -N localhost:3000/stream" },
  { path: "/sse", title: "Server-Sent Events", teaches: "A long-lived response used as a push channel.", example: "curl -N 'localhost:3000/sse?count=5'" },
  { path: "/net", title: "Sockets & interfaces", teaches: "IP/port pairs, keep-alive connection reuse, network interfaces.", example: "curl localhost:3000/net localhost:3000/net   (one curl, two requests, one connection)" },
  { path: "/dns", title: "DNS lookup", teaches: "Turning names into addresses.", example: "curl 'localhost:3000/dns?name=localhost'" },
];

export function createRouter(): Router {
  const router = new Router();

  // ---------------------------------------------------------------- index
  router.get("/", (ctx) => {
    // Content negotiation: same URL, different representation depending on `Accept`.
    ctx.res.setHeader("Vary", "Accept"); // tell caches the response depends on Accept
    const wantsHtml = (ctx.req.headers.accept ?? "").includes("text/html");
    if (!wantsHtml) {
      sendJson(ctx.res, 200, { lessons });
      return;
    }
    const items = lessons
      .map(
        (l) =>
          `<li><strong><a href="${escapeHtml(l.path.replace(":code", "418"))}">${escapeHtml(l.title)}</a></strong> ` +
          `&mdash; ${escapeHtml(l.teaches)}<br><code>${escapeHtml(l.example)}</code></li>`,
      )
      .join("\n");
    sendText(
      ctx.res,
      200,
      `<!doctype html><meta charset="utf-8"><title>http-lab</title>
<style>body{font:16px/1.5 system-ui;max-width:52rem;margin:2rem auto;padding:0 1rem}li{margin:.8rem 0}code{font-size:.85em;background:#8882;padding:.1em .3em;border-radius:3px}</style>
<h1>http-lab</h1><p>Try these in a browser, with <code>curl -i</code>, or with the DevTools Network tab open.</p><ul>${items}</ul>`,
      "text/html; charset=utf-8",
    );
  });

  // ----------------------------------------------------------------- echo
  router.all("/echo", async (ctx) => {
    const { req } = ctx;
    const body = await readBody(req, 64 * 1024);
    sendJson(ctx.res, 200, {
      requestLine: { method: req.method, target: req.url, httpVersion: req.httpVersion },
      headers: req.headers, // Node lower-cases names and merges duplicates
      rawHeaders: req.rawHeaders, // original casing and order, as alternating name/value
      body: body.length > 0 ? body.toString("utf8") : null,
      connection: {
        clientAddress: req.socket.remoteAddress,
        clientPort: req.socket.remotePort,
        requestsOnThisConnection: requestsOnConnection(req.socket),
      },
    });
  });

  // ---------------------------------------------------------------- query
  router.get("/query", (ctx) => {
    const params: Record<string, string[]> = {};
    for (const key of new Set(ctx.url.searchParams.keys())) {
      params[key] = ctx.url.searchParams.getAll(key);
    }
    sendJson(ctx.res, 200, { pathname: ctx.url.pathname, search: ctx.url.search, params });
  });

  // ----------------------------------------------------------------- json
  router.post("/json", async (ctx) => {
    const contentType = (ctx.req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json"); // Unsupported Media Type
    }
    const raw = await readBody(ctx.req, 10 * 1024); // may throw 413
    let data: unknown;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "Body is not valid JSON"); // client's fault => 4xx
    }
    sendJson(ctx.res, 201, { id: randomUUID(), received: data, bytes: raw.length });
  });

  // --------------------------------------------------------------- status
  router.get("/status/:code", (ctx) => {
    const code = Number(ctx.params.code);
    if (!Number.isInteger(code) || code < 200 || code > 599) {
      throw new HttpError(400, "Pick an integer status between 200 and 599");
    }
    // These statuses must not include a body.
    if (code === 204 || code === 205 || code === 304) {
      ctx.res.writeHead(code);
      ctx.res.end();
      return;
    }
    sendJson(ctx.res, code, { status: code, meaning: STATUS_CODES[code] ?? "Unassigned" });
  });

  router.get("/redirect", (ctx) => {
    ctx.res.writeHead(302, { Location: "/echo" });
    ctx.res.end();
  });

  // ---------------------------------------------------------------- cache
  router.get("/cache", (ctx) => {
    const body = JSON.stringify({ message: "This content never changes", version: 1 }) + "\n";
    const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 16)}"`;
    const headers: OutgoingHttpHeaders = { ETag: etag, "Cache-Control": "public, max-age=10" };

    // The client says "I already have the version tagged X". If that's still
    // current, skip sending the body entirely.
    if (ctx.req.headers["if-none-match"] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    for (const [name, value] of Object.entries(headers)) ctx.res.setHeader(name, value!);
    sendText(ctx.res, 200, body, "application/json; charset=utf-8");
  });

  // ----------------------------------------------------------------- slow
  router.get("/slow", async (ctx) => {
    const ms = clamp(Number(ctx.url.searchParams.get("ms") ?? 1000), 0, 10_000);
    // While we "wait", the event loop is free to serve other requests.
    // Compare with a busy `while (Date.now() < end) {}` loop, which would freeze everyone.
    // If the client disconnects, ctx.signal aborts and sleep() rejects early.
    await sleep(ms, ctx.signal);
    sendJson(ctx.res, 200, {
      sleptMs: ms,
      id: ctx.url.searchParams.get("id"),
      finishedAt: new Date().toISOString(),
    });
  });

  // ---------------------------------------------------------- concurrency
  router.get("/concurrency", async (ctx) => {
    const n = clamp(Math.trunc(Number(ctx.url.searchParams.get("n") ?? 3)), 1, 10);
    const ms = clamp(Number(ctx.url.searchParams.get("ms") ?? 300), 50, 1000);
    const port = ctx.req.socket.localPort;
    const urlFor = (i: number) => `http://127.0.0.1:${port}/slow?ms=${ms}&id=${i}`;

    // The server makes real HTTP requests to itself. That only works because
    // waiting on I/O doesn't block the event loop.

    // 1) Sequential: each await finishes before the next request starts.  ~ n * ms
    let t = performance.now();
    for (let i = 0; i < n; i++) {
      await request(urlFor(i), { signal: ctx.signal });
    }
    const sequentialMs = performance.now() - t;

    // 2) Parallel: start all requests immediately, wait for all of them.  ~ ms
    t = performance.now();
    const responses = await Promise.all(
      Array.from({ length: n }, (_, i) => request(urlFor(i), { signal: ctx.signal })),
    );
    const parallelMs = performance.now() - t;

    sendJson(ctx.res, 200, {
      requests: n,
      perRequestMs: ms,
      sequentialMs: Math.round(sequentialMs),
      parallelMs: Math.round(parallelMs),
      statuses: responses.map((r) => r.status),
      note: "Sequential ≈ n × ms. Parallel ≈ ms, because the waits overlap.",
    });
  });

  // -------------------------------------------------------- timeout-demo
  router.get("/timeout-demo", async (ctx) => {
    const limit = clamp(Number(ctx.url.searchParams.get("limit") ?? 500), 50, 5000);
    const upstreamMs = clamp(Number(ctx.url.searchParams.get("upstream") ?? 2000), 0, 10_000);
    const url = `http://127.0.0.1:${ctx.req.socket.localPort}/slow?ms=${upstreamMs}`;

    const timeout = AbortSignal.timeout(limit);
    try {
      // Abort if EITHER the client left OR our time budget ran out.
      const upstream = await request(url, { signal: AbortSignal.any([ctx.signal, timeout]) });
      sendJson(ctx.res, 200, { upstreamStatus: upstream.status, upstreamBody: JSON.parse(upstream.body) });
    } catch (err) {
      // We're acting as a gateway: an upstream that's too slow is a 504, not our bug (500).
      if (timeout.aborted && !ctx.signal.aborted) {
        throw new HttpError(504, `Upstream did not answer within ${limit}ms`);
      }
      throw err;
    }
  });

  // --------------------------------------------------------------- stream
  async function* ticker(count: number, ms: number, signal: AbortSignal): AsyncGenerator<string> {
    for (let i = 1; i <= count; i++) {
      await sleep(ms, signal);
      yield `chunk ${i}/${count} at ${new Date().toISOString()}\n`;
    }
  }

  router.get("/stream", async (ctx) => {
    // No Content-Length (we don't know it yet) => Node uses `Transfer-Encoding: chunked`.
    ctx.res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    // pipeline() connects the readable to the response, respects backpressure
    // (pauses the generator if the client's socket is slow) and cleans up on errors.
    await pipeline(Readable.from(ticker(10, 300, ctx.signal)), ctx.res);
  });

  // ------------------------------------------------------------------ sse
  router.get("/sse", async (ctx) => {
    const countParam = ctx.url.searchParams.get("count");
    const max = countParam ? clamp(Math.trunc(Number(countParam)), 1, 1000) : Infinity;

    ctx.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    ctx.res.write("retry: 3000\n\n"); // browsers' EventSource reconnect delay

    for (let id = 1; id <= max; id++) {
      const payload = JSON.stringify({ tick: id, time: new Date().toISOString() });
      ctx.res.write(`id: ${id}\nevent: tick\ndata: ${payload}\n\n`); // blank line ends an event
      await sleep(1000, ctx.signal); // rejects when the client disconnects
    }
    ctx.res.end();
  });

  // ------------------------------------------------------------------ net
  router.get("/net", (ctx) => {
    const { socket } = ctx.req;
    const interfaces = Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
      (addrs ?? [])
        .filter((a) => a.family === "IPv4")
        .map((a) => ({ name, address: a.address, loopback: a.internal })),
    );
    sendJson(ctx.res, 200, {
      client: { address: socket.remoteAddress, port: socket.remotePort, family: socket.remoteFamily },
      server: { address: socket.localAddress, port: socket.localPort },
      connection: {
        requestsOnThisConnection: requestsOnConnection(socket),
        connectionHeader: ctx.req.headers.connection ?? null,
        bytesReadSoFar: socket.bytesRead,
        bytesWrittenSoFar: socket.bytesWritten,
      },
      host: { hostname: os.hostname(), ipv4Interfaces: interfaces },
    });
  });

  router.get("/dns", async (ctx) => {
    const name = ctx.url.searchParams.get("name") ?? "localhost";
    if (name.length > 253) throw new HttpError(400, "Hostname too long");
    try {
      // dns.lookup uses the OS resolver (getaddrinfo): /etc/hosts, system DNS config, etc.
      // dns.resolve* talks to DNS servers directly instead. Different code paths!
      const addresses = await dns.lookup(name, { all: true });
      sendJson(ctx.res, 200, { name, addresses });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new HttpError(404, `Could not resolve "${name}" (${code ?? "unknown error"})`);
    }
  });

  return router;
}
