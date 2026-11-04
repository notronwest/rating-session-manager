// Signed lesson-video tokens (D-0273 rule 6; rsm#102).
//
// The contract is minted by third-shot-academy's `lesson-video-token` edge
// function and verified here; both sides must agree byte for byte:
//   token   = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadB64))
//   payload = { v: 1, k: "clip" | "rec", lid: lessonId, mid: markId | null,
//               f: recording_ref | null, sub: userId, exp: unix seconds }
// `k:"clip"` names the clip file derived from (lid, mid). `k:"rec"` names the whole
// recording `f` (the coach's marking page). No caller-supplied path exists: the
// file on disk is derived from validated ids, never joined from the token text.

import crypto from "node:crypto";

export interface LessonVideoPayload {
  v: 1;
  k: "clip" | "rec";
  lid: string;
  mid: string | null;
  f: string | null;
  sub: string;
  exp: number;
}

export type TokenVerdict =
  | { ok: true; payload: LessonVideoPayload }
  | { ok: false; reason: "unconfigured" | "malformed" | "bad-signature" | "expired" | "bad-claims" };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `teaching/<date>/<base>` — exactly what lesson-transcribe writes to recording_ref. */
export const RECORDING_REF_RE = /^teaching\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A secret shorter than this is treated as unset: a guessable key is no key. */
const MIN_SECRET_LEN = 16;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signLessonVideoToken(secret: string, payload: LessonVideoPayload): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = crypto.createHmac("sha256", secret).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

export function verifyLessonVideoToken(
  token: string,
  secret: string | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenVerdict {
  // Fail closed: an unset secret refuses every request, the way an unset
  // CF_ACCESS_* does.
  if (!secret || secret.length < MIN_SECRET_LEN) return { ok: false, reason: "unconfigured" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [body, sig] = parts;

  const want = crypto.createHmac("sha256", secret).update(body).digest();
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return { ok: false, reason: "malformed" }; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    return { ok: false, reason: "bad-signature" };
  }

  let p: Partial<LessonVideoPayload>;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "malformed" }; }
  if (!p || typeof p !== "object") return { ok: false, reason: "malformed" };

  if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || p.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  const claimsOk =
    p.v === 1 &&
    typeof p.sub === "string" && UUID_RE.test(p.sub) &&
    typeof p.lid === "string" && UUID_RE.test(p.lid) &&
    ((p.k === "clip" && typeof p.mid === "string" && UUID_RE.test(p.mid)) ||
      (p.k === "rec" && typeof p.f === "string" && RECORDING_REF_RE.test(p.f)));
  if (!claimsOk) return { ok: false, reason: "bad-claims" };
  return { ok: true, payload: p as LessonVideoPayload };
}
