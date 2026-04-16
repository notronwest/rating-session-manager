import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import StatusBadge from "../components/StatusBadge";

interface GameSegment {
  index: number;
  start: string;
  end: string;
  duration_sec: number;
}

interface Session {
  id: string;
  status: string;
  label: string | null;
  booking_time: string | null;
  player_names: string[] | null;
  video_path: string | null;
  roi_path: string | null;
  segments: GameSegment[] | null;
  clip_paths: string[] | null;
  pbvision_video_ids: string[] | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface LogEntry {
  id: number;
  timestamp: string;
  level: string;
  message: string;
}

const inputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 13,
  borderRadius: 4,
  border: "1px solid #ddd",
  fontFamily: "monospace",
  width: 130,
};

const btnStyle: React.CSSProperties = {
  padding: "8px 16px",
  background: "#1a73e8",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

const btnDisabledStyle: React.CSSProperties = { ...btnStyle, opacity: 0.5, cursor: "not-allowed" };

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: 20,
  marginBottom: 16,
};

interface VideoFile {
  name: string;
  path: string;
  size_bytes: number;
  modified: string;
}

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<Session | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [editSegments, setEditSegments] = useState<GameSegment[] | null>(null);
  const [videoPath, setVideoPath] = useState("");
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);

  // Detection parameters
  const [warmup, setWarmup] = useState("0");
  const [minGap, setMinGap] = useState("8");
  const [longBreak, setLongBreak] = useState("22");
  const [restartLookahead, setRestartLookahead] = useState("18");
  const [minGame, setMinGame] = useState("300");

  const fetchSession = useCallback(async () => {
    const [sRes, lRes, vRes] = await Promise.all([
      fetch(`/api/sessions/${id}`),
      fetch(`/api/sessions/${id}/logs`),
      fetch("/api/videos"),
    ]);
    const sData = await sRes.json();
    const lData = await lRes.json();
    const vData = await vRes.json();
    setSession(sData);
    setLogs(lData);
    setVideoFiles(vData.videos || []);
    if (sData.video_path && !videoPath) setVideoPath(sData.video_path);
    if (sData.segments && !editSegments) setEditSegments(sData.segments);
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  // Poll logs while a job is running
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/sessions/${id}/logs`);
      const data = await res.json();
      setLogs(data);
    }, 1500);
    return () => clearInterval(interval);
  }, [running, id]);

  const updateVideoPath = async () => {
    await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_path: videoPath }),
    });
    fetchSession();
  };

  const runDetection = async () => {
    setRunning(true);
    try {
      const res = await fetch(`/api/sessions/${id}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warmup: parseFloat(warmup),
          min_gap: parseFloat(minGap),
          long_break: parseFloat(longBreak),
          restart_lookahead: parseFloat(restartLookahead),
          min_game: parseFloat(minGame),
        }),
      });
      const data = await res.json();
      if (data.segments) setEditSegments(data.segments);
    } finally {
      setRunning(false);
      fetchSession();
    }
  };

  const runExport = async () => {
    if (!editSegments || editSegments.length === 0) return;
    setRunning(true);
    try {
      await fetch(`/api/sessions/${id}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: editSegments }),
      });
    } finally {
      setRunning(false);
      fetchSession();
    }
  };

  const startOver = async () => {
    if (!confirm("Start over? This will delete clips and segments so you can re-detect games.")) return;
    await fetch(`/api/sessions/${id}/start-over`, { method: "POST" });
    setEditSegments(null);
    fetchSession();
  };

  const cancelSession = async () => {
    if (!confirm("Cancel this session build? This will delete clips, segments, and all logs.")) return;
    await fetch(`/api/sessions/${id}/cancel`, { method: "POST" });
    setEditSegments(null);
    setLogs([]);
    fetchSession();
  };

  const updateSegment = (index: number, field: "start" | "end", value: string) => {
    if (!editSegments) return;
    setEditSegments(
      editSegments.map((seg) =>
        seg.index === index ? { ...seg, [field]: value } : seg
      )
    );
  };

  const removeSegment = (index: number) => {
    if (!editSegments) return;
    setEditSegments(editSegments.filter((seg) => seg.index !== index));
  };

  const formatTime = (t: string) => {
    // HH:MM:SS.mmm → M:SS
    const parts = t.split(":");
    if (parts.length === 3) {
      const h = parseInt(parts[0]);
      const m = parseInt(parts[1]);
      const s = parts[2];
      const totalMin = h * 60 + m;
      return `${totalMin}:${s.split(".")[0].padStart(2, "0")}`;
    }
    return t;
  };

  if (loading) return <div style={{ padding: 24, color: "#999" }}>Loading...</div>;
  if (!session) return <div style={{ padding: 24, color: "#d93025" }}>Session not found</div>;

  return (
    <div>
      <Link to="/" style={{ fontSize: 13, color: "#1a73e8", textDecoration: "none", marginBottom: 12, display: "inline-block" }}>
        &larr; All Sessions
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>{session.label || `Session ${session.id.slice(0, 8)}`}</h1>
        <StatusBadge status={session.status} />
        <div style={{ flex: 1 }} />
        {(session.segments || session.clip_paths || session.error || logs.length > 0) && (
          <button
            onClick={cancelSession}
            disabled={running}
            style={{
              padding: "6px 14px", background: "#fff", color: "#d93025",
              border: "1px solid #d93025", borderRadius: 6, fontSize: 13,
              fontWeight: 500, cursor: running ? "not-allowed" : "pointer",
              opacity: running ? 0.5 : 1,
            }}
          >
            Cancel Build
          </button>
        )}
      </div>

      {session.error && (
        <div style={{ background: "#fce8e6", border: "1px solid #f5c6cb", borderRadius: 8, padding: 12, marginBottom: 16, color: "#d93025", fontSize: 13 }}>
          {session.error}
        </div>
      )}

      {/* Pipeline Steps */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Pipeline</h2>
        <PipelineSteps status={session.status} />
      </div>

      {/* Players */}
      {session.player_names && session.player_names.length > 0 && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Players</h2>
          <div style={{ display: "flex", gap: 8 }}>
            {session.player_names.map((name, i) => (
              <span
                key={i}
                style={{
                  padding: "4px 12px",
                  background: "#e8f0fe",
                  borderRadius: 16,
                  fontSize: 13,
                  fontWeight: 500,
                  color: "#1a73e8",
                }}
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Video */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Video File</h2>
        {videoFiles.length > 0 ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              style={{
                flex: 1, padding: "7px 12px", fontSize: 14, borderRadius: 6,
                border: "1px solid #ddd", background: "#fff",
              }}
            >
              <option value="">Select a video file...</option>
              {videoFiles.map((vf) => {
                const sizeMB = (vf.size_bytes / (1024 * 1024)).toFixed(0);
                const date = new Date(vf.modified).toLocaleDateString([], {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                });
                return (
                  <option key={vf.path} value={vf.path}>
                    {vf.name} ({sizeMB} MB — {date})
                  </option>
                );
              })}
            </select>
            <button
              onClick={updateVideoPath}
              disabled={!videoPath}
              style={!videoPath ? btnDisabledStyle : { ...btnStyle, fontSize: 13, padding: "7px 14px" }}
            >
              {session.video_path === videoPath ? "Saved" : "Save"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              placeholder="/path/to/session-recording.mp4"
              style={{ flex: 1, padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd" }}
            />
            <button
              onClick={updateVideoPath}
              style={{ ...btnStyle, background: "#5f6368", fontSize: 13, padding: "7px 14px" }}
            >
              Save
            </button>
          </div>
        )}
        {session.video_path && (
          <div style={{ marginTop: 6, fontSize: 12, color: "#999", fontFamily: "monospace" }}>
            {session.video_path}
          </div>
        )}
      </div>

      {/* Detection */}
      <div style={cardStyle}>
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Game Detection</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
          {[
            { label: "Warmup (sec)", value: warmup, set: setWarmup },
            { label: "Min Gap (sec)", value: minGap, set: setMinGap },
            { label: "Long Break (sec)", value: longBreak, set: setLongBreak },
            { label: "Restart Look (sec)", value: restartLookahead, set: setRestartLookahead },
            { label: "Min Game (sec)", value: minGame, set: setMinGame },
          ].map((p) => (
            <div key={p.label}>
              <label style={{ fontSize: 11, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
                {p.label}
              </label>
              <input
                type="number"
                value={p.value}
                onChange={(e) => p.set(e.target.value)}
                style={inputStyle}
              />
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {session.segments ? (
            <button
              onClick={startOver}
              disabled={running}
              style={running ? btnDisabledStyle : { ...btnStyle, background: "#e37400" }}
            >
              Re-detect Games
            </button>
          ) : (
            <button
              onClick={runDetection}
              disabled={running || !session.video_path}
              style={running || !session.video_path ? btnDisabledStyle : btnStyle}
            >
              {running ? "Detecting..." : "Detect Games"}
            </button>
          )}
          {session.segments && (
            <span style={{ fontSize: 12, color: "#999" }}>
              Clears current segments{session.clip_paths ? " and exported clips" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Segments */}
      {editSegments && editSegments.length > 0 && (
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>
              Detected Segments ({editSegments.length} games)
            </h2>
            <button
              onClick={runExport}
              disabled={running}
              style={running ? btnDisabledStyle : { ...btnStyle, background: "#137333" }}
            >
              {running ? "Exporting..." : "Export Clips"}
            </button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #eee" }}>
                {["Game", "Start", "End", "Duration", ""].map((h) => (
                  <th key={h} style={{ padding: "8px 10px", fontSize: 12, fontWeight: 600, color: "#666", textTransform: "uppercase", textAlign: "left" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {editSegments.map((seg) => (
                <tr key={seg.index} style={{ borderBottom: "1px solid #f0f0f0" }}>
                  <td style={{ padding: "8px 10px", fontSize: 14, fontWeight: 600 }}>
                    Game {seg.index}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <input
                      type="text"
                      value={seg.start}
                      onChange={(e) => updateSegment(seg.index, "start", e.target.value)}
                      style={inputStyle}
                    />
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <input
                      type="text"
                      value={seg.end}
                      onChange={(e) => updateSegment(seg.index, "end", e.target.value)}
                      style={inputStyle}
                    />
                  </td>
                  <td style={{ padding: "8px 10px", fontSize: 13, color: "#666" }}>
                    {formatTime(seg.start)} — {formatTime(seg.end)} ({Math.round(seg.duration_sec / 60)}m)
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    <button
                      onClick={() => removeSegment(seg.index)}
                      style={{ background: "none", border: "none", color: "#d93025", cursor: "pointer", fontSize: 13 }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Clip Paths */}
      {session.clip_paths && session.clip_paths.length > 0 && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Exported Clips</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {session.clip_paths.map((cp, i) => (
              <li key={i} style={{ padding: "4px 0", fontSize: 13, color: "#666", fontFamily: "monospace" }}>
                {cp}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Logs */}
      {(logs.length > 0 || running) && (
        <div style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>Logs</h2>
            {running && <ProcessingSpinner />}
          </div>
          <div
            ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}
            style={{
              background: "#1e1e1e",
              color: "#d4d4d4",
              borderRadius: 6,
              padding: 12,
              fontSize: 12,
              fontFamily: "monospace",
              maxHeight: 300,
              overflowY: "auto",
              lineHeight: 1.6,
            }}
          >
            {logs.length === 0 && running && (
              <div style={{ color: "#888" }}>Starting...</div>
            )}
            {logs.map((log) => (
              <div key={log.id}>
                <span style={{ color: "#666" }}>
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>{" "}
                <span style={{ color: log.message.includes("failed") || log.message.includes("error") ? "#f28b82" : "#d4d4d4" }}>
                  {log.message}
                </span>
              </div>
            ))}
            {running && (
              <div style={{ color: "#888", marginTop: 4 }}>
                <span style={{ animation: "none" }}>...</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProcessingSpinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid #ddd",
        borderTopColor: "#1a73e8",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }}
    >
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </span>
  );
}

const PIPELINE_STEPS = [
  "scheduled",
  "recording",
  "recorded",
  "splitting",
  "split",
  "uploading",
  "processing",
  "tagging",
  "importing",
  "complete",
];

function PipelineSteps({ status }: { status: string }) {
  const currentIdx = PIPELINE_STEPS.indexOf(status);

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      {PIPELINE_STEPS.map((step, i) => {
        const isActive = step === status;
        const isDone = i < currentIdx && status !== "failed";
        const isFailed = status === "failed" && i === currentIdx;

        let bg = "#eee";
        let color = "#999";
        if (isDone) { bg = "#e6f4ea"; color = "#137333"; }
        if (isActive) { bg = "#e8f0fe"; color = "#1a73e8"; }
        if (isFailed) { bg = "#fce8e6"; color = "#d93025"; }

        return (
          <div key={step} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span
              style={{
                padding: "3px 8px",
                borderRadius: 4,
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                background: bg,
                color,
                textTransform: "uppercase",
                letterSpacing: 0.3,
              }}
            >
              {step}
            </span>
            {i < PIPELINE_STEPS.length - 1 && (
              <span style={{ color: "#ccc", fontSize: 10 }}>→</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
