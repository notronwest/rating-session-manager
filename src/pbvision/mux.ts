// Wrapper around scripts/pbvision-mux.py — scrapes the Mux playback ID
// for one or more pb.vision videos using the persistent Playwright
// profile. Used to replace the rating-hub "📌 PBV Grab" bookmarklet.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "pbvision-mux.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export type MuxFetchResult = {
  vid: string;
  muxPlaybackId: string | null;
  /** "mux-player" | "video.src" | "source.src" | "html-scan" | "network"
   *  when found, omitted when not. Lets the caller log how we got the
   *  ID for debugging unreliable pages. */
  source?: string;
  error?: string;
};

export class MuxFetchError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function fetchMuxPlaybackIds(
  vids: string[],
  opts: { headed?: boolean; onLog?: (line: string) => void } = {},
): Promise<MuxFetchResult[]> {
  return new Promise((resolve, reject) => {
    if (vids.length === 0) return resolve([]);

    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const args: string[] = [SCRIPT];
    if (opts.headed) args.push("--headed");
    args.push(...vids);

    const onLog = opts.onLog ?? (() => {});
    const proc = spawn(python, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

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
    proc.on("error", (err) => reject(new MuxFetchError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(new MuxFetchError(
          "scrape_failed",
          `pbvision-mux.py exited with code ${code}\n${stderrTail}`,
        ));
      }
      try {
        resolve(JSON.parse(stdout.trim()) as MuxFetchResult[]);
      } catch (e) {
        reject(new MuxFetchError("parse_failed", `Failed to parse mux fetcher output: ${(e as Error).message}`));
      }
    });
  });
}
