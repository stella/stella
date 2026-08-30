import {
  bufferObjectCleanupIntents as cleanupIntents,
} from "@/api/db/schema";
import * as schema from "../../apps/api/src/db/schema.ts";

declare const tx: {
  insert: (table: unknown) => {
    values: (payload: unknown) => unknown;
  };
};
declare const anotherTable: unknown;
declare const resolveStatus: () => string;
declare const status: string;

// A direct single-row insert must choose its lifecycle state.
const _missingSingleStatus = tx
  .insert(cleanupIntents)
  .values(
    // oxlint-disable-next-line require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status -- intentional bad fixture
    { objectKey: "first" },
  );

// Every row in a batch must make the same explicit decision.
const _missingBatchStatus = tx.insert(cleanupIntents).values([
  { objectKey: "second", status },
  // oxlint-disable-next-line require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status -- intentional bad fixture
  { objectKey: "third" },
]);

// Canonical namespace imports name the same table.
const _missingNamespaceStatus = tx
  .insert(schema.bufferObjectCleanupIntents)
  .values(
    // oxlint-disable-next-line require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status -- intentional bad fixture
    {
      objectKey: "fourth",
    },
  );

// An explicitly undefined state is still an omitted lifecycle decision.
const _undefinedStatus = tx.insert(cleanupIntents).values(
  // oxlint-disable-next-line require-buffer-cleanup-intent-status/require-buffer-cleanup-intent-status -- intentional bad fixture
  { objectKey: "fifth", status: undefined },
);
// Explicit non-undefined expressions are accepted.
const _explicitStatus = tx.insert(cleanupIntents).values({
  objectKey: "sixth",
  status,
});
const _explicitStatusExpression = tx.insert(cleanupIntents).values({
  objectKey: "seventh",
  status: resolveStatus(),
});
const _explicitBatchStatuses = tx.insert(cleanupIntents).values([
  { objectKey: "eighth", status },
  { objectKey: "ninth", status },
]);

// Other tables and variable-built payloads are outside this narrow guard.
const _otherTable = tx.insert(anotherTable).values({ objectKey: "tenth" });
const payload = { objectKey: "eleventh" };
const _variablePayload = tx.insert(cleanupIntents).values(payload);

export const __requireBufferCleanupIntentStatusFixture = {
  _explicitBatchStatuses,
  _explicitStatus,
  _explicitStatusExpression,
  _missingBatchStatus,
  _missingNamespaceStatus,
  _missingSingleStatus,
  _otherTable,
  _undefinedStatus,
  _variablePayload,
};
