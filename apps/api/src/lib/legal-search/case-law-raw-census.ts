import { asc, gt } from "drizzle-orm";

import { DAY_IN_MS, Temporal } from "@stll/time";
import { isUuid } from "@stll/uuid-codec";

import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enqueueCaseLawRawSweepsTx,
  RAW_PREFIX_STATE,
  readRawPrefixStates,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import type { RawPrefixState } from "@/api/lib/legal-search/case-law-raw-sweeps";
import { RAW_SOURCE_FAMILY } from "@/api/lib/legal-search/raw-source-storage";
import { listS3ObjectPage } from "@/api/lib/s3";
import type { S3ListedObject } from "@/api/lib/s3";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

/**
 * The object side of the raw-storage census: every per-decision prefix in
 * the bucket, against the row that owns it.
 *
 * A raw write happens before the row that names it, so a crash, a lost
 * insert or an erasure racing a write can leave objects no live row owns.
 * The paths that know of such a case record a sweep themselves; this walk
 * is what finds the ones nothing recorded. A prefix whose row is erased is
 * queued at once. A prefix with no row and no reservation is queued once
 * its newest object is older than any write in flight could be, so an
 * insert that has written its objects and not yet its row is never
 * mistaken for one that never will.
 *
 * The row side, rows whose payload or files are not stored, is walked by
 * `case-law-raw-layout.ts`.
 */

/**
 * How old an unowned prefix's newest object must be before it is swept:
 * far past the time between an insert's first raw write and its row.
 */
export const RAW_ORPHAN_GRACE_MS = DAY_IN_MS;

export const RAW_CENSUS_MODE = {
  /** Count and report; queue nothing. */
  PLAN: "plan",
  /** Also queue a sweep for every prefix nothing may keep. */
  APPLY: "apply",
} as const;

export type RawCensusMode =
  (typeof RAW_CENSUS_MODE)[keyof typeof RAW_CENSUS_MODE];

export type RawCensusCursor = {
  sourceId: SafeId<"caseLawSource">;
  /** The last key a page accounted for; null to start the source. */
  startAfter: string | null;
};

export type RawCensusCounts = Record<RawPrefixState, number> & {
  /** Unowned prefixes whose newest object is still inside the grace. */
  recent: number;
  /** Keys under the documents prefix that name no decision id. */
  unrecognized: number;
  /** Prefixes queued for a sweep. */
  queued: number;
};

export type RawCensusPageResult = {
  /** Where the next page starts; null once every source has been walked. */
  next: RawCensusCursor | null;
  counts: RawCensusCounts;
};

type RawCensusPageOptions = {
  scopedDb: ScopedDb;
  cursor: RawCensusCursor | null;
  maxKeys: number;
  mode: RawCensusMode;
  signal: AbortSignal;
};

const documentsPrefix = (sourceId: string): string =>
  `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/documents/`;

const sourceAfter = async (
  scopedDb: ScopedDb,
  sourceId: SafeId<"caseLawSource"> | null,
): Promise<SafeId<"caseLawSource"> | null> =>
  (
    await scopedDb(
      async (tx) =>
        await tx
          .select({ id: caseLawSources.id })
          .from(caseLawSources)
          .where(
            sourceId === null ? undefined : gt(caseLawSources.id, sourceId),
          )
          .orderBy(asc(caseLawSources.id))
          .limit(1),
    )
  ).at(0)?.id ?? null;

/**
 * One page of one source's per-decision prefixes. A page that ends inside a
 * decision's objects leaves that decision to the next page, so every
 * decision is judged on all of its objects at once; the one exception is a
 * decision with more objects than a page, which is judged page by page.
 */
export const censusCaseLawRawObjectsPage = async ({
  scopedDb,
  cursor,
  maxKeys,
  mode,
  signal,
}: RawCensusPageOptions): Promise<RawCensusPageResult> => {
  const counts: RawCensusCounts = {
    live: 0,
    reserved: 0,
    erased: 0,
    orphaned: 0,
    recent: 0,
    unrecognized: 0,
    queued: 0,
  };
  const sourceId = cursor?.sourceId ?? (await sourceAfter(scopedDb, null));
  if (sourceId === null) {
    return { next: null, counts };
  }
  const prefix = documentsPrefix(sourceId);
  const page = await listS3ObjectPage({
    prefix,
    startAfter: cursor?.startAfter ?? null,
    maxKeys,
    signal,
  });

  const decisionOf = (key: string): string =>
    key.slice(prefix.length).split("/").at(0) ?? "";
  const byDecision = new Map<string, S3ListedObject[]>();
  for (const object of page.objects) {
    const decisionId = decisionOf(object.key);
    if (!isUuid(decisionId)) {
      counts.unrecognized += 1;
      continue;
    }
    const held = byDecision.get(decisionId);
    if (held === undefined) {
      byDecision.set(decisionId, [object]);
    } else {
      held.push(object);
    }
  }
  const groups = [...byDecision.entries()];
  // A truncated page may have cut the last decision's objects short: leave
  // it to the next page, unless it is the only one on this page. Keys are
  // listed in order, so its objects are the page's tail.
  const deferred =
    page.truncated && groups.length > 1 ? groups.at(-1)?.[0] : undefined;
  const judged = deferred === undefined ? groups : groups.slice(0, -1);
  const firstDeferred =
    deferred === undefined
      ? -1
      : page.objects.findIndex(({ key }) => decisionOf(key) === deferred);
  const accounted =
    firstDeferred === -1 ? page.objects : page.objects.slice(0, firstDeferred);
  const resumeKey = accounted.at(-1)?.key ?? cursor?.startAfter ?? null;

  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const decisionIds = judged.map(([id]) => brandPersistedCaseLawDecisionId(id));
  await scopedDb(async (tx) => {
    const states = await readRawPrefixStates(tx, decisionIds);
    const owed: SafeId<"caseLawDecision">[] = [];
    for (const [id, objects] of judged) {
      const decisionId = brandPersistedCaseLawDecisionId(id);
      const state = states.get(decisionId) ?? RAW_PREFIX_STATE.ORPHANED;
      counts[state] += 1;
      const newestMs = Math.max(
        ...objects.map(({ lastModified }) => lastModified.getTime()),
      );
      const sweepable =
        state === RAW_PREFIX_STATE.ERASED ||
        (state === RAW_PREFIX_STATE.ORPHANED &&
          nowMs - newestMs >= RAW_ORPHAN_GRACE_MS);
      if (state === RAW_PREFIX_STATE.ORPHANED && !sweepable) {
        counts.recent += 1;
      }
      if (!sweepable || mode === RAW_CENSUS_MODE.PLAN) {
        continue;
      }
      owed.push(decisionId);
    }
    await enqueueCaseLawRawSweepsTx(
      tx,
      owed.map((decisionId) => ({
        decisionId,
        sourceId,
        firstAttemptAt: new Date(nowMs),
        settleAfter: new Date(nowMs),
      })),
    );
    counts.queued += owed.length;
  });

  if (page.truncated) {
    return {
      next: { sourceId, startAfter: resumeKey },
      counts,
    };
  }
  const following = await sourceAfter(scopedDb, sourceId);
  return {
    next: following === null ? null : { sourceId: following, startAfter: null },
    counts,
  };
};
