import http from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export interface RequestOptions {
  method?: string;
  headers?: OutgoingHttpHeaders;
  body?: string | Buffer;
  /** Abort the request (and close its socket) when this signal fires. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  statusMessage: string;
  httpVersion: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * `http.request` is callback/event based. This wraps it in a Promise so callers
 * can simply `await request(url)`. It's the classic "promisify" pattern:
 *
 *   - resolve() once the whole response body has arrived ('end')
 *   - reject()  on any network-level failure ('error'): DNS failure,
 *               connection refused, reset, abort...
 *
 * Note that a 404 or 500 is NOT an error here; the HTTP exchange succeeded.
 * Only failures to *complete* the exchange reject.
 */
export function request(url: string | URL, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers, signal: options.signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            httpVersion: res.httpVersion,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(options.body); // sends headers + body, then signals "request complete"
  });
}
