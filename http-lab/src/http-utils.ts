import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { STATUS_CODES } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** An error that maps directly onto an HTTP status code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string = STATUS_CODES[status] ?? "Error",
    public readonly headers: OutgoingHttpHeaders = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Send a JSON response.
 *
 * We know the exact body size up front, so we set Content-Length. Without it,
 * Node would fall back to `Transfer-Encoding: chunked` (see the /stream lesson).
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const body = JSON.stringify(data, null, 2) + "\n";
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body), // bytes, NOT string length!
    ...headers,
  });
  res.end(body);
}

export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Read a request body into memory.
 *
 * `IncomingMessage` is a Readable stream, so the body arrives in chunks as TCP
 * packets arrive. `for await` turns that event stream into a simple loop.
 */
export async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<Buffer> {
  // Cheap early rejection: trust (but verify below) the Content-Length header.
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limitBytes) {
    throw new HttpError(413, "Payload Too Large", { Connection: "close" });
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    received += buf.length;
    // Content-Length can lie (or be absent when chunked), so count real bytes too.
    // Trade-off: bailing out of this loop destroys the request stream, which
    // usually tears down the socket, so a lying client may just see a reset.
    if (received > limitBytes) throw new HttpError(413, "Payload Too Large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Promise-based sleep that can be cancelled with an AbortSignal. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal });
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as NodeJS.ErrnoException).code === "ABORT_ERR");
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
