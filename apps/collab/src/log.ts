import { Temporal } from "@stll/time";

type CollabLogEvent =
  | {
      event: "redis_store_policy";
      level: "error" | "warn";
      status: "refused" | "unknown";
      storeClass: "durable-coordination" | "cache";
      operatorAction: string;
    }
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
  if (event.event === "redis_store_policy") {
    const name = "AdmissionStoreEvictionPolicyRefused";
    process.stdout.write(
      `${JSON.stringify({
        _aws: {
          Timestamp: Temporal.Now.instant().epochMilliseconds,
          CloudWatchMetrics: [
            {
              Namespace: "Stella/Api",
              Dimensions: [[]],
              Metrics: [{ Name: name, Unit: "Count" }],
            },
          ],
        },
        [name]: event.status === "refused" ? 1 : 0,
      })}\n`,
    );
  }
  const line = `${JSON.stringify({ service: "collab", ...event })}\n`;
  if (event.level === "error" || event.level === "warn") {
    process.stderr.write(line);
    return;
  }

  process.stdout.write(line);
};
