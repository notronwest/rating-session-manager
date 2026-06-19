import React, { useRef, useState, useEffect, useCallback } from "react";

interface GameSegment {
  index: number;
  start: string; // HH:MM:SS.mmm
  end: string;
  duration_sec: number;
}

interface Props {
  videoPath: string;
  segments: GameSegment[];
  onSegmentsChange: (segments: GameSegment[]) => void;
}

const PBV_MAX_SEC = 29 * 60; // 29 minutes

const SEGMENT_COLORS = [
  "#4285f4", "#34a853", "#ea4335", "#fbbc04", "#9c27b0",
  "#00bcd4", "#ff5722", "#607d8b", "#e91e63", "#3f51b5",
];

function toSec(t: string): number {
  const parts = t.split(":");
  if (parts.length !== 3) return 0;
  const [h, m, rest] = parts;
  const [s, ms] = (rest || "0").split(".");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + (ms ? parseInt(ms) / 1000 : 0);
}

function fromSec(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const sec = Math.floor(s);
  const ms = Math.round((s - sec) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function formatDisplay(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function VideoSegmentEditor({ videoPath, segments, onSegmentsChange }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [dragging, setDragging] = useState<{ segIdx: number; edge: "start" | "end" } | null>(null);
  // Horizontal zoom for the timeline. 1 = whole video fits the panel width;
  // higher values widen the inner track and reveal a horizontal scrollbar so
  // a 2+ hour recording's segment edges are grabbable at pixel scale. All
  // segment/playhead positions stay percentage-based against the (now wider)
  // track, and the click/drag math reads getBoundingClientRect() which already
  // accounts for scroll offset — so nothing downstream needs to know the zoom.
  const [zoom, setZoom] = useState(1);
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 32;
  const zoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, z * 2));
  const zoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, z / 2));

  const videoUrl = `/api/videos/stream?path=${encodeURIComponent(videoPath)}`;

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => setDuration(v.duration);
    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, []);

  // Keep the playhead within the visible scroll window as it advances (only
  // matters when zoomed in, where the track is wider than the panel). Nudges
  // scroll when the playhead drifts within 10% of either edge; leaves manual
  // scrolling alone otherwise.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || duration === 0 || zoom <= 1) return;
    const playheadX = (currentTime / duration) * sc.scrollWidth;
    const margin = sc.clientWidth * 0.1;
    if (playheadX < sc.scrollLeft + margin) {
      sc.scrollLeft = Math.max(0, playheadX - margin);
    } else if (playheadX > sc.scrollLeft + sc.clientWidth - margin) {
      sc.scrollLeft = playheadX - sc.clientWidth + margin;
    }
  }, [currentTime, duration, zoom]);

  // On a zoom change, recenter the view on the playhead so zooming in feels
  // like it homes in on where you're working rather than jumping to 0:00.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || duration === 0) return;
    const playheadX = (currentTime / duration) * sc.scrollWidth;
    sc.scrollLeft = Math.max(0, playheadX - sc.clientWidth / 2);
    // currentTime intentionally omitted: recenter only when zoom changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, duration]);

  const seekTo = useCallback((sec: number) => {
    if (videoRef.current) videoRef.current.currentTime = sec;
  }, []);

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (playing) videoRef.current.pause();
    else videoRef.current.play();
  };

  const skipBy = (sec: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + sec));
  };

  // Timeline click to seek
  const handleTimelineClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect || duration === 0) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(frac * duration);
  };

  // Drag segment boundaries
  const handleEdgeDrag = useCallback((e: MouseEvent) => {
    if (!dragging || !timelineRef.current || duration === 0) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const newTime = frac * duration;

    const updated = segments.map((seg, i) => {
      if (i !== dragging.segIdx) return seg;
      if (dragging.edge === "start") {
        const startSec = Math.max(0, Math.min(newTime, toSec(seg.end) - 1));
        return { ...seg, start: fromSec(startSec), duration_sec: toSec(seg.end) - startSec };
      } else {
        const endSec = Math.max(toSec(seg.start) + 1, Math.min(newTime, duration));
        return { ...seg, end: fromSec(endSec), duration_sec: endSec - toSec(seg.start) };
      }
    });
    onSegmentsChange(updated);
    seekTo(newTime);
  }, [dragging, duration, segments, onSegmentsChange, seekTo]);

  const handleEdgeDragEnd = useCallback(() => {
    setDragging(null);
  }, []);

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", handleEdgeDrag);
    window.addEventListener("mouseup", handleEdgeDragEnd);
    return () => {
      window.removeEventListener("mousemove", handleEdgeDrag);
      window.removeEventListener("mouseup", handleEdgeDragEnd);
    };
  }, [dragging, handleEdgeDrag, handleEdgeDragEnd]);

  // Split segment at current playback position
  const splitAtPlayhead = () => {
    const t = currentTime;
    const segIdx = segments.findIndex((s) => t >= toSec(s.start) && t <= toSec(s.end));
    if (segIdx < 0) return;
    const seg = segments[segIdx];
    const splitTime = fromSec(t);
    const seg1 = { ...seg, end: splitTime, duration_sec: t - toSec(seg.start) };
    const seg2 = { ...seg, start: splitTime, end: seg.end, duration_sec: toSec(seg.end) - t };
    const updated = [...segments];
    updated.splice(segIdx, 1, seg1, seg2);
    onSegmentsChange(updated.map((s, i) => ({ ...s, index: i + 1 })));
  };

  // Check if playhead is inside a segment
  const playheadInSegment = segments.some((s) => currentTime >= toSec(s.start) && currentTime <= toSec(s.end));

  // Create new segment at current position
  const createSegmentAtPlayhead = () => {
    const startSec = currentTime;
    const endSec = Math.min(currentTime + 600, duration); // default 10 min
    const newSeg: GameSegment = {
      index: segments.length + 1,
      start: fromSec(startSec),
      end: fromSec(endSec),
      duration_sec: endSec - startSec,
    };
    const all = [...segments, newSeg].sort((a, b) => toSec(a.start) - toSec(b.start));
    onSegmentsChange(all.map((s, i) => ({ ...s, index: i + 1 })));
  };

  return (
    <div style={{ background: "#fff", border: "1px solid #ddd", borderRadius: 8, overflow: "hidden" }}>
      {/* Video */}
      <div style={{ background: "#000", position: "relative" }}>
        <video
          ref={videoRef}
          src={videoUrl}
          style={{ width: "100%", maxHeight: 400, display: "block" }}
          preload="metadata"
        />
      </div>

      {/* Controls */}
      <div style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #eee" }}>
        <button onClick={togglePlay} style={ctrlBtnStyle}>
          {playing ? "Pause" : "Play"}
        </button>
        <button onClick={() => skipBy(-10)} style={ctrlBtnStyle}>-10s</button>
        <button onClick={() => skipBy(-2)} style={ctrlBtnStyle}>-2s</button>
        <button onClick={() => skipBy(2)} style={ctrlBtnStyle}>+2s</button>
        <button onClick={() => skipBy(10)} style={ctrlBtnStyle}>+10s</button>
        <span style={{ fontSize: 13, fontFamily: "monospace", color: "#333", minWidth: 90 }}>
          {formatDisplay(currentTime)} / {formatDisplay(duration)}
        </span>
        {/* Timeline zoom */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
          <button onClick={zoomOut} disabled={zoom <= ZOOM_MIN} style={ctrlBtnStyle} title="Zoom timeline out">−</button>
          <span style={{ fontSize: 12, color: "#666", minWidth: 30, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
            {zoom}×
          </span>
          <button onClick={zoomIn} disabled={zoom >= ZOOM_MAX} style={ctrlBtnStyle} title="Zoom timeline in">+</button>
          {zoom !== 1 && (
            <button onClick={() => setZoom(1)} style={ctrlBtnStyle} title="Fit whole video">Fit</button>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {playheadInSegment ? (
          <button onClick={splitAtPlayhead} style={{ ...ctrlBtnStyle, color: "#e37400", borderColor: "#e37400" }}>
            Split here
          </button>
        ) : (
          <button onClick={createSegmentAtPlayhead} style={{ ...ctrlBtnStyle, color: "#137333", borderColor: "#137333" }}>
            New segment here
          </button>
        )}
      </div>

      {/* Timeline — scroll container holds the (possibly wider-than-panel)
          zoomable track. timelineRef stays on the inner track so the click /
          drag fraction math keeps working: getBoundingClientRect().left is
          viewport-relative and already folds in the horizontal scroll. */}
      <div ref={scrollRef} style={{ overflowX: zoom > 1 ? "auto" : "hidden", overflowY: "hidden" }}>
      <div
        ref={timelineRef}
        onClick={handleTimelineClick}
        style={{
          position: "relative", height: 48, background: "#f5f5f5",
          cursor: "pointer", userSelect: "none",
          width: `${zoom * 100}%`,
        }}
      >
        {/* Segment blocks */}
        {duration > 0 && segments.map((seg, i) => {
          const left = (toSec(seg.start) / duration) * 100;
          const width = (seg.duration_sec / duration) * 100;
          const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
          const tooLong = seg.duration_sec > PBV_MAX_SEC;

          return (
            <div
              key={seg.index}
              style={{
                position: "absolute", top: 4, bottom: 4,
                left: `${left}%`, width: `${width}%`,
                background: tooLong ? `repeating-linear-gradient(45deg, ${color}33, ${color}33 4px, ${color}55 4px, ${color}55 8px)` : `${color}33`,
                border: `2px solid ${color}`,
                borderRadius: 3,
                display: "flex", alignItems: "center", justifyContent: "center",
                overflow: "hidden",
              }}
            >
              {/* Drag handles */}
              <div
                onMouseDown={(e) => { e.stopPropagation(); setDragging({ segIdx: i, edge: "start" }); }}
                style={{
                  position: "absolute", left: -2, top: 0, bottom: 0, width: 8,
                  cursor: "ew-resize", background: `${color}88`, borderRadius: "3px 0 0 3px",
                }}
              />
              <div
                onMouseDown={(e) => { e.stopPropagation(); setDragging({ segIdx: i, edge: "end" }); }}
                style={{
                  position: "absolute", right: -2, top: 0, bottom: 0, width: 8,
                  cursor: "ew-resize", background: `${color}88`, borderRadius: "0 3px 3px 0",
                }}
              />

              {/* Label */}
              <span
                onClick={(e) => { e.stopPropagation(); seekTo(toSec(seg.start)); }}
                style={{
                  fontSize: 11, fontWeight: 600, color, whiteSpace: "nowrap",
                  pointerEvents: "auto", cursor: "pointer",
                }}
              >
                {width > 3 ? `Game ${seg.index}` : seg.index}
                {tooLong && width > 6 && " ⚠"}
              </span>
            </div>
          );
        })}

        {/* Playhead */}
        {duration > 0 && (
          <div
            style={{
              position: "absolute", top: 0, bottom: 0, width: 2,
              left: `${(currentTime / duration) * 100}%`,
              background: "#d93025", zIndex: 10, pointerEvents: "none",
            }}
          />
        )}

        {/* Time markers — interval tightens as you zoom so the track stays
            labeled at higher magnification (5m → 2m → 1m → 30s). */}
        {duration > 0 && (() => {
          const interval = zoom >= 16 ? 30 : zoom >= 8 ? 60 : zoom >= 4 ? 120 : 300;
          return Array.from({ length: Math.floor(duration / interval) + 1 }, (_, i) => i * interval).map((t) => (
            <div
              key={t}
              style={{
                position: "absolute", bottom: 0, left: `${(t / duration) * 100}%`,
                fontSize: 9, color: "#999", transform: "translateX(-50%)",
              }}
            >
              {formatDisplay(t)}
            </div>
          ));
        })()}
      </div>
      </div>

      {/* Segment warnings */}
      {segments.some((s) => s.duration_sec > PBV_MAX_SEC) && (
        <div style={{ padding: "6px 12px", background: "#fef7e0", fontSize: 12, color: "#7a5c00" }}>
          ⚠ Segments over 29 min exceed PB Vision's upload limit. Split them or trim the boundaries.
        </div>
      )}
    </div>
  );
}

const ctrlBtnStyle: React.CSSProperties = {
  padding: "4px 10px", background: "#fff", border: "1px solid #ddd",
  borderRadius: 4, fontSize: 12, cursor: "pointer", fontWeight: 500,
};
