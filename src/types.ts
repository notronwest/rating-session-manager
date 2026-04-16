export const SESSION_STATUSES = [
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
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Session {
  id: string;
  status: SessionStatus;
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

export interface GameSegment {
  index: number;
  start: string; // HH:MM:SS.mmm
  end: string;
  duration_sec: number;
}

export interface DetectRequest {
  warmup?: number;
  min_gap?: number;
  long_break?: number;
  restart_lookahead?: number;
  min_game?: number;
}

export interface VideoFile {
  name: string;
  path: string;
  size_bytes: number;
  modified: string;
}
