import type { Request, RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Cloudflare Access gate for traffic that arrives through the Cloudflare
 * Tunnel (see deploy/cloudflared/). This app has no login of its own, so
 * anything reaching Express from the public internet must carry a valid
 * Cloudflare Access JWT — Access issues it after the user signs in at the
 * edge and forwards it as `Cf-Access-Jwt-Assertion`.
 *
 *   - LAN / localhost requests (no Cloudflare headers) pass untouched, so
 *     the Caddy-served LAN site and dev keep working with no login.
 *   - Requests via Cloudflare must present a JWT that verifies against the
 *     team's JWKS (CF_ACCESS_TEAM_DOMAIN) for this app's AUD tag
 *     (CF_ACCESS_AUD). Anything else is 403.
 *   - FAIL CLOSED: if either variable is unset, every request that came
 *     through Cloudflare is refused. A tunnel with no Access policy in front
 *     of it would otherwise expose the whole pipeline to the internet.
 *   - CF_ACCESS_DISABLE=1 switches the gate off (local debugging only).
 *
 * Belt and braces: with Access configured in the dashboard, unauthenticated
 * users never reach the mini at all. This gate is what stops a missing or
 * misconfigured Access policy from silently making the app public.
 */

const TEAM = process.env.CF_ACCESS_TEAM_DOMAIN?.trim() || "";
const AUD = process.env.CF_ACCESS_AUD?.trim() || "";

/** True when the request was proxied by Cloudflare (i.e. came via the tunnel). */
export function isViaCloudflare(req: Request): boolean {
  return Boolean(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]);
}

/** `wmpc` or `wmpc.cloudflareaccess.com` → `https://wmpc.cloudflareaccess.com` */
function accessIssuer(): string | null {
  if (!TEAM) return null;
  const host = TEAM.includes(".") ? TEAM : `${TEAM}.cloudflareaccess.com`;
  return `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}

export interface CfAccessGateOptions {
  /** Exact paths that skip the gate (e.g. a health check for the tunnel smoke test). */
  exempt?: string[];
}

export function cfAccessGate(opts: CfAccessGateOptions = {}): RequestHandler {
  const exempt = new Set(opts.exempt ?? []);

  if (process.env.CF_ACCESS_DISABLE === "1") {
    console.warn(
      "[cf-access] CF_ACCESS_DISABLE=1 — traffic arriving via Cloudflare is NOT authenticated. Never run like this on the mini.",
    );
    return (_req, _res, next) => next();
  }

  const issuer = accessIssuer();
  const configured = Boolean(issuer && AUD);
  const jwks = configured
    ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
    : null;

  if (!configured) {
    console.warn(
      "[cf-access] CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not set — requests arriving via Cloudflare will be refused (403) until they are. LAN access is unaffected.",
    );
  } else {
    console.log(`[cf-access] gating tunnel traffic against ${issuer} (aud …${AUD.slice(-8)})`);
  }

  return async (req, res, next) => {
    if (!isViaCloudflare(req)) return next();
    if (exempt.has(req.path)) return next();

    if (!configured || !jwks || !issuer) {
      res.status(403).json({
        error: "cf_access_not_configured",
        message:
          "This host is only reachable through Cloudflare Access, and the server has no CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD configured. See deploy/cloudflared/README.md.",
      });
      return;
    }

    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string" || !token) {
      res.status(403).json({
        error: "cf_access_required",
        message: "Missing Cloudflare Access token. Sign in through Cloudflare Access to use this host.",
      });
      return;
    }

    try {
      await jwtVerify(token, jwks, { issuer, audience: AUD });
      next();
    } catch (err) {
      console.warn(`[cf-access] rejected ${req.method} ${req.path}: ${(err as Error).message}`);
      res.status(403).json({
        error: "cf_access_invalid",
        message: "Cloudflare Access token is invalid or expired. Sign in again.",
      });
    }
  };
}
