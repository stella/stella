import { panic } from "better-result";

import { resolveDatabaseUrl } from "../db-url";
import {
  CHAT_CONTENT_V3_REPAIR,
  countChatContentVersions,
  resetChatContentV3Checkpoints,
} from "../db/chat-content-v3-backfill";
import { createOnlineTableGate } from "../db/online-ddl";
import {
  openOnlineIndexObserver,
  openOnlineRepairConnection,
} from "../db/online-index-observer";
import {
  acquireOnlineMigrationLock,
  releaseOnlineMigrationLock,
} from "../db/online-migrations";
import { envDbLoadGate } from "../env-db-load-gate";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => !["--dry-run", "--apply", "--retry-failed"].includes(arg),
    ) ||
    (args.includes("--dry-run") && args.includes("--apply")) ||
    (args.includes("--retry-failed") && !args.includes("--apply"))
  ) {
    panic(
      "Usage: db:backfill-chat-content-v3 [--dry-run | --apply [--retry-failed]]",
    );
  }
  const url = resolveDatabaseUrl();
  if (!url) {
    panic("Chat content backfill requires a database connection");
  }
  const connection = await openOnlineRepairConnection(url);
  // The gate terminates this session when it cannot cancel its own work; the
  // lock went with the session, and an unlock there would mask why.
  let sessionStatus: "active" | "terminated" = "active";
  const { terminate } = connection;
  if (terminate) {
    connection.terminate = async () => {
      sessionStatus = "terminated";
      await terminate();
    };
  }
  try {
    if (!args.includes("--apply")) {
      await connection.execute("BEGIN READ ONLY");
      try {
        const counts = await countChatContentVersions(connection);
        process.stdout.write(
          `${JSON.stringify({ mode: "dry-run", wouldConvertVersions: [1, 2], counts })}\n`,
        );
      } finally {
        await connection.execute("ROLLBACK");
      }
    } else {
      // Serialize with deploy's online repair, including checkpoint reset.
      await acquireOnlineMigrationLock(connection);
      try {
        if (args.includes("--retry-failed")) {
          await resetChatContentV3Checkpoints(connection);
        }
        // The constraint validations wait for table locks, so they run
        // through the same gate as the deploy's online phase.
        const ebs = requireEbsConfiguration(
          resolveEbsConfiguration(envDbLoadGate),
        );
        if (ebs.isErr()) {
          throw ebs.error;
        }
        const outcome = await CHAT_CONTENT_V3_REPAIR.repair(
          connection,
          createOnlineTableGate({
            connection,
            gate: { ebs: ebs.value },
            reserveObserver: async () => await openOnlineIndexObserver(url),
          }),
        );
        process.stdout.write(
          outcome.type === "complete"
            ? "Chat content v3 backfill complete\n"
            : `Chat content v3 backfill deferred at ${outcome.step}; rerun after ${String(outcome.retryAfterMs)} ms\n`,
        );
      } finally {
        if (sessionStatus === "active") {
          await releaseOnlineMigrationLock(connection);
        }
      }
    }
  } finally {
    await connection.release();
  }
};

await run();
