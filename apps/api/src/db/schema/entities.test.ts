import { describe, expect, test } from "bun:test";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { bufferObjectCleanupIntents, pendingUploads } from "@/api/db/schema";

describe("pending upload recovery indexes", () => {
  test("the global stale-buffer sweep starts from claimed_at", () => {
    const recoveryIndex = getTableConfig(pendingUploads).indexes.find(
      (index) =>
        index.config.name === "pending_uploads_buffer_intent_recovery_idx",
    );

    expect(recoveryIndex).toBeDefined();
    expect(
      recoveryIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["claimed_at", "id"]);
    const recoveryPredicate = recoveryIndex?.config.where;
    expect(recoveryPredicate).toBeDefined();
    if (!recoveryPredicate) {
      return;
    }
    expect(new PgDialect().sqlToQuery(recoveryPredicate).sql).toContain(
      "IN ('scanning', 'failed')",
    );
  });
});

describe("buffer object cleanup tombstones", () => {
  test("survive owner deletion and have a bounded scheduler index", () => {
    const config = getTableConfig(bufferObjectCleanupIntents);

    expect(config.foreignKeys).toHaveLength(0);
    const scheduleIndex = config.indexes.find(
      (index) => index.config.name === "buffer_object_cleanup_schedule_idx",
    );
    expect(
      scheduleIndex?.config.columns.map((column) =>
        "name" in column ? column.name : undefined,
      ),
    ).toEqual(["next_attempt_at", "id"]);
  });
});
