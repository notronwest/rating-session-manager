// The analyzer's network surface: submit a job, get called back, poll if you
// prefer. D-0243 clause 3 — a URL in, a versioned document out — and the thing
// the module could not do until now, which is be reached from somewhere else.
//
// WHY node:http AND NOT A FRAMEWORK. The boundary test refuses any import that
// is not a node builtin or a sibling in this directory, because the analyzer is
// meant to lift out of this repo whole. A framework dependency would make that
// lift a rewrite, and this surface is four routes.
//
// AUTHENTICATION IS WHERE THE TENANT COMES FROM. A caller does not say who it
// is; its key does. D-0243 clause 4 is "tenant-scoped from the first line", and
// a body-supplied tenant id would be a tenant claim rather than a tenant fact —
// one bad request away from reading another club's job.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { AnalyzerJobs, type JobSubmission } from "./jobs.js";
import { ANALYZER_SCHEMA_VERSION, type AnalyzerAsk } from "./document.js";

const ASKS: AnalyzerAsk[] = ["transcript", "cues", "timeline", "events", "fptm", "draft"];
/** Only this one is implemented. Asking for another is refused, not ignored. */
const IMPLEMENTED: AnalyzerAsk[] = ["transcript"];

/** A submission body is tiny. A cap stops a socket being used as free storage. */
const MAX_BODY_BYTES = 16 * 1024;

export interface ServerOptions {
  jobs: AnalyzerJobs;
  /**
   * API key → tenant. The engine holds no caller's database key (clause 4);
   * this is the only secret it holds, and it authorises nothing but analysis.
   */
  tenantForKey: (key: string) => string | undefined;
  log?: (line: string) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Read the body, refusing anything over the cap rather than buffering it. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`body over ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Build a `tenantForKey` that compares in constant time.
 *
 * A plain object lookup is constant-time on the hash, but every hand-written
 * resolver anyone will write instead is a `===` or a `.find()`, which
 * short-circuits on the first wrong byte and is measurable over a network. So
 * the engine ships the resolver rather than leaving it to each deployment: the
 * one secret it holds is the API key, and nothing else guards a tenant's jobs.
 */
export function keyMap(entries: Record<string, string>): (key: string) => string | undefined {
  const pairs = Object.entries(entries).map(([k, tenant]) => ({ buf: Buffer.from(k), tenant }));
  return (key: string) => {
    const given = Buffer.from(key);
    let found: string | undefined;
    // No early return: every entry is compared, so timing does not reveal
    // which key was close or how many keys exist.
    for (const p of pairs) {
      if (p.buf.length === given.length && timingSafeEqual(p.buf, given)) found = p.tenant;
    }
    return found;
  };
}

/** The bearer token, or undefined. `Bearer` is case-insensitive per RFC 6750. */
export function bearer(header: string | undefined): string | undefined {
  const m = /^bearer\s+(\S+)$/i.exec(String(header ?? "").trim());
  return m?.[1];
}

/** Validate a submission body. Returns the submission or a reason to refuse it. */
export function parseSubmission(raw: unknown): { ok: true; sub: JobSubmission } | { ok: false; why: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, why: "body must be a JSON object" };
  const b = raw as Record<string, unknown>;
  if (typeof b.video !== "string") return { ok: false, why: "video must be a URL or path" };
  let asks: AnalyzerAsk[] | undefined;
  if (b.asks !== undefined) {
    if (!Array.isArray(b.asks) || b.asks.length === 0) return { ok: false, why: "asks must be a non-empty array" };
    for (const a of b.asks) {
      if (typeof a !== "string" || !ASKS.includes(a as AnalyzerAsk)) {
        return { ok: false, why: `unknown ask ${JSON.stringify(a)}` };
      }
      if (!IMPLEMENTED.includes(a as AnalyzerAsk)) {
        // Refused rather than silently dropped: a caller that asked for the
        // drill timeline and got a document without one would read the absence
        // as "this lesson had no drills", which is a wrong answer dressed as an
        // answer. D-0243 clause 3's sections are absent when NOT ASKED FOR.
        return { ok: false, why: `${a} is not implemented yet; this engine answers ${IMPLEMENTED.join(", ")}` };
      }
    }
    asks = b.asks as AnalyzerAsk[];
  }
  const sub: JobSubmission = { video: b.video };
  if (asks) sub.asks = asks;
  if (b.callbackUrl !== undefined) {
    if (typeof b.callbackUrl !== "string") return { ok: false, why: "callbackUrl must be a string" };
    sub.callbackUrl = b.callbackUrl;
  }
  if (b.idempotencyKey !== undefined) {
    if (typeof b.idempotencyKey !== "string" || b.idempotencyKey.length > 200) {
      return { ok: false, why: "idempotencyKey must be a string of at most 200 characters" };
    }
    sub.idempotencyKey = b.idempotencyKey;
  }
  return { ok: true, sub };
}

/** What a caller is told about a job. Never the video link: it may be signed. */
export function jobView(job: { id: string; status: string; asks: string[]; submittedAt: string; finishedAt?: string; deliveries: { attempt: number; ok: boolean }[]; error?: string; document?: unknown }) {
  return {
    id: job.id,
    status: job.status,
    asks: job.asks,
    submittedAt: job.submittedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    deliveries: job.deliveries.length,
    ...(job.error ? { error: job.error } : {}),
    ...(job.document ? { document: job.document } : {}),
  };
}

export async function handle(opts: ServerOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "https://analyzer.invalid");
  const route = `${req.method} ${url.pathname}`.replace(/\/+$/, "");

  if (route === "GET /v1/health") {
    return json(res, 200, { ok: true, schema_version: ANALYZER_SCHEMA_VERSION, asks: IMPLEMENTED });
  }

  // Everything below is tenant work, so the key comes first.
  const key = bearer(req.headers.authorization);
  const tenant = key ? opts.tenantForKey(key) : undefined;
  if (!key || !tenant) {
    opts.log?.(`refused ${route}: no usable key`);
    return json(res, 401, { error: "a bearer key is required" });
  }
  if (route === "POST /v1/jobs") {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req) || "{}");
    } catch (err) {
      return json(res, 400, { error: `unreadable body: ${(err as Error).message}` });
    }
    const parsed = parseSubmission(body);
    if (!parsed.ok) return json(res, 400, { error: parsed.why });
    try {
      const job = opts.jobs.submit(tenant, parsed.sub);
      opts.log?.(`job ${job.id} queued for ${tenant}`);
      return json(res, 202, jobView(job));
    } catch (err) {
      // submit() throws only for a malformed job — a bad link, a bad callback.
      return json(res, 400, { error: (err as Error).message });
    }
  }

  const m = /^\/v1\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (m && req.method === "GET") {
    const job = opts.jobs.get(tenant, m[1]);
    // A job belonging to another tenant reads as missing. See AnalyzerJobs.get.
    if (!job) return json(res, 404, { error: "no such job" });
    return json(res, 200, jobView(job));
  }
  if (m && req.method === "DELETE") {
    const gone = opts.jobs.forget(tenant, m[1]);
    if (!gone) return json(res, 404, { error: "no such job" });
    return json(res, 200, { id: m[1], document: null });
  }

  return json(res, 404, { error: "no such route" });
}

/**
 * Bind the surface. The host is REQUIRED and has no default: a service that
 * defaults to every interface is one config file away from being public, and
 * this one reads customers' video links.
 */
export function createAnalyzerServer(opts: ServerOptions): Server {
  return createServer((req, res) => {
    handle(opts, req, res).catch((err) => {
      opts.log?.(`unhandled: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}
