// parser-output-unchanged: constrains persistence of already parsed output, not parsing.
import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import { caseLawDecisions } from "@/api/db/schema";
import {
  DERIVED_REPLAY_METADATA_KEYS,
  type DerivedReplayMetadataPatch,
} from "@/api/lib/legal-search/pipeline-metadata-policy";

import type { DecisionRowWrite } from "./decision-row-context";

/** Source watermarks can move without updatedAt; bind both before reading raw or parsing. */
export const STORED_REPLAY_INPUT_TOKEN = sql<string>`jsonb_build_array(
  ${caseLawDecisions.updatedAt}::text,
  ${caseLawDecisions.sourceObservationOrder}::text,
  ${caseLawDecisions.sourceHash},
  ${caseLawDecisions.sourceHashVersion},
  ${caseLawDecisions.parserVersion},
  ${caseLawDecisions.sourceRawS3Key}
)::text`;

/** Publisher identity, metadata, raw input and observation watermarks are immutable in replay. */
export const STORED_REPLAY_COLUMNS = [
  "fulltext",
  "sections",
  "documentAst",
  "parserVersion",
  "parsedSourceHash",
  "parsedSourceHashVersion",
  "parsedSourceRawS3Key",
  "updatedAt",
  "corpusMirrorStatus",
  "normalizedS3Key",
  "astS3Key",
  "contentHash",
  "textS3Key",
  "metadata",
] as const satisfies readonly (keyof typeof caseLawDecisions.$inferInsert)[];

export const STORED_REPLAY_METADATA_KEYS = DERIVED_REPLAY_METADATA_KEYS;

/** Select a patch without admitting any publisher values into the merge. */
export const extractedReplayMetadata = (
  metadata: Record<string, unknown>,
): DerivedReplayMetadataPatch =>
  Object.fromEntries(
    STORED_REPLAY_METADATA_KEYS.filter((key) =>
      Object.hasOwn(metadata, key),
    ).map((key) => [key, metadata[key]]),
  );

export const storedReplayMetadata = (
  stored: Record<string, unknown> | null,
  patch: DerivedReplayMetadataPatch,
): Record<string, unknown> => {
  for (const key of Object.keys(patch)) {
    if (!STORED_REPLAY_METADATA_KEYS.some((allowed) => allowed === key)) {
      panic(`Stored replay cannot merge metadata key ${key}`);
    }
  }
  return Object.fromEntries([
    ...Object.entries(stored ?? {}).filter(
      ([key]) =>
        !STORED_REPLAY_METADATA_KEYS.some((allowed) => allowed === key),
    ),
    ...Object.entries(patch),
  ]);
};

export type StoredReplayUpdate = Pick<
  PgUpdateSetSource<typeof caseLawDecisions>,
  (typeof STORED_REPLAY_COLUMNS)[number]
>;

/** Enforce the same allowlist on spread values as on literal fields. */
export const storedReplayUpdate = (
  update: StoredReplayUpdate,
): StoredReplayUpdate => {
  for (const key of Object.keys(update)) {
    if (!STORED_REPLAY_COLUMNS.some((column) => column === key)) {
      panic(`Stored replay cannot write decision column ${key}`);
    }
  }
  return update;
};

/** Replay holds the observed input still, rather than announcing a new observation. */
export const storedReplayObservationPredicate = (write: DecisionRowWrite) =>
  write.inputProvenance.type === "stored-replay"
    ? sql`${caseLawDecisions.sourceObservationOrder} IS NOT DISTINCT FROM ${write.inputProvenance.observationOrder}`
    : sql`${caseLawDecisions.sourceObservationOrder} = ${write.observationOrder}`;
