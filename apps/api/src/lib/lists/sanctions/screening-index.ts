import { Result } from "better-result";
import { and, asc, eq, gt } from "drizzle-orm";

import { buildScreeningIndex } from "@stll/sanctions";
import type {
  SanctionsEntry,
  SanctionsSource,
  ScreeningIndex,
} from "@stll/sanctions";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
} from "@/api/db/schema";
import type { SanctionsSourceFreshness } from "@/api/lib/lists/sanctions/freshness";

// Entries are read in keyset pages so no single statement carries a whole
// list; the largest list holds tens of thousands of entries.
const ENTRY_PAGE_SIZE = 2000;

export type SanctionsActiveEdition = NonNullable<
  SanctionsSourceFreshness["edition"]
>;

/** The edition could not be read in full; the caller reports the list unavailable. */
export type SanctionsIndexLoadError = { code: "load-failed" };

type IndexResult = Result<ScreeningIndex, SanctionsIndexLoadError>;

const loadEditionEntries = async (
  db: ScopedDb,
  edition: SanctionsActiveEdition,
): Promise<SanctionsEntry[] | null> => {
  const entries: SanctionsEntry[] = [];
  const loadPage = async (cursor: string | null): Promise<void> => {
    const page = await db(
      async (tx) =>
        await tx
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
          .limit(ENTRY_PAGE_SIZE),
    );
    for (const row of page) {
      entries.push(row.payload);
    }
    const last = page.at(-1);
    if (page.length === ENTRY_PAGE_SIZE && last !== undefined) {
      await loadPage(last.sourceEntryId);
    }
  };
  await loadPage(null);
  // A ready edition is complete by construction; a short read means the
  // stored edition is not the one that was verified, so it is not used.
  return entries.length === edition.entryCount ? entries : null;
};

const loadIndex = async ({
  db,
  source,
  edition,
}: {
  db: ScopedDb;
  source: SanctionsSource;
  edition: SanctionsActiveEdition;
}): Promise<IndexResult> => {
  const loaded = await Result.tryPromise(
    async () => await loadEditionEntries(db, edition),
  );
  if (loaded.isErr() || loaded.value === null) {
    return Result.err({ code: "load-failed" });
  }
  return Result.ok(
    buildScreeningIndex([
      {
        version: {
          source,
          publishedAt: edition.publishedAt,
          fileId: edition.fileId,
        },
        entries: loaded.value,
      },
    ]),
  );
};

export type SanctionsIndexCache = {
  /** The index of one source's active edition, built once per edition. */
  get: (props: {
    db: ScopedDb;
    source: SanctionsSource;
    edition: SanctionsActiveEdition;
  }) => Promise<IndexResult>;
};

/**
 * One screening index per source, keyed by the active edition it was built
 * from. Editions are immutable, so an index stays valid until the source
 * activates another edition; the next screening then replaces it. A failed
 * load is not kept, so the following screening tries again.
 */
export const createSanctionsIndexCache = (): SanctionsIndexCache => {
  const bySource = new Map<
    SanctionsSource,
    { editionId: SanctionsActiveEdition["id"]; index: Promise<IndexResult> }
  >();
  return {
    get: async ({ db, source, edition }) => {
      const cached = bySource.get(source);
      if (cached !== undefined && cached.editionId === edition.id) {
        return await cached.index;
      }
      const index = loadIndex({ db, source, edition });
      bySource.set(source, { editionId: edition.id, index });
      const result = await index;
      if (result.isErr() && bySource.get(source)?.index === index) {
        bySource.delete(source);
      }
      return result;
    },
  };
};

/** Shared by every screening in this process: the in-product check and public search. */
export const sharedSanctionsIndexCache: SanctionsIndexCache =
  createSanctionsIndexCache();
