import { classifyFailure } from "@stll/errors";

import {
  CorpusSchemaLaneUnavailableError,
  runUnderCorpusSchemaLane,
} from "@/api/db/corpus-schema-lane";
import type { Transaction } from "@/api/db/root";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { publicLawReadDb } from "@/api/lib/public-law-read-db";
import type { PublicLawReadOptions } from "@/api/lib/public-law-read-db";

const CASE_LAW_PUBLIC_READ_DB = Symbol("caseLawPublicReadDb");

export type CaseLawPublicReadTransaction = Pick<
  Transaction,
  "execute" | "select"
>;

type CaseLawReadOptions = PublicLawReadOptions;

export type CaseLawPublicReadDb = (<T>(
  fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  options?: CaseLawReadOptions,
) => Promise<T>) & {
  [CASE_LAW_PUBLIC_READ_DB]: true;
};

export const caseLawPublicReadDb: CaseLawPublicReadDb = Object.assign(
  async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    options?: CaseLawReadOptions,
  ): Promise<T> => await publicLawReadDb(fn, options),
  { [CASE_LAW_PUBLIC_READ_DB]: true as const },
);

/**
 * How long a public read keeps trying the corpus schema lane: a request does
 * not wait out a schema upgrade, it answers 503 and the client comes back.
 */
export const CASE_LAW_PUBLIC_READ_LANE_WAIT_MS = 1000;

/** Schema upgrades of the corpus tables hold the lane for seconds. */
const CORPUS_MAINTENANCE_RETRY_AFTER_MS = 30_000;

export const CORPUS_MAINTENANCE_CODE = "corpus_maintenance";

/** A public read refused while a schema upgrade holds the corpus tables. */
const corpusMaintenanceRefusal = (cause: CorpusSchemaLaneUnavailableError) =>
  classifyFailure(
    new HandlerError({
      status: 503,
      code: CORPUS_MAINTENANCE_CODE,
      message: "Case-law data is briefly unavailable during maintenance.",
      hint: "Retry the same request after the Retry-After interval.",
      retryable: true,
      retryAfterMs: CORPUS_MAINTENANCE_RETRY_AFTER_MS,
      cause,
    }),
    // The budget is this boundary's own, so running out of it is expected.
    "pg_lock_timeout_budgeted",
  );

type CaseLawPublicLaneOptions = {
  /** Test seam: how a refused try waits before the next; `Bun.sleep` otherwise. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * A public read long enough to hold back a schema upgrade, run under the
 * corpus schema lane shared (see `db/corpus-schema-lane.ts`): the upgrade
 * drains it before its DDL instead of losing its table lock to it. Each try
 * is its own read transaction, ended when refused, so a refused read holds
 * no lock and no snapshot while it waits; a read the lane stays closed to
 * within `CASE_LAW_PUBLIC_READ_LANE_WAIT_MS` rejects with a retryable 503.
 */
export const caseLawPublicReadUnderSchemaLane = async <T>(
  caseLawDb: CaseLawPublicReadDb,
  read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  { sleep }: CaseLawPublicLaneOptions = {},
): Promise<T> => {
  try {
    return await runUnderCorpusSchemaLane({
      database: { transaction: caseLawDb },
      work: read,
      laneWaitMs: CASE_LAW_PUBLIC_READ_LANE_WAIT_MS,
      ...(sleep === undefined ? {} : { sleep }),
    });
  } catch (error) {
    if (CorpusSchemaLaneUnavailableError.is(error)) {
      throw corpusMaintenanceRefusal(error);
    }
    throw error;
  }
};
