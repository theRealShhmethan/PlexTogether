import type { PlaybackDecision, StreamDecision } from "@/lib/plex/playback";

const LABELS: Record<string, string> = {
  copy: "direct stream (copied)",
  transcode: "transcoding",
  burn: "burned in",
  ignore: "off",
  unavailable: "unavailable",
};

function line(s: StreamDecision): string {
  const what = s.kind === "video" ? "Video" : s.kind === "audio" ? "Audio" : "Subtitles";
  const codec = s.codec ? s.codec.toUpperCase() : "?";
  const lang = s.language ? ` (${s.language})` : "";
  return `${what}: ${codec}${lang} — ${LABELS[s.decision ?? ""] ?? s.decision ?? "unknown"}`;
}

/** Shows what Plex decided to do with each stream — the Phase 5 "how does it play" answer. */
export function DecisionSummary({ decision, location }: { decision: PlaybackDecision; location: "lan" | "wan" }) {
  const shown = decision.streams.filter((s) => s.decision && s.decision !== "ignore" && s.decision !== "none");
  return (
    <div className="status ok small">
      <strong>
        {decision.partDecision === "transcode" || shown.some((s) => s.decision === "transcode")
          ? "Plex is transcoding"
          : "Plex is direct streaming"}
        {decision.videoResolution ? ` · source ${decision.videoResolution}` : ""}
        {decision.container ? ` · ${decision.container}` : ""}
        {` · ${location === "lan" ? "local connection, full quality" : "remote connection, capped at 1080p/8 Mbps"}`}
      </strong>
      <ul className="muted">
        {shown.map((s, i) => (
          <li key={i}>{line(s)}</li>
        ))}
        {decision.reasons.map((r, i) => (
          <li key={`r${i}`}>Plex says: {r}</li>
        ))}
      </ul>
    </div>
  );
}
