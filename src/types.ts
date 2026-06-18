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
  // Reserved for rows mirrored in from rating-hub by
  // scripts/ratinghub-backfill.ts. Those sessions never went through
  // the local record → split → upload → tag → sync pipeline; the games
  // already exist in rating-hub. Distinct from `complete` so the
  // Dashboard doesn't claim the local pipeline finished work it never
  // actually did.
  "imported",
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
  /** When this session was archived (= hidden from the active dashboard
   *  list). NULL = active. See migration 050. Toggled by Archive
   *  Completed / Archive Attached / per-session archive actions. */
  archived_at: string | null;
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
  break_sec?: number;
  empty_max_n?: number;
  min_game?: number;
}

export interface VideoFile {
  name: string;
  path: string;
  size_bytes: number;
  modified: string;
}
