// POST to the wmpc_rating_hub pb.vision webhook so the rating-hub
// downloads insights for a newly-uploaded video and populates its DB.

export type NotifyOptions = {
  sessionId: string;
  videoId: string;
  onLog?: (msg: string) => void;
};

export class WebhookError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function notifyRatingHub(opts: NotifyOptions): Promise<{ status?: string; raw: unknown }> {
  const { sessionId, videoId, onLog = () => {} } = opts;
  const url = process.env.RATING_HUB_WEBHOOK_URL;
  const secret = process.env.RATING_HUB_WEBHOOK_SECRET;

  if (!url) {
    throw new WebhookError("RATING_HUB_WEBHOOK_URL is not set in .env");
  }

  onLog(`Notifying rating-hub webhook for video ${videoId} (session ${sessionId.slice(0, 8)}…)`);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ videoId, sessionId }),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw text */ }

  if (!res.ok) {
    throw new WebhookError(
      `rating-hub webhook returned ${res.status}: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`,
      res.status,
    );
  }

  const status = typeof parsed === "object" && parsed && "status" in parsed
    ? String((parsed as Record<string, unknown>).status)
    : undefined;
  onLog(`  rating-hub responded: ${status ?? res.status}`);
  return { status, raw: parsed };
}
