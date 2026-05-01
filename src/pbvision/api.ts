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
  onLog(`Uploading ${filename} to pb.vision via Partner API...`);

  const client = getClient();
  let result: { vid?: string; hasCredits?: boolean };
  try {
    result = await client.uploadVideo(opts.videoPath, {
      userEmails: opts.userEmails ?? [],
      name: opts.name ?? filename,
      desc: opts.desc,
      gameStartEpoch: opts.gameStartEpoch,
      facility: opts.facility,
      court: opts.court,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PbvisionApiError("upload_failed", msg);
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
