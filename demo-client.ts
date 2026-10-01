/**
 * A guided tour of the server using our promise-based client.
 * Start the server first (`npm run dev`), then run `npm run demo`.
 */
import { request } from "./http-client.js";
import type { HttpResponse } from "./http-client.js";

const base = process.env.BASE_URL ?? "http://127.0.0.1:3000";

async function step(title: string, run: () => Promise<HttpResponse>): Promise<HttpResponse | undefined> {
  console.log(`\n=== ${title}`);
  try {
    const r = await run();
    console.log(`HTTP/${r.httpVersion} ${r.status} ${r.statusMessage}`);
    for (const h of ["content-type", "content-length", "transfer-encoding", "allow", "etag", "location"]) {
      if (r.headers[h]) console.log(`${h}: ${r.headers[h]}`);
    }
    if (r.body) console.log(r.body.length > 300 ? r.body.slice(0, 300) + " …" : r.body.trimEnd());
    return r;
  } catch (err) {
    console.log("request failed:", (err as Error).message);
    return undefined;
  }
}

const json = { "Content-Type": "application/json" };

await step("GET /echo", () => request(`${base}/echo`, { headers: { "X-Demo": "hello" } }));
await step("POST valid JSON (expect 201)", () =>
  request(`${base}/json`, { method: "POST", headers: json, body: JSON.stringify({ name: "Ada" }) }));
await step("POST broken JSON (expect 400)", () =>
  request(`${base}/json`, { method: "POST", headers: json, body: "{nope" }));
await step("POST wrong Content-Type (expect 415)", () =>
  request(`${base}/json`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" }));
await step("DELETE /json (expect 405 + Allow header)", () => request(`${base}/json`, { method: "DELETE" }));
await step("GET /nope (expect 404)", () => request(`${base}/nope`));
await step("GET /status/418", () => request(`${base}/status/418`));

const first = await step("GET /cache (first time: full body)", () => request(`${base}/cache`));
const etag = first?.headers.etag;
if (etag) {
  await step("GET /cache again with If-None-Match (expect 304, no body)", () =>
    request(`${base}/cache`, { headers: { "If-None-Match": etag } }));
}

await step("GET /concurrency (sequential vs parallel)", () => request(`${base}/concurrency?n=5&ms=200`));
await step("GET /timeout-demo (expect 504)", () => request(`${base}/timeout-demo?limit=200&upstream=1500`));

// Promise.allSettled: run things in parallel and inspect every outcome, even failures.
console.log("\n=== Promise.allSettled across good, bad-status and unreachable targets");
const targets = [`${base}/echo`, `${base}/status/500`, "http://127.0.0.1:1/"]; // port 1: nothing listens
const outcomes = await Promise.allSettled(targets.map((t) => request(t)));
outcomes.forEach((o, i) => {
  if (o.status === "fulfilled") {
    console.log(`${targets[i]} -> HTTP ${o.value.status}  (a 500 is still a *successful exchange*)`);
  } else {
    console.log(`${targets[i]} -> rejected: ${(o.reason as NodeJS.ErrnoException).code ?? o.reason}`);
  }
});
