// Wraps scripts/pbvision-tag.py — drives pb.vision's tagging modal to
// assign player names to a video's four slots. Reuses the same persistent
// Chromium profile as the login + (legacy) upload scripts.
//
// pb.vision exposes no REST API for tagging; this is the only path to
// auto-tag without asking players to do it themselves.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const TAG_SCRIPT = path.join(ROOT, "scripts", "pbvision-tag.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export class TagError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TagOptions {
  vid: string;
  /** Player names in slot order (0-3). Must be exactly 4 entries. */
  names: string[];
  /** Default true. When false, runs Chromium headless. */
  headed?: boolean;
  onLog?: (line: string) => void;
}

export interface TagResult {
  videoId: string;
  flow: "first-time" | "re-edit";
  tagged: { slot: number; name: string }[];
  skipped: { slot: number; name: string; reason: string }[];
}

// Per-vid lock so the same video can't be tagged twice in parallel —
// the underlying Playwright profile is single-instance.
const tagsInFlight = new Set<string>();

export function tagPbVisionVideo(opts: TagOptions): Promise<TagResult> {
  if (!opts.vid) {
    return Promise.reject(new TagError("missing_vid", "vid is required"));
  }
  if (!opts.names || opts.names.length !== 4) {
    return Promise.reject(
      new TagError(
        "bad_names",
        `names must contain exactly 4 entries (got ${opts.names?.length ?? 0})`,
      ),
    );
  }
  if (tagsInFlight.has(opts.vid)) {
    return Promise.reject(
      new TagError("already_running", `Tagging already in progress for vid ${opts.vid}.`),
    );
  }
  // Hard-cap concurrency across vids too: only one tag run at a time across
  // the whole process, since they all share the .pbvision-profile/ Chromium.
  if (tagsInFlight.size > 0) {
    return Promise.reject(
      new TagError(
        "another_running",
        "Another pb.vision tag run is in progress. Try again once it finishes.",
      ),
    );
  }
  tagsInFlight.add(opts.vid);

  const onLog = opts.onLog ?? (() => {});

  return new Promise<TagResult>((resolve, reject) => {
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const args = [TAG_SCRIPT, "--video-id", opts.vid, "--names", opts.names.join(",")];
    if (opts.headed !== false) args.push("--headed");

    const proc = spawn(python, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
      text.split(/\r?\n/).forEach((line: string) => {
        if (line.trim()) onLog(line);
      });
    });
    proc.on("error", (err) => {
      tagsInFlight.delete(opts.vid);
      reject(new TagError("spawn_failed", err.message));
    });
    proc.on("close", (code) => {
      tagsInFlight.delete(opts.vid);
      // Exit code 3 → script prints "Not authenticated" to stderr; map to
      // the same code the lister/login flow uses so the UI can handle it
      // uniformly.
      if (code === 3) {
        return reject(
          new TagError(
            "not_authenticated",
            "pb.vision Playwright profile is logged out. Click Re-authenticate pb.vision and try again.",
          ),
        );
      }
      // Exit code 1 = some slots were skipped but others tagged — still
      // returns a JSON result. Exit 2 = bad args. Exit 0 = full success.
      if (code !== 0 && code !== 1) {
        return reject(new TagError("tag_failed", `pbvision-tag.py exited with code ${code}\n${stderrTail}`));
      }
      try {
        const result = JSON.parse(stdout.trim()) as TagResult;
        resolve(result);
      } catch (e) {
        reject(
          new TagError(
            "parse_failed",
            `Failed to parse tagger output: ${(e as Error).message}\nstdout was: ${stdout.slice(0, 400)}`,
          ),
        );
      }
    });
  });
}

export function isTagInFlight(vid?: string): boolean {
  if (vid) return tagsInFlight.has(vid);
  return tagsInFlight.size > 0;
}
