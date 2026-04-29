// Wrapper around scripts/pbvision-list.py — scrapes the pb.vision library
// for the current user's videos. Requires an authenticated persistent
// profile (seeded by a prior run of scripts/pbvision-upload.py).

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const LISTER = path.join(ROOT, "scripts", "pbvision-list.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export type PbvisionVideo = { vid: string; title: string };

export class ListError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function listPbVisionVideos(
  opts: { headed?: boolean; onLog?: (line: string) => void } = {},
): Promise<PbvisionVideo[]> {
  return new Promise((resolve, reject) => {
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const args = [LISTER];
    if (opts.headed) args.push("--headed");

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
    proc.on("error", (err) => reject(new ListError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code === 3) {
        return reject(new ListError(
          "not_authenticated",
          "pb.vision Playwright profile is logged out. Run `npm run pbvision:login` to re-authenticate, then click Fetch IDs again.",
        ));
      }
      if (code !== 0) {
        return reject(new ListError("list_failed", `pbvision-list.py exited with code ${code}\n${stderrTail}`));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new ListError("parse_failed", `Failed to parse lister output: ${(e as Error).message}`));
      }
    });
  });
}
