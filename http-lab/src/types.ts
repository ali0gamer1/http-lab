import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Everything a handler needs to know about one request/response exchange.
 * Bundling it into one object keeps handler signatures small and lets
 * middleware attach extra data without touching Node's own objects.
 */
export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  /** Parsed request target (path + query string). */
  url: URL;
  /** Values captured from `:name` segments in the route pattern. */
  params: Record<string, string>;
  /**
   * Aborted when the client disconnects before we finished responding.
   * Pass it to anything async (timers, upstream requests) so we stop
   * wasting work on a response nobody will read.
   */
  signal: AbortSignal;
}

export type Handler = (ctx: Context) => Promise<void> | void;

/** Koa-style middleware: do work, `await next()` to run the rest of the chain, do more work. */
export type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;
