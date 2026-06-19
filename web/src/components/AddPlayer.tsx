import { useEffect, useRef, useState } from "react";

interface Match {
  id: string;
  display_name: string;
  slug?: string;
}

interface Props {
  /** Called with an existing player's id, or just a name to create a new one. */
  onSubmit: (sel: { playerId?: string; displayName: string }) => void | Promise<void>;
  busy?: boolean;
  placeholder?: string;
  /** Compact single-line layout for embedding in a card header. */
  compact?: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Search-or-create player picker. Type a name → debounced search of existing
 * rating-hub players (via /api/members/search). Pick a match to reuse it, or
 * choose "Create" to mint a new profile. Reused by the session tagging panel
 * and the Members page so both stay consistent and avoid duplicate profiles.
 */
export default function AddPlayer({ onSubmit, busy, placeholder, compact }: Props) {
  const [name, setName] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced search as the coach types.
  useEffect(() => {
    const q = name.trim();
    if (!q) {
      setMatches([]);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/members/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        setMatches((data.members || []) as Match[]);
        setOpen(true);
      } catch {
        setMatches([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [name]);

  // Close the dropdown on outside click.
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const exactMatch = matches.find((m) => norm(m.display_name) === norm(name));

  const submitExisting = async (m: Match) => {
    await onSubmit({ playerId: m.id, displayName: m.display_name });
    reset();
  };
  const submitNew = async () => {
    const q = name.trim();
    if (!q) return;
    await onSubmit({ displayName: q });
    reset();
  };
  const reset = () => {
    setName("");
    setMatches([]);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (exactMatch) void submitExisting(exactMatch);
    else void submitNew();
  };

  return (
    <div ref={boxRef} style={{ position: "relative", maxWidth: compact ? 360 : "100%" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => name.trim() && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder || "Add a player by name…"}
          disabled={busy}
          style={{
            flex: 1, padding: "7px 10px", fontSize: 13, borderRadius: 6,
            border: "1px solid #ddd", background: busy ? "#f5f5f5" : "#fff",
          }}
        />
        <button
          onClick={() => (exactMatch ? submitExisting(exactMatch) : submitNew())}
          disabled={busy || !name.trim()}
          style={{
            padding: "7px 14px", fontSize: 13, fontWeight: 600, borderRadius: 6,
            border: "1px solid #137333", background: "#137333", color: "#fff",
            cursor: busy || !name.trim() ? "default" : "pointer",
            opacity: busy || !name.trim() ? 0.6 : 1, whiteSpace: "nowrap",
          }}
        >
          {busy ? "Adding…" : exactMatch ? "Add" : "Create & add"}
        </button>
      </div>

      {open && name.trim() && (
        <div
          style={{
            position: "absolute", top: "100%", left: 0, right: compact ? "auto" : 0,
            width: compact ? 360 : "auto", marginTop: 4, zIndex: 30,
            background: "#fff", border: "1px solid #ddd", borderRadius: 6,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)", maxHeight: 240, overflowY: "auto",
          }}
        >
          {searching && (
            <div style={{ padding: "8px 12px", fontSize: 12, color: "#999" }}>Searching…</div>
          )}
          {!searching && matches.map((m) => (
            <button
              key={m.id}
              onMouseDown={(e) => { e.preventDefault(); void submitExisting(m); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                fontSize: 13, border: "none", borderBottom: "1px solid #f0f0f0",
                background: "#fff", cursor: "pointer",
              }}
            >
              {m.display_name}
              <span style={{ color: "#999", fontSize: 11 }}> · existing</span>
            </button>
          ))}
          {!searching && !exactMatch && (
            <button
              onMouseDown={(e) => { e.preventDefault(); void submitNew(); }}
              style={{
                display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                fontSize: 13, border: "none", background: "#f8fdf9", cursor: "pointer",
                color: "#137333", fontWeight: 600,
              }}
            >
              + Create new player “{name.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}
