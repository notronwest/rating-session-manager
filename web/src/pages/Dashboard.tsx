import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

interface RatingEvent {
  id: number;
  event_id: number;
  event_name: string;
  start_time: string;
  end_time: string;
  courts: string;
  members_count: number;
  players: { name: string; memberId: string }[];
  organizer: string | null;
}

interface Member {
  id: string;
  slug: string;
  display_name: string;
  cr_member_id: string | null;
}

interface VideoFile {
  name: string;
  path: string;
  size_bytes: number;
  modified: string;
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4,
};
const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd",
};
const btnPrimary: React.CSSProperties = {
  padding: "8px 16px", background: "#1a73e8", color: "#fff", border: "none",
  borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  ...btnPrimary, background: "#eee", color: "#333", fontWeight: 400,
};
const cardStyle: React.CSSProperties = {
  background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: 20, marginBottom: 20,
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ratingEvents, setRatingEvents] = useState<RatingEvent[]>([]);
  const [videoFiles, setVideoFiles] = useState<VideoFile[]>([]);
  const [loading, setLoading] = useState(true);

  // Manual session creation
  const [showNew, setShowNew] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newVideoPath, setNewVideoPath] = useState("");
  const [selectedPlayers, setSelectedPlayers] = useState<{ name: string; memberId: string }[]>([]);
  const [playerSearch, setPlayerSearch] = useState("");
  const [searchResults, setSearchResults] = useState<Member[]>([]);
  const [showResults, setShowResults] = useState(false);

  const fetchData = async () => {
    const [sRes, eRes, vRes] = await Promise.all([
      fetch("/api/sessions"),
      fetch("/api/schedule/rating-events"),
      fetch("/api/videos"),
    ]);
    const sData = await sRes.json();
    const eData = await eRes.json();
    const vData = await vRes.json();
    setSessions(sData);
    setRatingEvents(eData.events || []);
    setVideoFiles(vData.videos || []);
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  // Member search with debounce
  useEffect(() => {
    if (playerSearch.length < 2) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/members/search?q=${encodeURIComponent(playerSearch)}`);
      const data = await res.json();
      setSearchResults(data.members || []);
      setShowResults(true);
    }, 200);
    return () => clearTimeout(timer);
  }, [playerSearch]);

  const addPlayer = (member: Member) => {
    if (!selectedPlayers.some((p) => p.memberId === member.id)) {
      setSelectedPlayers([...selectedPlayers, { name: member.display_name, memberId: member.id }]);
    }
    setPlayerSearch("");
    setShowResults(false);
  };

  const removePlayer = (memberId: string) => {
    setSelectedPlayers(selectedPlayers.filter((p) => p.memberId !== memberId));
  };

  const importRatingEvent = async (event: RatingEvent) => {
    const timeStr = new Date(event.start_time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = new Date(event.start_time).toLocaleDateString();
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: `${event.event_name} — ${dateStr} ${timeStr}`,
        booking_time: event.start_time,
        player_names: event.players.map((p) => p.name),
      }),
    });
    const session = await res.json();
    navigate(`/sessions/${session.id}`);
  };

  const createSession = async () => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: newLabel || null,
        player_names: selectedPlayers.length > 0 ? selectedPlayers.map((p) => p.name) : null,
        video_path: newVideoPath || null,
      }),
    });
    const session = await res.json();
    setNewLabel("");
    setNewVideoPath("");
    setSelectedPlayers([]);
    setShowNew(false);
    navigate(`/sessions/${session.id}`);
  };

  const formatEventTime = (start: string, end: string) => {
    const s = new Date(start);
    const e = new Date(end);
    const date = s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    const st = s.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const et = e.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${date} ${st} – ${et}`;
  };

  if (loading) return <div style={{ padding: 24, color: "#999" }}>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>Rating Sessions</h1>
        <button onClick={() => setShowNew(!showNew)} style={btnPrimary}>
          + New Session
        </button>
      </div>

      {/* Upcoming Rating Events */}
      {ratingEvents.length > 0 && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
            Upcoming Rating Events
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {ratingEvents.map((event) => (
              <div
                key={event.id}
                style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: 12, background: "#f8f9fa", borderRadius: 6, border: "1px solid #eee",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                    {event.event_name}
                  </div>
                  <div style={{ fontSize: 13, color: "#666", marginBottom: 4 }}>
                    {formatEventTime(event.start_time, event.end_time)} — {event.courts}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {event.players.map((p) => (
                      <span
                        key={p.memberId}
                        style={{
                          padding: "2px 8px", background: "#e8f0fe", borderRadius: 12,
                          fontSize: 12, color: "#1a73e8", fontWeight: 500,
                        }}
                      >
                        {p.name}
                      </span>
                    ))}
                    {event.members_count > event.players.length && (
                      <span style={{ fontSize: 12, color: "#999" }}>
                        +{event.members_count - event.players.length} more
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => importRatingEvent(event)}
                  style={{ ...btnPrimary, background: "#137333", fontSize: 13, padding: "6px 14px", whiteSpace: "nowrap" }}
                >
                  Create Session
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Manual Session Creation */}
      {showNew && (
        <div style={cardStyle}>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>New Manual Session</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <div>
              <label style={labelStyle}>Label</label>
              <input
                type="text"
                placeholder="e.g. Tuesday Evening Session"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Video File (optional)</label>
              {videoFiles.length > 0 ? (
                <select
                  value={newVideoPath}
                  onChange={(e) => setNewVideoPath(e.target.value)}
                  style={{ ...inputStyle, background: "#fff" }}
                >
                  <option value="">None — assign later</option>
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
              ) : (
                <input
                  type="text"
                  placeholder="/path/to/session-recording.mp4"
                  value={newVideoPath}
                  onChange={(e) => setNewVideoPath(e.target.value)}
                  style={inputStyle}
                />
              )}
            </div>
          </div>

          {/* Player Search */}
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Players</label>
            {selectedPlayers.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {selectedPlayers.map((p) => (
                  <span
                    key={p.memberId}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 4,
                      padding: "4px 10px", background: "#e8f0fe", borderRadius: 16,
                      fontSize: 13, color: "#1a73e8", fontWeight: 500,
                    }}
                  >
                    {p.name}
                    <button
                      onClick={() => removePlayer(p.memberId)}
                      style={{
                        background: "none", border: "none", color: "#1a73e8",
                        cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1,
                      }}
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ position: "relative" }}>
              <input
                type="text"
                placeholder="Search members by name..."
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                onFocus={() => searchResults.length > 0 && setShowResults(true)}
                onBlur={() => setTimeout(() => setShowResults(false), 200)}
                style={inputStyle}
              />
              {showResults && searchResults.length > 0 && (
                <div
                  style={{
                    position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10,
                    background: "#fff", border: "1px solid #ddd", borderRadius: 6,
                    maxHeight: 200, overflowY: "auto", boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                  }}
                >
                  {searchResults.slice(0, 10).map((m) => {
                    const already = selectedPlayers.some((p) => p.memberId === m.id);
                    return (
                      <div
                        key={m.id}
                        onClick={() => !already && addPlayer(m)}
                        style={{
                          padding: "8px 12px", cursor: already ? "default" : "pointer",
                          borderBottom: "1px solid #f0f0f0", fontSize: 13,
                          background: already ? "#f5f5f5" : "transparent",
                          color: already ? "#999" : "#333",
                        }}
                        onMouseEnter={(e) => { if (!already) e.currentTarget.style.background = "#f8f9fa"; }}
                        onMouseLeave={(e) => { if (!already) e.currentTarget.style.background = "transparent"; }}
                      >
                        <span style={{ fontWeight: 500 }}>{m.display_name}</span>
                        {already && <span style={{ color: "#999", marginLeft: 8 }}>(added)</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={createSession} style={btnPrimary}>Create</button>
            <button onClick={() => { setShowNew(false); setSelectedPlayers([]); }} style={btnSecondary}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sessions Table */}
      {sessions.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: "#999" }}>
          No sessions yet. Import a rating event above or create one manually.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", background: "#fff", borderRadius: 8, overflow: "hidden" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #eee" }}>
              {["Session", "Status", "Players", "Games", "Created"].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: "10px 12px", fontSize: 12, fontWeight: 600,
                    color: "#666", textTransform: "uppercase", textAlign: "left",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: "10px 12px", fontSize: 14 }}>
                  <Link to={`/sessions/${s.id}`} style={{ color: "#1a73e8", textDecoration: "none", fontWeight: 500 }}>
                    {s.label || s.id.slice(0, 8)}
                  </Link>
                  {s.booking_time && (
                    <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>
                      {new Date(s.booking_time).toLocaleString([], {
                        weekday: "short", month: "short", day: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </div>
                  )}
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
