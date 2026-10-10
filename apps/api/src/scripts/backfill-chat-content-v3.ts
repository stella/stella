import { panic } from "better-result";
import { SQL } from "bun";

import { resolveDatabaseUrl } from "../db-url";
import {
  CHAT_CONTENT_V3_REPAIR,
  countChatContentVersions,
  resetChatContentV3Checkpoints,
} from "../db/chat-content-v3-backfill";
import type { OnlineMigrationConnection } from "../db/online-migration-connection";
import {
  acquireOnlineMigrationLock,
  releaseOnlineMigrationLock,
} from "../db/online-migrations";

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
  const client = new SQL({ url, max: 1 });
  try {
    const session = await client.reserve();
    const connection = {
      execute: async (query, params = []) => {
        await session.unsafe(query, [...params]);
      },
      query: async (query, params = []) =>
        await session.unsafe<unknown[]>(query, [...params]),
      release: () => session.release(),
    } satisfies OnlineMigrationConnection;
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
          await CHAT_CONTENT_V3_REPAIR.repair(connection);
          process.stdout.write("Chat content v3 backfill complete\n");
        } finally {
          await releaseOnlineMigrationLock(connection);
        }
      }
    } finally {
      connection.release();
    }
  } finally {
    await client.end();
  }
};

await run();
