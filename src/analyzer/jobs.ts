// The async job half of the analyzer. D-0243 clause 3, and the shape Ron
// approved on 2026-10-27: "you send the job, we call you back."
//
// WHY ASYNC AT ALL, rather than a long request. An hour of lesson video takes
// minutes to read and minutes more to decode — measured 0.50x realtime, and
// far worse when the file is on a slow share. No caller should hold a socket
// open for that, and no load balancer will let them.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It keeps no media (clause 4) and it
// writes nothing to disk: a finished document is held in memory only, until it
// has been delivered and its retention window has passed. Whether the engine
// should PERSIST structured output is the first item D-0243 left unsettled, so
// it is not decided here — and an in-memory hand-off is the one shape that
// does not pre-empt either answer.
//
// Nothing in this directory may know a club, a database or a path — see
// tests/analyzer-boundary.test.ts.

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { assertTenant, type AnalyzerAsk, type AnalyzerDocument } from "./document.js";
import { assertReadableVideo, type AnalyzerInput } from "./transcribe.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobSubmission {
  video: string;
  asks?: AnalyzerAsk[];
  /** Where to POST the finished document. Absent means the caller will poll. */
  callbackUrl?: string;
  /**
   * The caller's own key for this piece of work. Re-submitting with the same
   * key returns the SAME job rather than starting a second one.
   *
   * This is not a convenience. A caller that retries a submit because the
   * response was lost would otherwise pay for the same hour of video twice and
   * get two callbacks, and a receiver whose first write is permanent — the
   * Academy's draft columns are write-once — would freeze whichever arrived
   * first. Idempotency belongs on both ends; this is the engine's end.
   */
  idempotencyKey?: string;
}

export interface JobDelivery {
  attempt: number;
  at: string;
  ok: boolean;
  detail?: string;
}

export interface Job {
  id: string;
  tenant: string;
  status: JobStatus;
  asks: AnalyzerAsk[];
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Present once the analysis has run. Evicted after the retention window. */
  document?: AnalyzerDocument;
  deliveries: JobDelivery[];
  /** Set when the job could not be run at all, as opposed to a failed analysis. */
  error?: string;
}

/** What a job needs besides the submission: who may run it and how. */
export interface JobsOptions {
  /** The analysis itself. Injected so the queue is testable without whisper. */
  analyze: (input: AnalyzerInput) => Promise<AnalyzerDocument>;
  /** The analyzer's own scratch directory, handed to each job. */
  scratchDir: string;
  /** Per-tenant callback signing secret. A tenant with none gets an unsigned callback. */
  callbackSecret?: (tenant: string) => string | undefined;
  /** POST the body. Injected so tests never touch the network. */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; detail?: string }>;
  /** How long a finished document is kept in memory for polling. Default 1 hour. */
  retainMs?: number;
  /** Callback attempts, including the first. Default 4. */
  maxDeliveries?: number;
  /** Backoff before attempt n (1-based). Default 2s, 10s, 60s. */
  backoffMs?: (attempt: number) => number;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * The signature a receiver checks. HMAC-SHA256 of the exact bytes POSTed, so a
 * replayed or forged callback can be told apart from a real one — which matters
 * more than usual here, because a receiver's first write may be permanent.
 */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time check, for the receiving end. Exported because receivers need it. */
