// Wrapper around scripts/pbvision-upload.py — drives pb.vision's web UI
// with Playwright, returning the captured video ID.
//
// This is the Path B (browser automation) stopgap. Swap for the official
// @pbvision/partner-sdk once an API key is available.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const UPLOADER = path.join(ROOT, "scripts", "pbvision-upload.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export type UploadOptions = {
  videoPath: string;
  headed?: boolean;
  onLog?: (line: string) => void;
};

export class UploadError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function uploadClipToPbVision(opts: UploadOptions): Promise<{ vid: string }> {
  return new Promise((resolve, reject) => {
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const args = [UPLOADER, opts.videoPath];
    if (opts.headed) args.push("--headed");

    const onLog = opts.onLog ?? (() => {});
    const proc = spawn(python, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderrTail = "";
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrTail += text;
      if (stderrTail.length > 8192) stderrTail = stderrTail.slice(-8192);
      text.split(/\r?\n/).forEach((line: string) => {
        if (line.trim()) onLog(line);
      });
    });
    proc.on("error", (err) => reject(new UploadError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code !== 0) {
        return reject(
          new UploadError("upload_failed", `pbvision-upload.py exited with code ${code}\n${stderrTail}`),
        );
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.vid) throw new Error("no vid in response");
        resolve({ vid: parsed.vid });
      } catch (e) {
        reject(
          new UploadError(
            "parse_failed",
            `Failed to parse uploader output: ${(e as Error).message}\nstdout: ${stdout.slice(0, 500)}`,
          ),
        );
      }
    });
  });
}
