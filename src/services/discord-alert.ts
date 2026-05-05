// Send a structured alert to a Discord webhook. No-op when
// DISCORD_WEBHOOK_URL isn't configured — code paths that wire alerts
// don't need to feature-flag themselves.
//
// Usage:
//   await sendDiscordAlert({
//     title: "CourtReserve sync failed",
//     level: "error",
//     message: "Couldn't refresh today's schedule.",
//     fields: [
//       { name: "Error code", value: "auth_expired" },
//       { name: "Recovery", value: "Re-auth the CR profile..." },
//     ],
//   });
//
// Discord rate-limits webhooks at 30/min per channel — we don't approach
// that, but we still dedupe by alert key over a short window so a
// repeated dashboard click doesn't fire the same alert ten times.

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const recentAlerts = new Map<string, number>();

export type AlertLevel = "info" | "warning" | "error";

export interface DiscordAlert {
  /** Short title — surfaces as the embed title in Discord. */
  title: string;
  /** Body. Discord renders Markdown. */
  message: string;
  level?: AlertLevel;
  /** Key/value rows shown under the message. Discord caps each value at 1024 chars. */
  fields?: { name: string; value: string }[];
  /** Override the dedupe key. Defaults to `title`. */
  dedupeKey?: string;
  /** Skip the in-process dedupe window. Use sparingly. */
  alwaysFire?: boolean;
}

const LEVEL_COLOR: Record<AlertLevel, number> = {
  info: 0x1a73e8,    // blue
  warning: 0xfbbc04, // amber
  error: 0xd93025,   // red
};

const LEVEL_PREFIX: Record<AlertLevel, string> = {
  info: ":information_source:",
  warning: ":warning:",
  error: ":rotating_light:",
};

export async function sendDiscordAlert(alert: DiscordAlert): Promise<{ sent: boolean; reason?: string }> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { sent: false, reason: "no_webhook_url" };

  const level: AlertLevel = alert.level ?? "info";
  const key = alert.dedupeKey ?? alert.title;
  const now = Date.now();

  if (!alert.alwaysFire) {
    const last = recentAlerts.get(key);
    if (last && now - last < RATE_LIMIT_WINDOW_MS) {
      return { sent: false, reason: "rate_limited" };
    }
  }

  const payload = {
    username: "Session Manager",
    embeds: [
      {
        title: `${LEVEL_PREFIX[level]} ${alert.title}`,
        description: alert.message.slice(0, 4000),
        color: LEVEL_COLOR[level],
        fields: (alert.fields ?? []).map((f) => ({
          name: f.name.slice(0, 256),
          value: f.value.slice(0, 1024),
          inline: false,
        })),
        timestamp: new Date(now).toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[discord-alert] webhook returned HTTP ${res.status}: ${text}`);
      return { sent: false, reason: `http_${res.status}` };
    }
    recentAlerts.set(key, now);
    return { sent: true };
  } catch (err) {
    console.error("[discord-alert] post failed:", err);
    return { sent: false, reason: (err as Error).message };
  }
}
