/**
 * Make an HTTP request using nothing but a TCP socket, and print the raw bytes
 * that come back. Great for seeing what `curl -i` hides (e.g. chunk sizes).
 *
 *   npm run raw-client                 # GET /echo from localhost:3000
 *   npm run raw-client -- /stream      # watch chunked encoding on the wire
 *   PORT=3001 npm run raw-client -- /  # talk to the hand-written server
 */
import net from "node:net";
import { once } from "node:events";
import { performance } from "node:perf_hooks";

const path = process.argv[2] ?? "/echo";
const host = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);

const visible = (s: string) => s.replaceAll("\r\n", "\\r\\n\n");
const fmt = (ms: number) => `${ms.toFixed(1)}ms`;

async function main(): Promise<void> {
  const t0 = performance.now();
  let tLookup: number | undefined;

  const socket = net.connect({ host, port });
  socket.once("lookup", () => (tLookup = performance.now())); // only fires for hostnames, not IPs

  await once(socket, "connect"); // resolves after the TCP handshake; rejects on 'error'
  const tConnect = performance.now();
  console.log(`Connected to ${socket.remoteAddress}:${socket.remotePort} from local port ${socket.localPort}\n`);

  const request = [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}:${port}`, // mandatory in HTTP/1.1: one IP can serve many sites
    "User-Agent: raw-client/1.0",
    "Accept: */*",
    "Connection: close", // ask the server to close when done so our loop ends
    "",
    "",
  ].join("\r\n");

  console.log(">>> REQUEST BYTES\n" + visible(request));
  socket.write(request);

  let tFirstByte: number | undefined;
  let chunks = 0;
  let total = 0;
  const parts: Buffer[] = [];

  // A socket is an async iterable of Buffers: the loop ends when the server closes its side.
  for await (const data of socket) {
    tFirstByte ??= performance.now();
    chunks++;
    total += (data as Buffer).length;
    parts.push(data as Buffer);
  }
  const tEnd = performance.now();

  console.log("<<< RESPONSE BYTES\n" + visible(Buffer.concat(parts).toString("utf8")));
  console.log("--- timing");
  console.log(`DNS lookup     : ${tLookup === undefined ? "n/a (host is an IP address)" : fmt(tLookup - t0)}`);
  console.log(`TCP connect    : ${fmt(tConnect - (tLookup ?? t0))}`);
  console.log(`Time to 1st byte: ${fmt((tFirstByte ?? tEnd) - tConnect)} (after the request was sent)`);
  console.log(`Total          : ${fmt(tEnd - t0)}  (${total} bytes in ${chunks} TCP read(s))`);
}

main().catch((err: Error) => {
  console.error(`Failed: ${err.message}  (is the server running on ${host}:${port}?)`);
  process.exitCode = 1;
});
