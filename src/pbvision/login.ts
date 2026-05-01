// Wraps scripts/pbvision-login.py — pops a Chromium window with the
// persistent pb.vision profile so the user can complete the magic-link
// flow. The script auto-detects when /library becomes accessible (i.e.
// auth succeeded) and exits, so callers don't have to micromanage the
// window from the API side.
//
// Concurrency: only one login is allowed in flight at a time. A second
// concurrent invocation raises LoginError("already_running").

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const LOGIN_SCRIPT = path.join(ROOT, "scripts", "pbvision-login.py");
const VENV_PYTHON = path.join(ROOT, "venv", "bin", "python");

export class LoginError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

let inFlight: Promise<void> | null = null;
let inFlightProc: ChildProcess | null = null;

export function isLoginInFlight(): boolean {
  return inFlight !== null;
}

/**
 * Spawn pbvision-login.py and resolve when it exits cleanly. Forwards
 * each stdout/stderr line to the optional onLog callback so callers can
 * stream progress back to the UI.
 */
export function runPbVisionLogin(opts: { onLog?: (line: string) => void } = {}): Promise<void> {
  if (inFlight) {
    return Promise.reject(
      new LoginError("already_running", "A pb.vision login is already in progress."),
    );
  }
  const onLog = opts.onLog ?? (() => {});

  const promise = new Promise<void>((resolve, reject) => {
    const python = fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
    const proc = spawn(python, [LOGIN_SCRIPT], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    inFlightProc = proc;

    const forward = (chunk: Buffer) => {
      chunk.toString().split(/\r?\n/).forEach((line: string) => {
        if (line.trim()) onLog(line);
      });
    };
    proc.stdout.on("data", forward);
    proc.stderr.on("data", forward);
    proc.on("error", (err) => reject(new LoginError("spawn_failed", err.message)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new LoginError("login_failed", `pbvision-login.py exited with code ${code}`));
    });
  });

  inFlight = promise.finally(() => {
    inFlight = null;
    inFlightProc = null;
  });
  return inFlight;
}

/**
 * Best-effort: cancel an in-flight login. Sends SIGTERM. Returns true
 * if a process was running, false otherwise.
 */
export function cancelPbVisionLogin(): boolean {
  if (inFlightProc) {
    try {
      inFlightProc.kill("SIGTERM");
    } catch {
      /* ignored — best effort */
    }
    return true;
  }
  return false;
}
