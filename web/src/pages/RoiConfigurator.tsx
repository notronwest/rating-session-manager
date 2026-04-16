import React, { useEffect, useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";

interface VideoFile {
  name: string;
  path: string;
}

interface VideoDims {
  width: number;
  height: number;
  duration: number;
}

const btnStyle: React.CSSProperties = {
  padding: "8px 16px", background: "#1a73e8", color: "#fff", border: "none",
  borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer",
};

const btnSecondaryStyle: React.CSSProperties = {
  ...btnStyle, background: "#eee", color: "#333", fontWeight: 400,
};

const btnDisabledStyle: React.CSSProperties = { ...btnStyle, opacity: 0.5, cursor: "not-allowed" };

export default function RoiConfigurator() {
  const [params, setParams] = useSearchParams();
  const [videos, setVideos] = useState<VideoFile[]>([]);
  const [videoPath, setVideoPath] = useState(params.get("path") || "");
  const [frameTime, setFrameTime] = useState(parseFloat(params.get("t") || "60"));
  const [dims, setDims] = useState<VideoDims | null>(null);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgDisplayDims, setImgDisplayDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Load video list
  useEffect(() => {
    fetch("/api/videos").then((r) => r.json()).then((d) => setVideos(d.videos || []));
  }, []);

  // Load current ROI on mount
  useEffect(() => {
    fetch("/api/videos/roi").then((r) => r.json()).then((d) => {
      if (d.points && d.points.length > 0) setPoints(d.points);
    });
  }, []);

  // Load video dimensions when path changes
  useEffect(() => {
    if (!videoPath) { setDims(null); return; }
    fetch(`/api/videos/dimensions?path=${encodeURIComponent(videoPath)}`)
      .then((r) => r.json()).then(setDims);
  }, [videoPath]);

  const frameUrl = videoPath
    ? `/api/videos/frame?path=${encodeURIComponent(videoPath)}&t=${frameTime}`
    : "";

  const handleImageLoad = () => {
    if (imgRef.current) {
      setImgDisplayDims({
        w: imgRef.current.clientWidth,
        h: imgRef.current.clientHeight,
      });
    }
  };

  // Click to add a point (converts display coords to video coords)
  const handleImageClick = (e: React.MouseEvent) => {
    if (!dims || !imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const displayX = e.clientX - rect.left;
    const displayY = e.clientY - rect.top;
    // Convert to video pixel coordinates
    const videoX = Math.round((displayX / rect.width) * dims.width);
    const videoY = Math.round((displayY / rect.height) * dims.height);
    setPoints([...points, [videoX, videoY]]);
    setSaved(false);
  };

  const removePoint = (idx: number) => {
    setPoints(points.filter((_, i) => i !== idx));
    setSaved(false);
  };

  const clearAll = () => {
    setPoints([]);
    setSaved(false);
  };

  const saveRoi = async () => {
    if (points.length < 3) return;
    setSaving(true);
    await fetch("/api/videos/roi", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points }),
    });
    setSaving(false);
    setSaved(true);
  };

  // Convert video coords to display coords for overlay
  const toDisplay = (pt: [number, number]): [number, number] => {
    if (!dims) return [0, 0];
    return [
      (pt[0] / dims.width) * imgDisplayDims.w,
      (pt[1] / dims.height) * imgDisplayDims.h,
    ];
  };

  const polygonPath = points
    .map((p, i) => {
      const [x, y] = toDisplay(p);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ") + (points.length >= 3 ? " Z" : "");

  return (
    <div>
      <Link to="/" style={{ fontSize: 13, color: "#1a73e8", textDecoration: "none", marginBottom: 12, display: "inline-block" }}>
        ← All Sessions
      </Link>

      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Configure Court ROI</h1>
      <p style={{ fontSize: 14, color: "#666", marginBottom: 20, lineHeight: 1.5 }}>
        Click on the corners of the pickleball court (in order — e.g. clockwise or counterclockwise).
        This polygon tells the game detector where players are on the court, so motion outside it (spectators,
        staff walking by) doesn't confuse it.
      </p>

      {/* Controls */}
      <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 12, alignItems: "end", marginBottom: 8 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
              Video (sample frame for configuring ROI)
            </label>
            <select
              value={videoPath}
              onChange={(e) => { setVideoPath(e.target.value); setParams({ path: e.target.value, t: String(frameTime) }); }}
              style={{ width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd", background: "#fff" }}
            >
              <option value="">Select a video...</option>
              {videos.map((v) => (
                <option key={v.path} value={v.path}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#666", display: "block", marginBottom: 4 }}>
              Time (seconds)
            </label>
            <input
              type="number"
              value={frameTime}
              onChange={(e) => setFrameTime(parseFloat(e.target.value) || 0)}
              onBlur={() => videoPath && setParams({ path: videoPath, t: String(frameTime) })}
              style={{ width: "100%", padding: "7px 12px", fontSize: 14, borderRadius: 6, border: "1px solid #ddd" }}
            />
          </div>
          <button onClick={() => setFrameTime(frameTime + 30)} style={btnSecondaryStyle}>
            +30s
          </button>
        </div>
        {dims && (
          <div style={{ fontSize: 12, color: "#999" }}>
            Video: {dims.width} × {dims.height} px · {Math.floor(dims.duration / 60)}:{String(Math.floor(dims.duration % 60)).padStart(2, "0")}
          </div>
        )}
      </div>

      {/* Frame + overlay */}
      {videoPath && (
        <div style={{ background: "#000", borderRadius: 8, overflow: "hidden", marginBottom: 16, position: "relative" }}>
          <img
            ref={imgRef}
            src={frameUrl}
            onLoad={handleImageLoad}
            onClick={handleImageClick}
            style={{ width: "100%", display: "block", cursor: "crosshair", userSelect: "none" }}
            alt="Video frame"
          />

          {/* Polygon overlay */}
          {points.length > 0 && imgDisplayDims.w > 0 && (
            <svg
              style={{
                position: "absolute", top: 0, left: 0,
                width: imgDisplayDims.w, height: imgDisplayDims.h,
                pointerEvents: "none",
              }}
            >
              {/* Fill polygon */}
              {points.length >= 3 && (
                <path d={polygonPath} fill="rgba(26, 115, 232, 0.25)" stroke="#1a73e8" strokeWidth="2" />
              )}
              {/* Lines between points (for <3 points) */}
              {points.length === 2 && (
                <line
                  x1={toDisplay(points[0])[0]} y1={toDisplay(points[0])[1]}
                  x2={toDisplay(points[1])[0]} y2={toDisplay(points[1])[1]}
                  stroke="#1a73e8" strokeWidth="2"
                />
              )}
              {/* Point markers */}
              {points.map((pt, i) => {
                const [x, y] = toDisplay(pt);
                return (
                  <g key={i}>
                    <circle cx={x} cy={y} r={8} fill="#1a73e8" stroke="#fff" strokeWidth="2" style={{ pointerEvents: "all", cursor: "pointer" }} />
                    <text x={x} y={y + 4} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700" style={{ pointerEvents: "none" }}>
                      {i + 1}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      )}

      {/* Points list */}
      {videoPath && (
        <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600 }}>
              Polygon Points ({points.length})
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              {points.length > 0 && (
                <button onClick={clearAll} style={{ ...btnSecondaryStyle, fontSize: 13, padding: "6px 12px" }}>
                  Clear All
                </button>
              )}
              <button
                onClick={saveRoi}
                disabled={points.length < 3 || saving}
                style={points.length < 3 ? btnDisabledStyle : { ...btnStyle, background: "#137333" }}
              >
                {saving ? "Saving..." : saved ? "Saved ✓" : "Save ROI"}
              </button>
            </div>
          </div>

          {points.length === 0 && (
            <p style={{ fontSize: 13, color: "#999" }}>
              Click on the court corners in the image above to start. You need at least 3 points.
            </p>
          )}

          {points.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {points.map((pt, i) => (
                <span
                  key={i}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "4px 10px", background: "#e8f0fe", borderRadius: 16,
                    fontSize: 13, color: "#1a73e8", fontFamily: "monospace",
                  }}
                >
                  {i + 1}: ({pt[0]}, {pt[1]})
                  <button
                    onClick={() => removePoint(i)}
                    style={{ background: "none", border: "none", color: "#1a73e8", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16, padding: 12, background: "#f8f9fa", borderRadius: 6, fontSize: 12, color: "#666" }}>
            <strong>Tip:</strong> Pick a frame during active play where all 4 players are visible on the court.
            The polygon should outline the entire playable area. A good shape is a trapezoid following the
            perspective of the court lines.
          </div>
        </div>
      )}
    </div>
  );
}
