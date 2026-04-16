import express from "express";
import cors from "cors";
import sessionsRouter from "./routes/sessions.js";
import videosRouter from "./routes/videos.js";
import membersRouter from "./routes/members.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors());
app.use(express.json());

app.use("/api/sessions", sessionsRouter);
app.use("/api/videos", videosRouter);
app.use("/api/members", membersRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, videoDir: process.env.VIDEO_DIR || null });
});

app.listen(PORT, () => {
  console.log(`Session Manager API running on http://localhost:${PORT}`);
});
