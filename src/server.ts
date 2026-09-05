import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import sessionsRouter from "./routes/sessions.js";
import videosRouter from "./routes/videos.js";
import membersRouter from "./routes/members.js";
import scheduleRouter from "./routes/schedule.js";
import pbvisionRouter from "./routes/pbvision.js";
import { cfAccessGate, isViaCloudflare } from "./middleware/cf-access.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Both src/server.ts (tsx) and dist/server.js sit one level below the repo root.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Where `vite build` puts the SPA: ../../www/${APP_NAME} relative to web/ (see
// vite.config.ts) — i.e. a sibling of the repo. Override with WEB_DIST.
const WEB_DIST =
  process.env.WEB_DIST ||
  path.resolve(REPO_ROOT, "..", "www", process.env.APP_NAME || "sessionmanager");

app.use(cors());
app.use(express.json());

// Anything that arrived through the Cloudflare Tunnel must carry a valid
// Cloudflare Access token (fail closed). LAN / localhost traffic is untouched.
// /api/health stays open so the tunnel's smoke test and uptime checks work.
app.use(cfAccessGate({ exempt: ["/api/health"] }));

app.use("/api/sessions", sessionsRouter);
app.use("/api/videos", videosRouter);
app.use("/api/members", membersRouter);
app.use("/api/schedule", scheduleRouter);
app.use("/api/pbvision", pbvisionRouter);

app.get("/api/health", (req, res) => {
  // Don't leak the mini's filesystem layout to the public hostname.
  const local = !isViaCloudflare(req);
  res.json({ ok: true, ...(local ? { videoDir: process.env.VIDEO_DIR || null } : {}) });
});

// Serve the built SPA from this process too, so ONE origin carries both the
// UI and /api — that is what the Cloudflare Tunnel (deploy/cloudflared) points
// at. On the LAN, Caddy keeps file-serving the same directory as before. In
// dev, Vite serves the UI on :3000 and proxies /api here, so the directory
// usually doesn't exist and this block is skipped.
const SPA_INDEX = path.join(WEB_DIST, "index.html");
if (fs.existsSync(SPA_INDEX)) {
  app.use(
    express.static(WEB_DIST, {
      setHeaders(res, filePath) {
        // Vite hashes everything under assets/ → cache forever; index.html must not be cached.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
  // SPA fallback for client-side routes (/sessions/:id, /members, /roi …).
  // Unknown /api/* paths fall through to Express's default 404 instead.
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(SPA_INDEX);
  });
  console.log(`Serving SPA from ${WEB_DIST}`);
} else {
  console.log(`No built SPA at ${WEB_DIST} — API only (run 'npm run build:only' to produce it)`);
}

const server = app.listen(PORT, () => {
  console.log(`Session Manager API running on http://localhost:${PORT}`);
});

// Graceful shutdown so tsx watch can restart cleanly
function shutdown() {
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
