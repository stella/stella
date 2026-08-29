type CollabLogEvent =
  | {
      event: "redis_ready";
      level: "info";
    }
  | {
      event: "redis_unavailable";
      level: "error";
      signal: "close" | "end" | "error";
      transport: "publish" | "subscribe";
    }
  | {
      event: "snapshot_generation_conflict";
      generation: number;
      level: "error";
      roomId: string;
    }
  | {
      event: "awareness_identity_conflict";
      generation: number;
      level: "error";
      roomId: string;
    }
  | {
      event: "shutdown_drain_timeout";
      level: "error";
    };

/** Closed event shapes prevent credentials, identities, or document data entering logs. */
export const logCollabEvent = (event: CollabLogEvent) => {
  const line = `${JSON.stringify({ service: "collab", ...event })}\n`;
  if (event.level === "error") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
};
