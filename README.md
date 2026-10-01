# http-lab

A hands-on project for learning **HTTP**, **basic networking** and **async programming** in TypeScript.
It uses only Node's built-in `http`, `net`, `dns`, `os` and `stream` modules. No frameworks, so nothing is hidden.

## Setup

Requires Node 20.3+.

```bash
npm install
npm run dev        # server on http://127.0.0.1:3000 (auto-restarts on change)
```

Open <http://127.0.0.1:3000> for an index of lessons. Each one has a ready-to-paste `curl` example.

| Command | What it does |
|---|---|
| `npm run dev` | Run the server with live reload |
| `npm run demo` | Guided tour: a promise-based client hits every lesson (server must be running) |
| `npm run raw-client -- /stream` | Send an HTTP request over a bare TCP socket and print the raw bytes and timings |
| `npm run raw-server` | A web server written on `net` only: parses HTTP by hand on port 3001 |
| `npm run build && node dist/server.js` | Compile and run plain JS |
| `npm run typecheck` | Type-check only |

## Project layout

```
src/
  server.ts          createServer, timeouts, TCP/clientError events, graceful shutdown
  router.ts          tiny router: 404 vs 405, :params, HEAD handling
  middleware.ts      compose(), logger (timing, keep-alive counts), error handler
  routes.ts          one route per lesson
  http-utils.ts      sendJson, readBody (stream -> Buffer), sleep, HttpError
  http-client.ts     http.request wrapped in a Promise
  raw-tcp-server.ts  HTTP by hand over net.Server
  raw-client.ts      HTTP by hand over net.Socket (+ DNS/connect/TTFB timing)
  demo-client.ts     guided tour of the server
```

## HTTP concepts and where to see them

| Concept | Try | Look at |
|---|---|---|
| Request line, headers, body | `curl -i -X PUT -d hi localhost:3000/echo` | `/echo` |
| Header casing and order | same, then read `rawHeaders` | `/echo` |
| Status classes (2xx/3xx/4xx/5xx) | `curl -i localhost:3000/status/418` | `/status/:code` |
| 400 vs 413 vs 415 | POST bad JSON, wrong Content-Type, a huge body | `/json` |
| 404 vs 405 and `Allow` | `curl -i -X DELETE localhost:3000/json` | `router.ts` |
| Redirects | `curl -i localhost:3000/redirect` (then `-L`) | `/redirect` |
| Conditional requests / 304 | `npm run demo` (watch the `/cache` steps) | `/cache` |
| Content negotiation | open `/` in a browser vs `curl localhost:3000/` | `/` |
| Content-Length vs chunked | `curl -i localhost:3000/echo` vs `curl -i localhost:3000/stream` | `/stream` |
| Server-Sent Events | `curl -N localhost:3000/sse` | `/sse` |
| HEAD | `curl -I localhost:3000/echo` | `router.ts` |

## Networking concepts

- **HTTP is text over TCP.** Run `npm run raw-client`, then `PORT=3001 npm run raw-client -- /` against the hand-written server. Every `\r\n` is shown.
- **Chunked encoding on the wire.** `npm run raw-client -- /stream` shows the hex chunk size before each chunk.
- **Timing breakdown.** The raw client reports DNS lookup, TCP connect and time to first byte separately.
- **Keep-alive.** `curl localhost:3000/net localhost:3000/net` makes two requests on one connection. Watch the server log (`req #1`, `req #2`, same port).
- **Sockets are address:port pairs.** `/net` shows both ends of your connection, plus this machine's interfaces.
- **Binding.** `HOST=127.0.0.1` accepts only local connections. `HOST=0.0.0.0` accepts from your LAN.
- **DNS.** `/dns?name=localhost` uses `dns.lookup` (the OS resolver). Read the comment about how this differs from `dns.resolve`.
- **Failure modes.** `ECONNREFUSED` (nothing listening, see `npm run demo`), `EADDRINUSE` (start the server twice), malformed input (`clientError` in `server.ts`).

## Async concepts

- **Promisifying callbacks and events.** `http-client.ts`.
- **Streams with `for await`.** `readBody` reads a request, `raw-client.ts` reads a socket.
- **Async generators plus `pipeline`.** `/stream` produces data lazily and the client's socket speed controls the pace (backpressure).
- **Non-blocking I/O.** `/slow` serves other requests while waiting. Swap `sleep` for a busy `while` loop and watch everything freeze.
- **Sequential vs parallel.** `/concurrency`: `await` in a loop vs `Promise.all`. `npm run demo` also shows `Promise.allSettled`.
- **Cancellation.** `AbortController` fires when the client disconnects. Run `curl localhost:3000/slow?ms=5000`, press Ctrl-C and see `(client disconnected early)` in the log.
- **Timeouts.** `/timeout-demo` uses `AbortSignal.timeout` and `AbortSignal.any`, and maps the failure to `504`. Note the `/slow` call it cancels also logs `client disconnected early`.
- **Middleware as an async onion.** `compose()` in `middleware.ts`.
- **Promise rejection safety.** `server.ts` explains why the request listener needs `.catch()`.
- **Graceful shutdown.** Press Ctrl-C while `/sse` is open: the server stops accepting, drains, then force-closes after 3s.

## Experiments

1. Add a `/time` route returning the current time as JSON. Then make it return plain text when `Accept: text/plain`.
2. Add `Cache-Control` and `Last-Modified` handling; support `If-Modified-Since`.
3. Add an `OPTIONS` handler that returns the `Allow` header for any path.
4. Add `/upload` that streams the request body straight to a file with `pipeline` (no buffering in memory).
5. Add a simple rate limiter middleware keyed by `req.socket.remoteAddress` that returns `429` with `Retry-After`.
6. Make `/concurrency` limit itself to 3 requests in flight at a time (write a small `mapWithConcurrency` helper).
7. Serve gzip when the client sends `Accept-Encoding: gzip` using `zlib.createGzip()` in a `pipeline`.
8. Open Wireshark or `tcpdump -i lo0 port 3000` and compare it with the raw client output.
