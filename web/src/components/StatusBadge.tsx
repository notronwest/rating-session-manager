const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  scheduled: { bg: "#e8f0fe", text: "#1a73e8" },
  recording: { bg: "#fce8e6", text: "#d93025" },
  recorded: { bg: "#fef7e0", text: "#e37400" },
  splitting: { bg: "#fef7e0", text: "#e37400" },
  split: { bg: "#e6f4ea", text: "#137333" },
  uploading: { bg: "#fef7e0", text: "#e37400" },
  processing: { bg: "#fef7e0", text: "#e37400" },
  tagging: { bg: "#fce8e6", text: "#d93025" },
  importing: { bg: "#fef7e0", text: "#e37400" },
  complete: { bg: "#e6f4ea", text: "#137333" },
  failed: { bg: "#fce8e6", text: "#d93025" },
};

export default function StatusBadge({ status }: { status: string }) {
  const colors = STATUS_COLORS[status] || { bg: "#eee", text: "#666" };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 12,
        fontSize: 12,
        fontWeight: 600,
        background: colors.bg,
        color: colors.text,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {status}
    </span>
  );
}
