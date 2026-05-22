// Thin wrapper around scripts/videos/match_avatars.py — sends references
// and candidates via stdin JSON, reads matches back from stdout JSON.
//
// Used by the tagging-suggest endpoint to auto-fill tagging dropdowns
// for Games 2/3 based on a coach's manual tagging of Game 1.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "videos", "match_avatars.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export interface MatchReference {
  player_id: string;
  name: string;
  url: string;
}

export interface MatchCandidate {
  slot: number;
  url: string;
}

export interface MatchResult {
  slot: number;
  player_id: string;
  player_name: string | null;
  /** Cosine similarity, [0, 1]. */
  confidence: number;
  /** best minus second-best. Small margin = unsure, surface as a low-
   *  confidence suggestion in the UI. */
  margin: number;
}

export class AvatarMatchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function matchAvatars(
  references: MatchReference[],
  candidates: MatchCandidate[],
  opts: { onLog?: (line: string) => void } = {},
): Promise<MatchResult[]> {
  return new Promise((resolve, reject) => {
    if (references.length === 0 || candidates.length === 0) return resolve([]);

    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const onLog = opts.onLog ?? (() => {});
    const proc = spawn(python, [SCRIPT], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096);
      text.split(/\r?\n/).forEach((line: string) => {
        if (line.trim()) onLog(line);
      });
    });
    proc.on("error", (err) => reject(new AvatarMatchError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new AvatarMatchError(
          "match_failed",
          `match_avatars.py exited with code ${code}\n${stderrTail}`,
        ));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.error) {
          return reject(new AvatarMatchError("match_error", parsed.error));
        }
        resolve((parsed.matches || []) as MatchResult[]);
      } catch (e) {
        reject(new AvatarMatchError("parse_failed", `${(e as Error).message}\nstdout was:\n${stdout.slice(0, 500)}`));
      }
    });

    proc.stdin.write(JSON.stringify({ references, candidates }));
    proc.stdin.end();
  });
}
