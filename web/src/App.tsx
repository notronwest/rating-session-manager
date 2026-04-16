import { Routes, Route, Link } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import SessionDetail from "./pages/SessionDetail";
import RoiConfigurator from "./pages/RoiConfigurator";

export default function App() {
  return (
    <div>
      <header
        style={{
          background: "#1a73e8",
          color: "#fff",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <Link to="/" style={{ color: "#fff", textDecoration: "none", fontSize: 18, fontWeight: 700 }}>
          WMPC Session Manager
        </Link>
        <div style={{ flex: 1 }} />
        <Link to="/roi" style={{ color: "#fff", textDecoration: "none", fontSize: 13, opacity: 0.9 }}>
          Court ROI
        </Link>
      </header>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24 }}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/roi" element={<RoiConfigurator />} />
        </Routes>
      </main>
    </div>
  );
}
