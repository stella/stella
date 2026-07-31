import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

import { pendingUploads } from "@/api/db/schema";

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
    expect(recoveryIndex?.config.where).toBeDefined();
  });
});
