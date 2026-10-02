import { panic, Result } from "better-result";
import { open, readFile, rename } from "node:fs/promises";
import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import {
  SK_US_RAW_OUTCOMES,
  SK_US_RAW_OUTCOME_DISPOSITIONS,
} from "@/api/scripts/complete-sk-us-raw-plan";
import type {
  SkUsRawCursor,
  SkUsRawOutcome,
} from "@/api/scripts/complete-sk-us-raw-plan";

const cursorSchema = v.strictObject({
  id: v.pipe(v.string(), v.uuid()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
});
const checkpointSchema = v.strictObject({
  version: v.literal(1),
  sourceId: v.pipe(v.string(), v.uuid()),
  cursor: cursorSchema,
  outcome: v.picklist(SK_US_RAW_OUTCOMES),
});
type ReadSkUsRawCheckpointOptions = {
  checkpointPath: string;
  sourceId: SafeId<"caseLawSource">;
};

export const readSkUsRawCheckpoint = async ({
  checkpointPath,
  sourceId,
}: ReadSkUsRawCheckpointOptions) => {
  const checkpointRead = await Result.tryPromise({
    try: async () => await readFile(checkpointPath, "utf-8"),
    catch: (cause) => cause,
  });
  let after: SkUsRawCursor | null = null;
  if (Result.isOk(checkpointRead)) {
    const state = v.parse(checkpointSchema, JSON.parse(checkpointRead.value));
    if (state.sourceId !== sourceId) {
      panic("Checkpoint belongs to a different source");
    }
    if (SK_US_RAW_OUTCOME_DISPOSITIONS[state.outcome] !== "terminal") {
      panic("Checkpoint does not record a terminal applied outcome");
    }
    after = {
      id: brandPersistedCaseLawDecisionId(state.cursor.id),
      createdAt: state.cursor.createdAt,
    };
  } else if (
    !(
      checkpointRead.error instanceof Error &&
      "code" in checkpointRead.error &&
      checkpointRead.error.code === "ENOENT"
    )
  ) {
    throw checkpointRead.error;
  }

  return after;
};

type PersistSkUsRawCheckpointOptions = ReadSkUsRawCheckpointOptions & {
  cursor: SkUsRawCursor;
  outcome: SkUsRawOutcome;
};

// The maintenance lane serializes journal/checkpoint writers and releases on a crash.
export const journalSkUsRawOutcome = async ({
  checkpointPath,
  sourceId,
  cursor,
  outcome,
}: PersistSkUsRawCheckpointOptions) => {
  const record = {
    version: 1,
    sourceId,
    cursor,
    outcome,
    disposition: SK_US_RAW_OUTCOME_DISPOSITIONS[outcome],
  };
  const journal = await open(`${checkpointPath}.outcomes.jsonl`, "a");
  try {
    await journal.writeFile(`${JSON.stringify(record)}\n`);
    await journal.sync();
  } finally {
    await journal.close();
  }
};

export const persistSkUsRawCheckpoint = async ({
  checkpointPath,
  sourceId,
  cursor,
  outcome,
}: PersistSkUsRawCheckpointOptions) => {
  if (SK_US_RAW_OUTCOME_DISPOSITIONS[outcome] !== "terminal") {
    panic("Checkpoint does not record a terminal applied outcome");
  }
  const state = { version: 1, sourceId, cursor, outcome };
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  const temporary = await open(temporaryPath, "w");
  try {
    await temporary.writeFile(JSON.stringify(state));
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  await rename(temporaryPath, checkpointPath);
};
