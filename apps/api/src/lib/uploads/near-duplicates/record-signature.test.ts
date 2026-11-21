import { expect, test } from "bun:test";

import { withoutContentEncryptionKeyForTesting } from "@/api/env-content-encryption";
import { toSafeId } from "@/api/lib/branded-types";
import { recordNearDuplicateSignature } from "@/api/lib/uploads/near-duplicates/record-signature";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const TEXT = Array.from(
  { length: 80 },
  (_, index) => `clause ${index} binds the parties`,
).join(" ");

test("records nothing and reports the configuration without a content key", async () => {
  const writes: string[] = [];
  const db = {
    transaction: () => {
      writes.push("transaction");
      throw new Error("no write expected");
    },
  };
  const restoreKey = withoutContentEncryptionKeyForTesting();
  try {
    const recorded = await recordNearDuplicateSignature(
      asTestRaw<Parameters<typeof recordNearDuplicateSignature>[0]>(db),
      {
        entityId: toSafeId<"entity">("0190a5d2-0000-7000-8000-000000000001"),
        entityVersionId: toSafeId<"entityVersion">(
          "0190a5d2-0000-7000-8000-000000000002",
        ),
        organizationId: toSafeId<"organization">(
          "0190a5d2-0000-7000-8000-000000000003",
        ),
        workspaceId: toSafeId<"workspace">(
          "0190a5d2-0000-7000-8000-000000000004",
        ),
        text: TEXT,
      },
    );
    expect(recorded.isErr()).toBe(true);
  } finally {
    restoreKey();
  }
  expect(writes).toEqual([]);
});
