import { Result, TaggedError } from "better-result";
import type { TaggedErrorClass } from "better-result";
import { and, asc, eq, gt } from "drizzle-orm";

import { buildScreeningIndex } from "@stll/sanctions";
import type {
  SanctionsEntry,
  SanctionsSource,
  ScreeningIndex,
} from "@stll/sanctions";
import { Temporal } from "@stll/time";

import {
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
} from "@/api/db/schema";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";
import type { SanctionsReadDb } from "@/api/lib/lists/sanctions/read-db";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

// Entries are read in keyset pages so no single statement carries a whole
// list; the largest list holds tens of thousands of entries. Each page is an
// await, so a long read yields to other requests between pages. The index
// build itself is one synchronous pass in the matcher package; it is linear
// in the entries and runs once per edition, so it is not split further.
const ENTRY_PAGE_SIZE = 2000;

/**
 * How long a failed load is remembered. A stored edition that cannot be read
 * fails the same way on the next request, and re-reading a whole edition per
 * screening would put that cost on every check. The list stays unavailable in
 * the meantime, as it would be anyway.
 */
export const SANCTIONS_INDEX_FAILURE_MEMO_MS = 60_000;

export type SanctionsActiveEdition = NonNullable<
  SanctionsSourceFreshness["edition"]
>;

/** The edition could not be read in full; the caller reports the list unavailable. */
type SanctionsIndexLoadError = { code: "load-failed" };

type IndexResult = Result<ScreeningIndex, SanctionsIndexLoadError>;

type LoadStage = "read-failed" | "short-read" | "build-failed";

const SanctionsIndexLoadFailureBase: TaggedErrorClass<"SanctionsIndexLoadFailure"> =
  TaggedError("SanctionsIndexLoadFailure");

/** Why an edition's index could not be built; reported to error telemetry. */
export class SanctionsIndexLoadFailure extends SanctionsIndexLoadFailureBase<{
  stage: LoadStage;
  message: string;
  cause?: unknown;
}> {}

type LoadEditionEntriesOptions = {
  db: SanctionsReadDb;
  edition: SanctionsActiveEdition;
  signal?: AbortSignal;
};

export const loadEditionEntries = async ({
  db,
  edition,
  signal,
}: LoadEditionEntriesOptions): Promise<SanctionsEntry[]> => {
  const entries: SanctionsEntry[] = [];
  const loadPage = async (cursor: string | null): Promise<void> => {
    if (signal?.aborted) {
      return;
    }
    const page = await db(async (tx) => {
      // Acquiring a transaction may outlive cancellation; never issue its page.
      if (signal?.aborted) {
        return [];
      }
      return await tx
        .select({
          sourceEntryId: sanctionsEditionEntries.sourceEntryId,
          payload: sanctionsEntryPayloads.payload,
        })
        .from(sanctionsEditionEntries)
        .innerJoin(
          sanctionsEntryPayloads,
          eq(
            sanctionsEditionEntries.contentHash,
            sanctionsEntryPayloads.contentHash,
          ),
        )
        .where(
          and(
            eq(sanctionsEditionEntries.editionId, edition.id),
            cursor === null
              ? undefined
              : gt(sanctionsEditionEntries.sourceEntryId, cursor),
          ),
        )
        .orderBy(asc(sanctionsEditionEntries.sourceEntryId))
        .limit(ENTRY_PAGE_SIZE);
    });
    if (signal?.aborted) {
      return;
    }
    for (const row of page) {
      entries.push(row.payload);
    }
    const last = page.at(-1);
    if (page.length === ENTRY_PAGE_SIZE && last !== undefined) {
      await loadPage(last.sourceEntryId);
    }
  };
  await loadPage(null);
  return entries;
};

type BuildSanctionsIndex = typeof buildScreeningIndex;

type LoadIndexProps = {
  db: SanctionsReadDb;
  source: SanctionsSource;
  edition: SanctionsActiveEdition;
  build: BuildSanctionsIndex;
};

const loadIndex = async ({
  db,
  source,
  edition,
  build,
}: LoadIndexProps): Promise<
  Result<ScreeningIndex, SanctionsIndexLoadFailure>
> => {
  const loaded = await Result.tryPromise({
    try: async () => await loadEditionEntries({ db, edition }),
    catch: (cause) =>
      new SanctionsIndexLoadFailure({
        stage: "read-failed",
        message: "The edition's entries could not be read",
        cause,
      }),
  });
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  // A ready edition is complete by construction; a short read means the
  // stored edition is not the one that was verified, so it is not used.
  if (loaded.value.length !== edition.entryCount) {
    return Result.err(
      new SanctionsIndexLoadFailure({
        stage: "short-read",
        message: `Read ${loaded.value.length} of ${edition.entryCount} entries`,
      }),
    );
  }
  const entries = loaded.value;
  return Result.try({
    try: () =>
      build([
        {
          version: {
            source,
            publishedAt: edition.publishedAt,
            fileId: edition.fileId,
          },
          entries,
        },
      ]),
    catch: (cause) =>
      new SanctionsIndexLoadFailure({
        stage: "build-failed",
        message: "The edition's index could not be built",
        cause,
      }),
  });
};

