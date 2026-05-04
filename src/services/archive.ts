// Archive source recordings + their per-game clip directories into a
// `processed/` sibling folder once a session is fully done. Keeps the
// active videos/ listing tidy without throwing anything away.
//
// Layout:
//   videos/Thursday 4_2_2026 ....mp4               <- source recording
//   videos/Thursday 4_2_2026 ....mp4_clips/        <- per-game clips
//
// Becomes:
//   videos/processed/Thursday 4_2_2026 ....mp4
//   videos/processed/Thursday 4_2_2026 ....mp4_clips/
//
// Session.video_path and Session.clip_paths are rewritten in the same
// pass, so links from the UI keep working after archive.

import fs from "fs";
import path from "path";
import { listSessions, updateSession } from "../db/index.js";
import type { Session } from "../types.js";

export interface ArchiveResult {
  sessionId: string;
  label: string | null;
  moved: string[];
  skipped: string[];
  newVideoPath?: string;
}

const PROCESSED_DIR_NAME = "processed";

function isInProcessed(p: string): boolean {
  // Match the segment exactly so a session named "processed" doesn't
  // accidentally count as already-archived.
  return p.split(path.sep).includes(PROCESSED_DIR_NAME);
}

/**
 * Move a single session's source video + clips dir into ./processed/
 * relative to the source video's parent. Idempotent.
 */
export async function archiveSessionVideo(session: Session): Promise<ArchiveResult> {
  const result: ArchiveResult = {
    sessionId: session.id,
    label: session.label,
    moved: [],
    skipped: [],
  };

  if (!session.video_path) {
    result.skipped.push("no video_path on session");
    return result;
  }

  const sourcePath = session.video_path;
  const sourceDir = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);

  if (isInProcessed(sourceDir)) {
    result.skipped.push("already inside a processed/ directory");
    return result;
  }

  if (!fs.existsSync(sourcePath)) {
    result.skipped.push(`source missing on disk: ${sourcePath}`);
    return result;
  }

  const processedDir = path.join(sourceDir, PROCESSED_DIR_NAME);
  try {
    fs.mkdirSync(processedDir, { recursive: true });
  } catch (err) {
    result.skipped.push(`mkdir processed/ failed: ${(err as Error).message}`);
    return result;
  }

  const targetVideo = path.join(processedDir, sourceName);
  if (fs.existsSync(targetVideo)) {
    result.skipped.push(`target already exists: ${targetVideo}`);
    return result;
  }

  // Move the source recording.
  try {
    fs.renameSync(sourcePath, targetVideo);
    result.moved.push(`${sourceName} → processed/`);
  } catch (err) {
    result.skipped.push(`rename source failed: ${(err as Error).message}`);
    return result;
  }

  // Move the clips directory if present, and update clip_paths.
  const clipsDir = `${sourcePath}_clips`;
  let newClipsDir: string | null = null;
  if (fs.existsSync(clipsDir)) {
    newClipsDir = path.join(processedDir, `${sourceName}_clips`);
    if (fs.existsSync(newClipsDir)) {
      result.skipped.push(`clips target already exists: ${newClipsDir}`);
    } else {
      try {
        fs.renameSync(clipsDir, newClipsDir);
        result.moved.push(`${path.basename(clipsDir)}/ → processed/`);
      } catch (err) {
        // Roll back the source rename so we don't end up half-archived.
        try {
          fs.renameSync(targetVideo, sourcePath);
          result.moved.pop();
        } catch {
          /* ignored — leave the partial state with a clear log */
        }
        result.skipped.push(`rename clips failed: ${(err as Error).message}`);
        return result;
      }
    }
  }

  // Rewrite the session's stored paths so the UI keeps linking correctly.
  const oldClipPaths = session.clip_paths || [];
  const newClipPaths = newClipsDir
    ? oldClipPaths.map((cp) => (cp.startsWith(clipsDir) ? newClipsDir + cp.slice(clipsDir.length) : cp))
    : oldClipPaths;

  await updateSession(session.id, {
    video_path: targetVideo,
    clip_paths: newClipPaths.length > 0 ? newClipPaths : null,
  });
  result.newVideoPath = targetVideo;

  return result;
}

/**
 * Apply archiveSessionVideo to every session whose status is `complete`
 * and that still has its source video outside processed/. Returns
 * per-session results so the caller can summarise.
 */
export async function archiveAllCompletedSessions(): Promise<ArchiveResult[]> {
  const sessions = await listSessions();
  const results: ArchiveResult[] = [];
  for (const session of sessions) {
    if (session.status !== "complete") continue;
    if (!session.video_path) continue;
    try {
      const r = await archiveSessionVideo(session);
      results.push(r);
    } catch (err) {
      results.push({
        sessionId: session.id,
        label: session.label,
        moved: [],
        skipped: [`unexpected error: ${(err as Error).message}`],
      });
    }
  }
  return results;
}
