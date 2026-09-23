import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  RAW_LAYOUT_MODE,
  RAW_LAYOUT_ROW_OUTCOME,
  reconcileCaseLawRawLayoutPage,
} from "@/api/lib/legal-search/case-law-raw-layout";
import type { RawLayoutPageResult } from "@/api/lib/legal-search/case-law-raw-layout";
import { sourceHasLiveLegacyReferences } from "@/api/lib/legal-search/case-law-raw-sweeps";
import {
  deleteRawKeys,
  isLegacyCaseLawRawKey,
  legacyCaseLawRawPrefix,
} from "@/api/lib/legal-search/raw-source-storage";
import { listS3ObjectPage } from "@/api/lib/s3";

/**
 * Deletes one source's objects in the older, source-wide raw layout, once a
 * census proves no live decision names any of them.
 *
 * Those objects are addressed by content, so one of them may be named by
 * any decision of the source, through its pointer or through a file its
 * payload names. The proof is therefore about the whole source and is read,
 * not assumed: no live pointer outside its own prefix, and every live
 * payload read back and found to name only files in its own prefix. Only
 * then is every key of the older layout under the source deleted. The
 * pointers are checked once more afterwards, so a writer that re-used the
 * older layout while this ran is reported rather than silently broken.
 *
 * Nothing live may still be writing the older layout while this runs: every
 * writer of it must have been replaced first.
 */

export const LEGACY_RAW_SWEEP_MODE = {
  /** Prove, count, delete nothing. */
  PLAN: "plan",
  APPLY: "apply",
} as const;

type LegacyRawSweepMode =
  (typeof LEGACY_RAW_SWEEP_MODE)[keyof typeof LEGACY_RAW_SWEEP_MODE];

type CensusCounts = RawLayoutPageResult["counts"];

export type LegacyRawSweepResult =
  | {
      type: "refused";
      /**
       * `pointer`: a live row still points outside its own prefix.
       * `payload`: a live payload names a file outside its own prefix, or
       * could not be read.
       */
      reason: "pointer" | "payload";
      census: CensusCounts | null;
    }
  | {
      type: "swept";
      mode: LegacyRawSweepMode;
      census: CensusCounts;
      legacyObjects: number;
      /** A live pointer outside its own prefix appeared while this ran. */
      referencedAfter: boolean;
    };

type SweepLegacyRawSourceOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  mode: LegacyRawSweepMode;
  signal: AbortSignal;
  /** Rows one census page reads. */
  pageLimit?: number;
};

const LIST_PAGE_KEYS = 1000;

const emptyCounts = (): CensusCounts => ({
  current: 0,
  migrated: 0,
  overtaken: 0,
  unmovable: 0,
  dangling: 0,
  retry: 0,
  copies: 0,
});

/** Every live payload of the source, read for the files it names. */
const censusSource = async ({
  scopedDb,
  sourceId,
  pageLimit,
  signal,
}: {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  pageLimit: number;
  signal: AbortSignal;
}): Promise<CensusCounts> => {
  const counts = emptyCounts();
  const walk = async (
    cursor: SafeId<"caseLawDecision"> | null,
  ): Promise<CensusCounts> => {
    const page = await reconcileCaseLawRawLayoutPage({
      scopedDb,
      cursor,
      limit: pageLimit,
      mode: RAW_LAYOUT_MODE.PLAN,
      sourceId,
      readEveryPayload: true,
      signal,
    });
    for (const outcome of Object.values(RAW_LAYOUT_ROW_OUTCOME)) {
      counts[outcome] += page.counts[outcome];
    }
    counts.copies += page.counts.copies;
    if (page.counts.retry > 0 || page.resumeAfter === null) {
      return counts;
    }
    return await walk(page.resumeAfter);
  };
  return await walk(null);
};

export const sweepCaseLawLegacyRawSource = async ({
  scopedDb,
  sourceId,
  mode,
  signal,
  pageLimit = 500,
}: SweepLegacyRawSourceOptions): Promise<LegacyRawSweepResult> => {
  const pointed = async (): Promise<boolean> =>
    await scopedDb(
      async (tx) => await sourceHasLiveLegacyReferences(tx, { sourceId }),
    );
  if (await pointed()) {
    return { type: "refused", reason: "pointer", census: null };
  }
  const census = await censusSource({
    scopedDb,
    sourceId,
    pageLimit,
    signal,
  });
  // A row the census would still move, could not move, or could not read
  // may name a legacy object; only rows proven to name their own objects
  // (stored or not) let the sweep go ahead.
  if (census.migrated > 0 || census.unmovable > 0 || census.retry > 0) {
    return { type: "refused", reason: "payload", census };
  }

  const prefix = legacyCaseLawRawPrefix(sourceId);
  const sweep = async (
    startAfter: string | null,
    swept: number,
  ): Promise<number> => {
    signal.throwIfAborted();
    const page = await listS3ObjectPage({
      prefix,
      startAfter,
      delimiter: "/",
      maxKeys: LIST_PAGE_KEYS,
      signal,
    });
    const legacy = page.objects
      .map(({ key }) => key)
      .filter((key) => isLegacyCaseLawRawKey(key, sourceId));
    if (mode === LEGACY_RAW_SWEEP_MODE.APPLY) {
      await deleteRawKeys(legacy, signal);
    }
    const last = page.objects.at(-1)?.key;
    return page.truncated && last !== undefined
      ? await sweep(last, swept + legacy.length)
      : swept + legacy.length;
  };
  const legacyObjects = await sweep(null, 0);
  return {
    type: "swept",
    mode,
    census,
    legacyObjects,
    referencedAfter: await pointed(),
  };
};
