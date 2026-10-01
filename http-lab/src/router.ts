import type { Handler } from "./types.js";

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

export type MatchResult =
  | { kind: "found"; handler: Handler; params: Record<string, string> }
  | { kind: "method-not-allowed"; allowed: string[] }
  | { kind: "not-found" };

/**
 * A deliberately tiny router. It teaches three HTTP ideas:
 *  - the method + path pair selects a handler
 *  - 404 means "no such resource"; 405 means "resource exists, wrong method"
 *  - HEAD is GET without a response body
 */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    // "/status/:code" -> /^\/status\/([^/]+)$/ with keys ["code"]
    const source = path.replace(/:(\w+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  get(path: string, handler: Handler): this {
    return this.add("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.add("POST", path, handler);
  }

  /** Register the same handler for every common method. */
  all(path: string, handler: Handler): this {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) this.add(method, path, handler);
    return this;
  }

  match(method: string, pathname: string): MatchResult {
    // Node automatically drops the body when responding to HEAD,
    // so we can reuse the GET handler as-is.
    const lookup = method === "HEAD" ? "GET" : method;
    const allowed = new Set<string>();

    for (const route of this.routes) {
      const m = route.pattern.exec(pathname);
      if (!m) continue;
      if (route.method !== lookup) {
        allowed.add(route.method);
        continue;
      }
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(m[i + 1] ?? "");
      });
      return { kind: "found", handler: route.handler, params };
    }

    return allowed.size > 0
      ? { kind: "method-not-allowed", allowed: [...allowed] }
      : { kind: "not-found" };
  }
}
