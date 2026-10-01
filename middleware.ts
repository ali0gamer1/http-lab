import type { Socket } from "node:net";
import type { Context, Middleware } from "./types.js";
import { HttpError, isAbortError, sendJson } from "./http-utils.js";

/**
 * Run middleware in order, each one wrapping the next ("onion" model):
 *
 *   logger ─► errorHandler ─► router/handler
 *   logger ◄─ errorHandler ◄─ router/handler
 *
 * Because every `next()` returns a Promise, code after `await next()` runs
 * once everything inside has finished, which is how timing and error
 * handling work with plain async/await.
 */
export function compose(middleware: Middleware[]) {
  return (ctx: Context, last: () => Promise<void>): Promise<void> => {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error("next() called multiple times");
      index = i;
      if (i === middleware.length) return last();
      return middleware[i]!(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}

/**
 * How many requests has each TCP connection carried? With HTTP/1.1 keep-alive
 * the answer is often "more than one". WeakMap = entries vanish when the
 * socket is garbage collected, so no manual cleanup.
 */
const requestsPerSocket = new WeakMap<Socket, number>();

export function requestsOnConnection(socket: Socket): number {
  return requestsPerSocket.get(socket) ?? 0;
}

export const logger: Middleware = async (ctx, next) => {
  const { req, res } = ctx;
  const count = (requestsPerSocket.get(req.socket) ?? 0) + 1;
  requestsPerSocket.set(req.socket, count);

  const start = process.hrtime.bigint();

  // 'close' fires whether we finished the response OR the client hung up.
  // 'finish' only fires when we handed the whole response to the OS.
  res.once("close", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const outcome = res.writableFinished ? "" : " (client disconnected early)";
    console.log(
      `${req.method} ${ctx.url.pathname}${ctx.url.search} -> ${res.statusCode} ` +
        `${ms.toFixed(1)}ms [conn ${req.socket.remotePort}, req #${count}]${outcome}`,
    );
  });

  await next();
};

export const errorHandler: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    // The client left; there's nobody to answer. This is normal, not an error.
    if (ctx.signal.aborted || isAbortError(err)) return;

    const known = err instanceof HttpError;
    const status = known ? err.status : 500;
    const message = known ? err.message : "Internal Server Error";
    if (!known) console.error("Unhandled error:", err);

    // Once headers are sent the status line is history; all we can do is cut the connection.
    if (ctx.res.headersSent) {
      ctx.res.destroy();
      return;
    }
    sendJson(ctx.res, status, { error: message, status }, known ? err.headers : {});
  }
};
