// Routes for cross-cutting pb.vision actions that aren't tied to a single
// session — currently just the persistent-profile login flow. The fetch /
// upload / confirm endpoints stay on /api/sessions/:id since they operate
// per-session.

import { Router } from "express";
import {
  runPbVisionLogin,
  cancelPbVisionLogin,
  isLoginInFlight,
  LoginError,
} from "../pbvision/login.js";

const router = Router();

// POST /api/pbvision/login — pops a Chromium window on the API host with
// the persistent pb.vision profile. Resolves when the login script exits
// (either auth was detected or the user closed the window). Streams the
// script's stdout/stderr lines into the response as a single text/plain
// body so the UI can show what happened.
router.post("/login", async (_req, res) => {
  if (isLoginInFlight()) {
    return res.status(409).json({
      error: "A pb.vision login is already running. Look for the open Chromium window on the recording machine.",
      code: "already_running",
    });
  }

  // Stream lines back to the UI as they happen. Switch the response into
  // text mode so the client can read progressively.
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.flushHeaders?.();

  const writeLine = (line: string) => {
    try {
      res.write(line + "\n");
    } catch {
      /* client disconnected — ignored */
    }
  };

  try {
    await runPbVisionLogin({ onLog: writeLine });
    writeLine("[done] Login complete.");
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof LoginError ? err.code : "unknown";
    writeLine(`[error] ${code}: ${msg}`);
    res.end();
  }
});

// POST /api/pbvision/login/cancel — kill an in-flight login (e.g. user
// changed their mind). No-op if nothing's running.
router.post("/login/cancel", (_req, res) => {
  const cancelled = cancelPbVisionLogin();
  res.json({ cancelled });
});

// GET /api/pbvision/login/status — quick check; UI can poll while a login
// is in progress to know when to re-enable the Fetch IDs button.
router.get("/login/status", (_req, res) => {
  res.json({ inFlight: isLoginInFlight() });
});

export default router;