type CacheProps = {
  db: SanctionsReadDb;
  source: SanctionsSource;
  edition: SanctionsActiveEdition;
};

export type SanctionsIndexCache = {
  /**
   * The index of one source's active edition, built once per edition. Never
   * rejects: a load that fails for any reason is a `load-failed` error.
   */
  get: (props: CacheProps) => Promise<IndexResult>;
  /**
   * Build the index of a newly activated edition ahead of the next screening,
   * for a source this process already screens against. A source it has not
   * screened yet stays cold, so a process that never screens holds no index.
   */
  refresh: (props: CacheProps) => Promise<void>;
};

type CreateSanctionsIndexCacheOptions = {
  build?: BuildSanctionsIndex | undefined;
  failureMemoMs?: number | undefined;
  nowMs?: (() => number) | undefined;
  /** Where a failed load is reported. List and edition ids only, never a subject. */
  reportFailure?:
    | ((
        failure: SanctionsIndexLoadFailure,
        ids: { source: SanctionsSource; editionId: string },
      ) => void)
    | undefined;
};

const INDEX_LOAD_FAILURE_SINK = failureSink({
  event: "sanctions.index_load_failed",
  expected: [],
});

export const observeSanctionsIndexLoadFailure: NonNullable<
  CreateSanctionsIndexCacheOptions["reportFailure"]
> = (failure, { source, editionId }) => {
  observeFailure(failure, {
    sink: INDEX_LOAD_FAILURE_SINK,
    ctx: {
      feature: "sanctions.index_load",
      source,
      versionId: editionId,
      stage: failure.stage,
    },
  });
};

/**
 * One screening index per source, keyed by the active edition it was built
 * from. Editions are immutable, so an index stays valid until the source
 * activates another edition; the next screening then replaces it.
 *
 * A failed load is reported, dropped from the cache and remembered for
 * `failureMemoMs`: screenings in that window answer `load-failed` without
 * re-reading the edition, and the first one after it tries again.
 */
export const createSanctionsIndexCache = ({
  build = buildScreeningIndex,
  failureMemoMs = SANCTIONS_INDEX_FAILURE_MEMO_MS,
  nowMs = () => Temporal.Now.instant().epochMilliseconds,
  reportFailure = observeSanctionsIndexLoadFailure,
}: CreateSanctionsIndexCacheOptions = {}): SanctionsIndexCache => {
  const bySource = new Map<
    SanctionsSource,
    {
      editionId: SanctionsActiveEdition["id"];
      load: symbol;
      index: Promise<IndexResult>;
    }
  >();
  const failedAt = new Map<
    SanctionsSource,
    { editionId: SanctionsActiveEdition["id"]; at: number }
  >();

  const start = async ({
    db,
    source,
    edition,
  }: CacheProps): Promise<IndexResult> => {
    const load = Symbol(source);
    const settle = async (): Promise<IndexResult> => {
      const loaded = await loadIndex({ db, source, edition, build });
      if (loaded.isOk()) {
        if (failedAt.get(source)?.editionId === edition.id) {
          failedAt.delete(source);
        }
        return Result.ok(loaded.value);
      }
      // Only this load's own entry is dropped; a newer edition's load that
      // replaced it in the meantime stays.
      if (bySource.get(source)?.load === load) {
        bySource.delete(source);
      }
      failedAt.set(source, { editionId: edition.id, at: nowMs() });
      reportFailure(loaded.error, { source, editionId: edition.id });
      return Result.err({ code: "load-failed" });
    };
    const index = settle();
    bySource.set(source, { editionId: edition.id, load, index });
    return await index;
  };

  return {
    get: async (props) => {
      const { source, edition } = props;
      const cached = bySource.get(source);
      if (cached !== undefined && cached.editionId === edition.id) {
        return await cached.index;
      }
      const failure = failedAt.get(source);
      if (
        failure !== undefined &&
        failure.editionId === edition.id &&
        nowMs() - failure.at < failureMemoMs
      ) {
        return Result.err({ code: "load-failed" });
      }
      return await start(props);
    },
    refresh: async (props) => {
      const cached = bySource.get(props.source);
      if (cached === undefined || cached.editionId === props.edition.id) {
        return;
      }
      const rebuilt = await start(props);
      if (rebuilt.isErr()) {
        // A failed rebuild is reported and remembered like any other; the
        // next screening answers from the memo or tries again.
        return;
      }
    },
  };
};

/** Shared by signed-in screening callers in this process. */
export const sharedSanctionsIndexCache: SanctionsIndexCache =
  createSanctionsIndexCache();
