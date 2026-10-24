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
import { envDbLoadGate } from "../env-db-load-gate";
import {
  requireEbsConfiguration,
  resolveEbsConfiguration,
} from "../lib/db/ebs-signal-reader";
import { withChatContentV3MigrationLock } from "./backfill-chat-content-v3-lock";

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
      await withChatContentV3MigrationLock(connection, async () => {
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
        if (outcome.type === "complete") {
          process.stdout.write("Chat content v3 backfill complete\n");
        } else {
          // The constraints stay NOT VALID until a rerun completes, so an
          // operator job must not read the deferral as success. 75 is the
          // conventional "temporary failure, retry later" exit code.
          process.stderr.write(
            `Chat content v3 backfill deferred at ${outcome.step}; rerun after ${String(outcome.retryAfterMs)} ms\n`,
          );
          process.exitCode = 75;
        }
      });
    }
  } finally {
    await connection.release();
  }
};

await run();
