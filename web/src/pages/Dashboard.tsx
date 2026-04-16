import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StatusBadge from "../components/StatusBadge";

interface Session {
  id: string;
  status: string;
  label: string | null;
  booking_time: string | null;
  player_names: string[] | null;
  video_path: string | null;
  segments: { index: number; start: string; end: string; duration_sec: number }[] | null;
  created_at: string;
}

export default function Dashboard() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newPlayers, setNewPlayers] = useState("");
  const [newVideoPath, setNewVideoPath] = useState("");

  const fetchSessions = async () => {
    const res = await fetch("/api/sessions");
    const data = await res.json();
    setSessions(data);
    setLoading(false);
  };

  useEffect(() => { fetchSessions(); }, []);

  const createSession = async () => {
    const playerNames = newPlayers
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: newLabel || null,
        player_names: playerNames.length > 0 ? playerNames : null,
        video_path: newVideoPath || null,
      }),
    });

    setNewLabel("");
    setNewPlayers("");
    setNewVideoPath("");
    setShowNew(false);
    fetchSessions();
  };

  if (loading) return <div style={{ padding: 24, color: "#999" }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Rating Sessions</h1>
        <button
          onClick={() => setShowNew(!showNew)}
          style={{
            padding: "8px 16px",
            background: "#1a73e8",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          + New Session
        </button>
      </div>

      {showNew && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 20,
            marginBottom: 20,
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
                Label
              </label>
              <input
                type="text"
                placeholder="e.g. Tuesday Evening Session"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={{ width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd" }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
                Players (comma separated)
              </label>
              <input
                type="text"
                placeholder="e.g. Alice, Bob, Carol, Dave"
                value={newPlayers}
                onChange={(e) => setNewPlayers(e.target.value)}
                style={{ width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd" }}
              />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
              Video File Path
            </label>
            <input
              type="text"
              placeholder="/path/to/session-recording.mp4"
              value={newVideoPath}
              onChange={(e) => setNewVideoPath(e.target.value)}
              style={{ width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd" }}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={createSession}
              style={{
                padding: "8px 16px",
                background: "#1a73e8",
                color: "#fff",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Create
            </button>
            <button
              onClick={() => setShowNew(false)}
              style={{
                padding: "8px 16px",
                background: "#eee",
                color: "#333",
                border: "none",
                borderRadius: 6,
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {sessions.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#999" }}>
          No sessions yet. Create one to get started.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #eee" }}>
              {["Label", "Status", "Players", "Games", "Created"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "#666",
                    textTransform: "uppercase",
                    textAlign: "left",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr
                key={s.id}
                style={{ borderBottom: "1px solid #f0f0f0", cursor: "pointer" }}
                onClick={() => {}}
              >
                <td style={{ padding: "10px 12px", fontSize: 14 }}>
                  <Link to={`/sessions/${s.id}`} style={{ color: "#1a73e8", textDecoration: "none", fontWeight: 500 }}>
                    {s.label || s.id.slice(0, 8)}
                  </Link>
                </td>
                <td style={{ padding: "10px 12px" }}>
                  <StatusBadge status={s.status} />
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13, color: "#666" }}>
                  {s.player_names ? s.player_names.join(", ") : "—"}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13, color: "#666" }}>
                  {s.segments ? s.segments.length : "—"}
                </td>
                <td style={{ padding: "10px 12px", fontSize: 13, color: "#999" }}>
                  {new Date(s.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
