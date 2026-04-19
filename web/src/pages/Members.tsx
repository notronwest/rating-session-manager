import { useEffect, useState } from "react";

type Inserted = { display_name: string; cr_member_id: string; slug: string };

type SyncResult = {
  scraped: number;
  existing: number;
  skipped: number;
  inserted: Inserted[];
  dryRun: boolean;
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

export default function Members() {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [count, setCount] = useState<number | null>(null);

  const fetchCount = async () => {
    const res = await fetch("/api/members");
    const data = await res.json();
    setCount(data.members?.length ?? 0);
  };

  useEffect(() => { fetchCount(); }, []);

  const runSync = async (dryRun: boolean) => {
    setSyncing(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/members/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Sync failed");
      } else {
        setResult(data);
        if (!dryRun) fetchCount();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>Members</h1>

      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>CourtReserve → Supabase sync</div>
            <div style={{ fontSize: 13, color: "#666" }}>
              {count === null ? "Loading current player count…" : `${count} active players in Supabase`}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => runSync(true)}
              disabled={syncing}
              style={{ ...btnSecondary, opacity: syncing ? 0.6 : 1, cursor: syncing ? "wait" : "pointer" }}
            >
              {syncing ? "Running…" : "Dry run"}
            </button>
            <button
              onClick={() => runSync(false)}
              disabled={syncing}
              style={{ ...btnPrimary, opacity: syncing ? 0.6 : 1, cursor: syncing ? "wait" : "pointer" }}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#999" }}>
          Runs the CourtReserve Members Report (up to ~2 minutes) and inserts any new players into Supabase. Existing players are never modified.
        </div>
      </div>

      {syncing && (
        <div style={{ ...cardStyle, background: "#fff8e1", border: "1px solid #ffe082", color: "#6b5200" }}>
          Scraping CourtReserve and syncing to Supabase. This can take up to ~2 minutes.
        </div>
      )}

      {error && (
        <div style={{ ...cardStyle, background: "#fde7e7", border: "1px solid #f5c6c6", color: "#b00020" }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Sync failed</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, margin: 0 }}>{error}</pre>
        </div>
      )}

      {result && (
        <div style={cardStyle}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>
            {result.dryRun ? "Dry run complete" : "Sync complete"}
          </div>
          <div style={{ display: "flex", gap: 24, fontSize: 14, marginBottom: 12 }}>
            <div>Scraped: <strong>{result.scraped}</strong></div>
            <div>Existing in Supabase: <strong>{result.existing}</strong></div>
            <div>Skipped (already present): <strong>{result.skipped}</strong></div>
            <div style={{ color: "#137333" }}>
              {result.dryRun ? "Would insert" : "Inserted"}: <strong>{result.inserted.length}</strong>
            </div>
          </div>

          {result.inserted.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#1a73e8" }}>
                {result.dryRun ? "Preview of players that would be inserted" : "Players inserted"} ({result.inserted.length})
              </summary>
              <ul style={{ marginTop: 8, fontSize: 13, maxHeight: 300, overflowY: "auto" }}>
                {result.inserted.map((p) => (
                  <li key={p.cr_member_id}>
                    {p.display_name} <span style={{ color: "#999" }}>#{p.cr_member_id} → {p.slug}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