export function verifyBody(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(String(signature ?? ""));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function defaultPost(url: string, body: string, headers: Record<string, string>) {
  try {
    const res = await fetch(url, { method: "POST", body, headers });
    return { ok: res.ok, status: res.status, detail: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, detail: String((err as Error).message ?? err) };
  }
}

/**
 * One queue, run strictly one job at a time.
 *
 * SERIAL ON PURPOSE. The decode saturates the cores it is given and the read
 * saturates the link; two at once is slower than two in a row and starves
 * whatever else shares the machine. Concurrency is a deployment decision — run
 * more workers — not a thing this queue should invent.
 */
export class AnalyzerJobs {
  private jobs = new Map<string, Job>();
  private byIdem = new Map<string, string>();
  private queue: string[] = [];
  /**
   * The in-flight drain, or null. It is a PROMISE and not a boolean because a
   * boolean made `drain()` a lie: submit() starts the pump without awaiting it,
   * so a drain arriving while one was already running returned immediately and
   * a caller — a test, or a shutdown — read a job as finished that had not
   * started. Found by the callback-retry test, which saw one delivery where
   * three were owed.
   */
  private pumping: Promise<void> | null = null;
  private readonly o: Required<Pick<JobsOptions, "retainMs" | "maxDeliveries" | "backoffMs" | "now" | "log">> & JobsOptions;

  constructor(opts: JobsOptions) {
    this.o = {
      retainMs: 60 * 60 * 1000,
      maxDeliveries: 4,
      backoffMs: (n) => [2_000, 10_000, 60_000][Math.min(n, 3) - 1] ?? 60_000,
      now: () => Date.now(),
      log: () => {},
      ...opts,
    };
  }

  /** Accept a job. Throws on a malformed submission; that is the caller's bug. */
  submit(tenantRaw: string, sub: JobSubmission): Job {
    const tenant = assertTenant(tenantRaw);
    const video = assertReadableVideo(sub.video);
    if (sub.callbackUrl !== undefined) assertCallbackUrl(sub.callbackUrl);

    // Idempotency is scoped to the tenant, so two tenants may pick the same key.
    const idem = sub.idempotencyKey ? `${tenant}\u0000${sub.idempotencyKey}` : undefined;
    if (idem) {
      const existing = this.byIdem.get(idem);
      if (existing) {
        const job = this.jobs.get(existing);
        if (job) return job;
      }
    }

    const job: Job = {
      id: randomUUID(),
      tenant,
      status: "queued",
      asks: sub.asks ?? ["transcript"],
      submittedAt: new Date(this.o.now()).toISOString(),
      deliveries: [],
    };
    this.jobs.set(job.id, job);
    if (idem) this.byIdem.set(idem, job.id);
    this.queue.push(job.id);
    this.pending.set(job.id, { video, callbackUrl: sub.callbackUrl });
    void this.pump();
    return job;
  }

  private pending = new Map<string, { video: string; callbackUrl?: string }>();

  /**
   * Read a job back. TENANT-SCOPED, and a job belonging to another tenant is
   * reported as missing rather than forbidden — "forbidden" would confirm the
   * id exists, which is a cross-tenant leak made of one status code.
   */
  get(tenant: string, id: string): Job | null {
    const job = this.jobs.get(id);
    if (!job || job.tenant !== tenant) return null;
    return job;
  }

  /** Jobs waiting or running, oldest first. For a status page; never cross-tenant. */
  list(tenant: string): Job[] {
    return [...this.jobs.values()].filter((j) => j.tenant === tenant);
  }

  /**
   * Resolve when the queue is empty and nothing is running. A shutdown awaits
   * this so a finished analysis is delivered rather than dropped on exit.
   */
  async drain(): Promise<void> {
    await this.pump();
  }

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const run = (async () => {
      try {
        while (this.queue.length > 0) {
          const id = this.queue.shift()!;
          await this.runOne(id);
        }
      } finally {
        this.pumping = null;
      }
    })();
    this.pumping = run;
    return run;
  }

  private async runOne(id: string): Promise<void> {
    const job = this.jobs.get(id);
    const work = this.pending.get(id);
    if (!job || !work) return;
    this.pending.delete(id);
    job.status = "running";
    job.startedAt = new Date(this.o.now()).toISOString();

    let doc: AnalyzerDocument | undefined;
    try {
      doc = await this.o.analyze({
        tenant: job.tenant,
        video: work.video,
        scratchDir: this.o.scratchDir,
        asks: job.asks,
      });
    } catch (err) {
      // The analyzer returns a `failed` document for a failed analysis, so a
      // THROW here is the engine itself breaking. Say so separately: a caller
      // that cannot tell an unreadable video apart from a broken engine cannot
      // decide whether retrying is pointless.
      job.status = "failed";
      job.error = String((err as Error).message ?? err);
      job.finishedAt = new Date(this.o.now()).toISOString();
      this.o.log(`job ${job.id}: engine error — ${job.error}`);
      this.scheduleEviction(job.id);
      return;
    }

    job.document = doc;
    job.status = "done";
    job.finishedAt = new Date(this.o.now()).toISOString();
    if (work.callbackUrl) await this.deliver(job, work.callbackUrl);
    this.scheduleEviction(job.id);
  }

  private async deliver(job: Job, url: string): Promise<void> {
    const post = this.o.post ?? defaultPost;
    const secret = this.o.callbackSecret?.(job.tenant);
    for (let attempt = 1; attempt <= this.o.maxDeliveries; attempt++) {
      // The job stamp travels INSIDE the document, so a receiver that stores
      // only the document can still tell a replay from a new result.
      const body = JSON.stringify({ ...job.document, job: { id: job.id, attempt } });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-analyzer-job": job.id,
        "x-analyzer-attempt": String(attempt),
      };
      if (secret) headers["x-analyzer-signature"] = signBody(secret, body);
      const res = await post(url, body, headers);
      job.deliveries.push({
        attempt,
        at: new Date(this.o.now()).toISOString(),
        ok: res.ok,
        detail: res.detail,
      });
      if (res.ok) return;
      this.o.log(`job ${job.id}: callback attempt ${attempt} failed (${res.detail ?? res.status})`);
      if (attempt < this.o.maxDeliveries) {
        await new Promise((r) => setTimeout(r, this.o.backoffMs(attempt)));
      }
    }
  }

  /**
   * Forget the document once the window has passed. The job row stays, with its
   * status and its delivery log, so a caller asking later learns what happened
   * without the engine holding the analysis of someone's lesson indefinitely.
   */
  private scheduleEviction(id: string): void {
    const t = setTimeout(() => {
      const job = this.jobs.get(id);
      if (job) delete job.document;
    }, this.o.retainMs);
    // Never hold the process open for an eviction.
    (t as unknown as { unref?: () => void }).unref?.();
  }

  /** Drop a document now, without waiting for the window. For a tenant that asks. */
  forget(tenant: string, id: string): boolean {
    const job = this.get(tenant, id);
    if (!job) return false;
    delete job.document;
    return true;
  }
}

/**
 * A callback the engine is willing to POST to.
 *
 * `https` ONLY, and no credentials in the URL. A job's callback is a
 * caller-supplied destination that the engine will then make a request to, which
 * is the classic way a service is turned into someone else's request-forging
 * proxy — and the body it posts is the analysis of someone's lesson, so plain
 * http would put a named student's transcript on the wire in clear.
 *
 * There is deliberately no loopback exemption. A developer testing locally
 * injects `post` instead; an exemption written for a developer is a hole that
 * ships, and the analyzer may not name a host anyway (the boundary test refuses
 * one in code, and working around that test with string arithmetic would be
 * defeating the gate rather than passing it).
 */
export function assertCallbackUrl(raw: unknown): string {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error(`callback must be a URL; got ${JSON.stringify(raw)}`);
  }
  if (u.username || u.password) throw new Error("a callback URL may not carry credentials");
  if (u.protocol !== "https:") {
    throw new Error(`a callback URL must be https (got ${u.protocol.replace(":", "")})`);
  }
  return u.toString();
}
