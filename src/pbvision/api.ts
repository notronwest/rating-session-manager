// Thin wrapper around @pbvision/partner-sdk so the rest of the codebase
// has a typed, single-import surface for pb.vision API calls.
//
// The SDK ships as JSDoc-annotated JS with no .d.ts files, so we re-declare
// just the methods we use. If the SDK adds new methods we want to call,
// extend the PBVisionClient interface below to match.
//
// Auth: x-api-key in HTTP header. We default to the prod server unless
// PBVISION_USE_TEST_SERVER=1 is set in .env (handy for sandbox testing
// without burning real credits).

import { PBVision } from "@pbvision/partner-sdk";
import fs from "fs";
import path from "path";

let cached: PBVision | null = null;

export class PbvisionApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function getClient(): PBVision {
  if (cached) return cached;
  const apiKey = process.env.PBVISION_API_KEY;
  if (!apiKey) {
    throw new PbvisionApiError(
      "missing_api_key",
      "PBVISION_API_KEY is not set in .env. Email support@pb.vision for a key.",
    );
  }
  const useProdServer = process.env.PBVISION_USE_TEST_SERVER !== "1";
  cached = new PBVision(apiKey, { useProdServer });
  return cached;
}

export interface UploadOptions {
  videoPath: string;
  /** Title shown on pb.vision. Defaults to the file basename. */
  name?: string;
  /**
   * Up to 4 player emails. pb.vision auto-emails these users with editor
   * access so they can self-tag the video, and notifies them when AI
   * processing completes.
   */
  userEmails?: string[];
  /** Unix epoch seconds. */
  gameStartEpoch?: number;
  desc?: string;
  facility?: string;
  court?: string;
  onLog?: (line: string) => void;
}

/**
 * Upload a single clip to pb.vision via the Partner API. Returns the new
 * video id (vid). Throws PbvisionApiError on failure.
 */
export async function uploadClipViaApi(opts: UploadOptions): Promise<{ vid: string }> {
  if (!opts.videoPath) {
    throw new PbvisionApiError("missing_path", "videoPath is required");
  }
  const onLog = opts.onLog ?? (() => {});
  const filename = path.basename(opts.videoPath);

  // Log the file size up front so a large HD clip doesn't *look* hung
  // when it's just slow. The SDK uploads to GCS in 8 MB chunks with no
  // progress callback, so without this the only signal is the single
  // "Uploading…" line below.
  let sizeMB = 0;
  try {
    sizeMB = fs.statSync(opts.videoPath).size / (1024 * 1024);
  } catch {
    /* stat failure is non-fatal — uploadVideo will surface a real error */
  }
  const sizeLabel = sizeMB > 0 ? ` (${sizeMB.toFixed(0)} MB)` : "";
  onLog(`Uploading ${filename}${sizeLabel} to pb.vision via Partner API...`);
  if (sizeMB > 400) {
    onLog(`  Note: large clip — this can take several minutes on a slow uplink.`);
  }

  const client = getClient();

  // The SDK's GCS chunk upload has no per-chunk timeout (node-fetch
  // doesn't time out by default), so a stalled chunk hangs forever with
  // zero output. Wrap the call with:
  //   • a heartbeat that logs elapsed seconds every 60s (liveness), and
  //   • an overall timeout that rejects so the session fails cleanly and
  //     can be resumed by re-running the upload, instead of sitting in
  //     limbo. Tune with PBVISION_UPLOAD_TIMEOUT_MS (default 45 min).
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    onLog(`  …still uploading ${filename} (${elapsed}s elapsed)`);
  }, 60_000);
  const timeoutMs =
    Number(process.env.PBVISION_UPLOAD_TIMEOUT_MS) || 45 * 60 * 1000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new PbvisionApiError(
          "upload_timeout",
          `Upload of ${filename}${sizeLabel} exceeded ${Math.round(timeoutMs / 60000)} min — ` +
            `the connection is likely stalled. Re-run the upload to resume from this clip.`,
        ),
      );
    }, timeoutMs);
  });

  let result: { vid?: string; hasCredits?: boolean };
  try {
    result = await Promise.race([
      client.uploadVideo(opts.videoPath, {
        userEmails: opts.userEmails ?? [],
        name: opts.name ?? filename,
        desc: opts.desc,
        gameStartEpoch: opts.gameStartEpoch,
        facility: opts.facility,
        court: opts.court,
      }),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err instanceof PbvisionApiError) throw err; // already typed (e.g. timeout)
    const msg = err instanceof Error ? err.message : String(err);
    throw new PbvisionApiError("upload_failed", msg);
  } finally {
    clearInterval(heartbeat);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  if (!result.vid) {
    if (result.hasCredits === false) {
      throw new PbvisionApiError(
        "no_credits",
        "pb.vision rejected the upload — the partner account has no credits available.",
      );
    }
    throw new PbvisionApiError(
      "no_vid_returned",
      "pb.vision returned no video id (and no hasCredits flag) — unexpected.",
    );
  }
  onLog(`Uploaded — vid=${result.vid}`);
  return { vid: result.vid };
}

/**
 * Tell pb.vision to POST processing-complete notifications to this URL.
 * One-time setup; pb.vision stores the URL per partner and uses it for
 * every subsequent video.
 */
export async function setPbvisionWebhook(webhookUrl: string): Promise<void> {
  await getClient().setWebhook(webhookUrl);
}

export async function setVideoEditorsAndViewers(
  vid: string,
  editorEmails: string[],
  viewerEmails: string[] = [],
): Promise<void> {
  await getClient().setVideoEditors(vid, editorEmails, viewerEmails);
}
