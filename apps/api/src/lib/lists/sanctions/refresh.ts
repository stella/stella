import { panic } from "better-result";
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import {
  checkListReplacement,
  type ListReplacementError,
  type ListStats,
  type ParsedList,
  type SanctionsSource,
} from "@stll/sanctions";
import { stableStringify } from "@stll/stable-stringify";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsEditions,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { SANCTIONS_SOURCE_CONFIG } from "@/api/lib/lists/sanctions/source-config";
import {
  fetchSanctionsEdition,
  fetchSanctionsMarker,
} from "@/api/lib/lists/sanctions/source-fetch";
import type {
  FetchedEdition,
  FetchedMarker,
} from "@/api/lib/lists/sanctions/source-fetch";

const ENTRY_BATCH_SIZE = 500;
const MAX_SOURCE_ENTRY_ID_LENGTH = 512;
// Bump this when the package parser or entry normalisation changes. It keeps
// an interrupted stage from mixing rows produced by two parser versions.
export const SANCTIONS_PARSER_VERSION = "1";

const REPLACEMENT_FAILURE_CODES = {
  "below-minimum": "replacement-below-minimum",
  contracted: "replacement-contracted",
  stale: "replacement-stale",
  "source-mismatch": "replacement-source-mismatch",
} as const satisfies Record<ListReplacementError["code"], string>;

type GuardFailureCode =
  (typeof REPLACEMENT_FAILURE_CODES)[keyof typeof REPLACEMENT_FAILURE_CODES];

type TransportFailureCode =
  | "access-denied"
  | "fetch-failed"
  | "metadata-invalid"
  | "parse-failed"
  | "unexpected-error";

export type SanctionsRefreshOutcome =
  | { status: "activated"; source: SanctionsSource; entryCount: number }
  | { status: "unchanged"; source: SanctionsSource }
  | { status: "held"; source: SanctionsSource; code: GuardFailureCode }
  | { status: "failed"; source: SanctionsSource; code: TransportFailureCode }
  | { status: "lost-race"; source: SanctionsSource }
  | { status: "aborted"; source: SanctionsSource };

type RefreshOptions = {
  db: ScopedDb;
  source: SanctionsSource;
  signal: AbortSignal;
  euXmlUrlOverride?: string | undefined;
  userAgent?: string | undefined;
  fetchMarker?: typeof fetchSanctionsMarker | undefined;
  fetchEdition?: typeof fetchSanctionsEdition | undefined;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * The change key of an edition. Some publishers state only the calendar date
 * of a list, so the HTTP validator of the list response joins the key when the
 * source has one; the stated version itself is stored unchanged. Without a
 * validator the key is the stated version alone, as it always was.
 */
const markerKeyOf = ({
  version,
  lastModified,
}: Pick<FetchedMarker, "version" | "lastModified">): string =>
  sha256(
    stableStringify(
      lastModified === null
        ? { parserVersion: SANCTIONS_PARSER_VERSION, version }
        : { parserVersion: SANCTIONS_PARSER_VERSION, version, lastModified },
    ),
  );

/**
 * Whether a download is the edition its marker named. A validator missing on
 * either response does not count against the match.
 */
const downloadMatchesMarker = (
  marker: FetchedMarker,
  edition: FetchedEdition,
): boolean =>
  stableStringify(edition.parsed.version) === stableStringify(marker.version) &&
  (marker.lastModified === null ||
    edition.lastModified === null ||
    marker.lastModified === edition.lastModified);

const markFailure = async ({
  code,
  db,
  expectedActiveId,
  source,
}: {
  code: TransportFailureCode;
  db: ScopedDb;
  expectedActiveId: SafeId<"sanctionsEdition"> | null;
  source: SanctionsSource;
}): Promise<boolean> =>
  await db(async (tx) => {
    const [current] = await tx
      .select({ activeEditionId: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, source))
      .limit(1)
      .for("update");
    if (!current) {
      return panic("Sanctions source vanished during refresh");
    }
    if (current.activeEditionId !== expectedActiveId) {
      return false;
    }
    const now = new Date();
    await tx
      .update(sanctionsSources)
      .set({
        lastCheckedAt: now,
        lastFailureAt: now,
        lastFailureCode: code,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return true;
  });

export const recordUnexpectedSanctionsFailure = async ({
  db,
  source,
  startedAt,
}: {
  db: ScopedDb;
  source: SanctionsSource;
  startedAt: Date;
}): Promise<void> => {
  const config = SANCTIONS_SOURCE_CONFIG[source];
  await db(async (tx) => {
    await tx
      .insert(sanctionsSources)
      .values({
        id: source,
        issuer: config.issuer,
        markerUrl: config.markerUrl,
      })
      .onConflictDoNothing();
    const now = new Date();
    await tx
      .update(sanctionsSources)
      .set({
        lastCheckedAt: now,
        lastFailureAt: now,
        lastFailureCode: "unexpected-error",
        updatedAt: now,
      })
      .where(
        and(
          eq(sanctionsSources.id, source),
          or(
            isNull(sanctionsSources.lastSuccessfulVerifiedAt),
            lte(
              sanctionsSources.lastSuccessfulVerifiedAt,
              sql`${startedAt}::timestamptz`,
            ),
          ),
        ),
      );
  });
};

const markVerifiedUnchanged = async ({
  db,
  expectedActiveId,
  source,
}: {
  db: ScopedDb;
  expectedActiveId: SafeId<"sanctionsEdition">;
  source: SanctionsSource;
}): Promise<boolean> =>
  await db(async (tx) => {
    const [current] = await tx
      .select({ activeEditionId: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, source))
      .limit(1)
      .for("update");
    if (!current) {
      return panic("Sanctions source vanished during verification");
    }
    if (current.activeEditionId !== expectedActiveId) {
      return false;
    }
    const now = new Date();
    await tx
      .update(sanctionsSources)
      .set({
        lastCheckedAt: now,
        lastSuccessfulVerifiedAt: now,
        lastFailureAt: null,
        lastFailureCode: null,
        heldEditionId: null,
        heldGuardCode: null,
        heldAt: null,
        heldPreviousCount: null,
        heldNextCount: null,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return true;
  });

type RecordRejectedArgs = {
  db: ScopedDb;
  source: SanctionsSource;
  snapshotActiveId: SafeId<"sanctionsEdition"> | null;
  markerKey: string;
  parsed: ParsedList;
  contentHash: string;
  previous: ListStats | null;
  guardCode: ListReplacementError["code"];
};

const recordRejectedReplacement = async ({
  db,
  source,
  snapshotActiveId,
  markerKey,
  parsed,
  contentHash,
  previous,
  guardCode,
}: RecordRejectedArgs): Promise<SanctionsRefreshOutcome> => {
  const code = REPLACEMENT_FAILURE_CODES[guardCode];
  const recorded = await db(async (tx) => {
    const [current] = await tx
      .select({ activeEditionId: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, source))
      .limit(1)
      .for("update");
    if (!current) {
      return panic("Sanctions source vanished during replacement check");
    }
    if (current.activeEditionId !== snapshotActiveId) {
      return false;
    }
    const [inserted] = await tx
      .insert(sanctionsEditions)
      .values({
        sourceId: source,
        markerKey,
        publishedAt: parsed.version.publishedAt,
        fileId: parsed.version.fileId,
        contentHash,
        entryCount: parsed.entries.length,
        state: "rejected",
        guardCode,
        previousEntryCount: previous?.entryCount ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: sanctionsEditions.id, state: sanctionsEditions.state });
    const [edition] = inserted
      ? [inserted]
      : await tx
          .select({ id: sanctionsEditions.id, state: sanctionsEditions.state })
          .from(sanctionsEditions)
          .where(
            and(
              eq(sanctionsEditions.sourceId, source),
              eq(sanctionsEditions.markerKey, markerKey),
              eq(sanctionsEditions.contentHash, contentHash),
            ),
          )
          .limit(1);
    if (!edition) {
      return panic("Rejected sanctions edition was not visible");
    }
    if (edition.state === "staging") {
      await tx
        .update(sanctionsEditions)
        .set({
          state: "rejected",
          guardCode,
          previousEntryCount: previous?.entryCount ?? null,
        })
        .where(eq(sanctionsEditions.id, edition.id));
    }
    // A publisher rollback can identify an edition that was ready before a
    // newer one replaced it. Keep that historical ready edition intact.
    const now = new Date();
    await tx
      .update(sanctionsSources)
      .set({
        lastCheckedAt: now,
        lastFailureAt: null,
        lastFailureCode: null,
        heldEditionId: edition.id,
        heldGuardCode: guardCode,
        heldAt: now,
        heldPreviousCount: previous?.entryCount ?? null,
        heldNextCount: parsed.entries.length,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return true;
  });
  return recorded
    ? { status: "held", source, code }
    : { status: "lost-race", source };
};

type ActivateStagedArgs = {
  db: ScopedDb;
  source: SanctionsSource;
  snapshotActiveId: SafeId<"sanctionsEdition"> | null;
  editionId: SafeId<"sanctionsEdition">;
  expectedEntries: readonly { sourceEntryId: string; contentHash: string }[];
  previousEntryCount: number | null;
  entryCount: number;
};

const activateStagedEdition = async ({
  db,
  source,
  snapshotActiveId,
  editionId,
  expectedEntries,
  previousEntryCount,
  entryCount,
}: ActivateStagedArgs): Promise<SanctionsRefreshOutcome> => {
  const activated = await db(async (tx) => {
    const [current] = await tx
      .select({ activeEditionId: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, source))
      .limit(1)
      .for("update");
    if (!current) {
      return panic("Sanctions source vanished during activation");
    }
    if (current.activeEditionId !== snapshotActiveId) {
      await tx
        .update(sanctionsEditions)
        .set({
          state: "rejected",
          guardCode: "superseded",
          previousEntryCount,
        })
        .where(
          and(
            eq(sanctionsEditions.id, editionId),
            eq(sanctionsEditions.state, "staging"),
          ),
        );
      return "lost-race" as const;
    }
    const [lockedEdition] = await tx
      .select({ state: sanctionsEditions.state })
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.id, editionId))
      .limit(1)
      .for("update");
    if (lockedEdition?.state !== "staging") {
      return "lost-race" as const;
    }
    const storedEntries = await tx
      .select({
        sourceEntryId: sanctionsEditionEntries.sourceEntryId,
        contentHash: sanctionsEditionEntries.contentHash,
      })
      .from(sanctionsEditionEntries)
      .where(eq(sanctionsEditionEntries.editionId, editionId))
      .limit(expectedEntries.length + 1);
    const expectedById = new Map(
      expectedEntries.map((entry) => [entry.sourceEntryId, entry.contentHash]),
    );
    const matches =
      storedEntries.length === expectedEntries.length &&
      storedEntries.every(
        (stored) =>
          expectedById.get(stored.sourceEntryId) === stored.contentHash,
      );
    if (!matches) {
      const now = new Date();
      await tx
        .update(sanctionsEditions)
        .set({
          state: "rejected",
          guardCode: "invalid-stage",
          previousEntryCount,
        })
        .where(eq(sanctionsEditions.id, editionId));
      await tx
        .update(sanctionsSources)
        .set({
          lastCheckedAt: now,
          lastFailureAt: now,
          lastFailureCode: "parse-failed",
          updatedAt: now,
        })
        .where(eq(sanctionsSources.id, source));
      return "invalid-stage" as const;
    }
    const now = new Date();
    await tx
      .update(sanctionsEditions)
      .set({ state: "ready", activatedAt: now })
      .where(eq(sanctionsEditions.id, editionId));
    await tx
      .update(sanctionsEditions)
      .set({
        state: "rejected",
        guardCode: "superseded",
        previousEntryCount,
      })
      .where(
        and(
          eq(sanctionsEditions.sourceId, source),
          eq(sanctionsEditions.state, "staging"),
          ne(sanctionsEditions.id, editionId),
        ),
      );
    await tx
      .update(sanctionsSources)
      .set({
        activeEditionId: editionId,
        lastCheckedAt: now,
        lastSuccessfulVerifiedAt: now,
        lastFailureAt: null,
        lastFailureCode: null,
        heldEditionId: null,
        heldGuardCode: null,
        heldAt: null,
        heldPreviousCount: null,
        heldNextCount: null,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return "activated" as const;
  });
  switch (activated) {
    case "activated":
      return { status: "activated", source, entryCount };
    case "lost-race":
      return { status: "lost-race", source };
    case "invalid-stage":
      return { status: "failed", source, code: "parse-failed" };
    default: {
      activated satisfies never;
      return panic("Unknown activation outcome");
    }
  }
};

type StageAcceptedArgs = {
  db: ScopedDb;
  source: SanctionsSource;
  signal: AbortSignal;
  snapshotActiveId: SafeId<"sanctionsEdition"> | null;
  markerKey: string;
  parsed: ParsedList;
  contentHash: string;
  previous: ListStats | null;
};

const stageAcceptedEdition = async ({
  db,
  source,
  signal,
  snapshotActiveId,
  markerKey,
  parsed,
  contentHash,
  previous,
}: StageAcceptedArgs): Promise<SanctionsRefreshOutcome> => {
  const [inserted] = await db(
    async (tx) =>
      await tx
        .insert(sanctionsEditions)
        .values({
          sourceId: source,
          markerKey,
          publishedAt: parsed.version.publishedAt,
          fileId: parsed.version.fileId,
          contentHash,
          entryCount: parsed.entries.length,
          state: "staging",
        })
        .onConflictDoNothing()
        .returning({
          id: sanctionsEditions.id,
          state: sanctionsEditions.state,
          guardCode: sanctionsEditions.guardCode,
        }),
  );
  const [edition] = inserted
    ? [inserted]
    : await db(
        async (tx) =>
          await tx
            .select({
              id: sanctionsEditions.id,
              state: sanctionsEditions.state,
              guardCode: sanctionsEditions.guardCode,
            })
            .from(sanctionsEditions)
            .where(
              and(
                eq(sanctionsEditions.sourceId, source),
                eq(sanctionsEditions.markerKey, markerKey),
                eq(sanctionsEditions.contentHash, contentHash),
              ),
            )
            .limit(1),
      );
  if (!edition) {
    return panic("Sanctions edition insert was not visible");
  }
  if (edition.state === "rejected") {
    if (edition.guardCode === null) {
      return panic("Rejected sanctions edition has no guard code");
    }
    switch (edition.guardCode) {
      case "below-minimum":
      case "contracted":
      case "stale":
      case "source-mismatch":
        return {
          status: "held",
          source,
          code: REPLACEMENT_FAILURE_CODES[edition.guardCode],
        };
      case "invalid-stage":
        return { status: "failed", source, code: "parse-failed" };
      case "superseded":
        return { status: "lost-race", source };
      default:
        edition.guardCode satisfies never;
        return panic("Unknown rejected edition reason");
    }
  }

  const expectedEntries = parsed.entries
    .map((entry) => ({
      sourceEntryId: entry.sourceId,
      contentHash: sha256(stableStringify(entry)),
      payload: entry,
    }))
    .toSorted((left, right) => {
      if (left.sourceEntryId < right.sourceEntryId) {
        return -1;
      }
      if (left.sourceEntryId > right.sourceEntryId) {
        return 1;
      }
      return 0;
    });

  const itemBatches = chunkItems(expectedEntries, ENTRY_BATCH_SIZE)[
    Symbol.iterator
  ]();
  const persistNextBatch = async (): Promise<void> => {
    const nextBatch = itemBatches.next();
    if (nextBatch.done) {
      return;
    }
    if (signal.aborted) {
      return;
    }
    const batch = nextBatch.value;
    await db(async (tx) => {
      await tx
        .insert(sanctionsEntryPayloads)
        .values(
          batch.map(({ contentHash: entryHash, payload }) => ({
            contentHash: entryHash,
            payload,
          })),
        )
        .onConflictDoNothing();
      await tx
        .insert(sanctionsEditionEntries)
        .values(
          batch.map(({ sourceEntryId, contentHash: entryHash }) => ({
            editionId: edition.id,
            sourceEntryId,
            contentHash: entryHash,
          })),
        )
        .onConflictDoNothing();
    });
    await persistNextBatch();
  };
  await persistNextBatch();
  if (signal.aborted) {
    return { status: "aborted", source };
  }

  return await activateStagedEdition({
    db,
    source,
    snapshotActiveId,
    editionId: edition.id,
    expectedEntries,
    previousEntryCount: previous?.entryCount ?? null,
    entryCount: parsed.entries.length,
  });
};

type CurrentEditionResult =
  | { status: "ready"; markerKey: string; edition: FetchedEdition }
  | { status: "unchanged" }
  | { status: "aborted" }
  | {
      status: "failed";
      code: Exclude<TransportFailureCode, "unexpected-error">;
    };

type FetchCurrentOptions = {
  source: SanctionsSource;
  activeMarkerKey: string | null;
  hasActiveEdition: boolean;
  fetchOptions: Parameters<typeof fetchSanctionsMarker>[1];
  fetchMarker: typeof fetchSanctionsMarker;
  fetchEdition: typeof fetchSanctionsEdition;
};

const validParsedEntries = (
  source: SanctionsSource,
  parsed: ParsedList,
): boolean =>
  parsed.entries.every(
    (entry) =>
      entry.source === source &&
      entry.sourceId.length > 0 &&
      entry.sourceId.length <= MAX_SOURCE_ENTRY_ID_LENGTH,
  ) &&
  new Set(parsed.entries.map((entry) => entry.sourceId)).size ===
    parsed.entries.length;

const fetchCurrentEdition = async ({
  source,
  activeMarkerKey,
  hasActiveEdition,
  fetchOptions,
  fetchMarker,
  fetchEdition,
}: FetchCurrentOptions): Promise<CurrentEditionResult> => {
  const isAborted = () => fetchOptions.signal.aborted;
  const firstMarker = await fetchMarker(source, fetchOptions);
  if (isAborted()) {
    return { status: "aborted" };
  }
  if (firstMarker.isErr()) {
    return { status: "failed", code: firstMarker.error.code };
  }
  if (
    firstMarker.value.source !== source ||
    firstMarker.value.version.source !== source
  ) {
    return { status: "failed", code: "metadata-invalid" };
  }

  let marker: FetchedMarker = firstMarker.value;
  let markerKey = markerKeyOf(marker);
  if (hasActiveEdition && activeMarkerKey === markerKey) {
    return { status: "unchanged" };
  }

  let edition = await fetchEdition(marker, fetchOptions);
  if (isAborted()) {
    return { status: "aborted" };
  }
  if (edition.isErr()) {
    return { status: "failed", code: edition.error.code };
  }

  if (!downloadMatchesMarker(marker, edition.value)) {
    const nextMarker = await fetchMarker(source, fetchOptions);
    if (isAborted()) {
      return { status: "aborted" };
    }
    if (nextMarker.isErr()) {
      return { status: "failed", code: nextMarker.error.code };
    }
    if (
      nextMarker.value.source !== source ||
      nextMarker.value.version.source !== source
    ) {
      return { status: "failed", code: "metadata-invalid" };
    }
    if (markerKeyOf(nextMarker.value) === markerKey) {
      return { status: "failed", code: "parse-failed" };
    }
    marker = nextMarker.value;
    markerKey = markerKeyOf(marker);
    if (hasActiveEdition && activeMarkerKey === markerKey) {
      return { status: "unchanged" };
    }
    edition = await fetchEdition(marker, fetchOptions);
    if (isAborted()) {
      return { status: "aborted" };
    }
    if (edition.isErr()) {
      return { status: "failed", code: edition.error.code };
    }
  }

  if (
    !downloadMatchesMarker(marker, edition.value) ||
    !validParsedEntries(source, edition.value.parsed)
  ) {
    return { status: "failed", code: "parse-failed" };
  }
  return { status: "ready", markerKey, edition: edition.value };
};

export const refreshSanctionsSource = async ({
  db,
  source,
  signal,
  euXmlUrlOverride,
  userAgent,
  fetchMarker = fetchSanctionsMarker,
  fetchEdition = fetchSanctionsEdition,
}: RefreshOptions): Promise<SanctionsRefreshOutcome> => {
  if (signal.aborted) {
    return { status: "aborted", source };
  }

  const config = SANCTIONS_SOURCE_CONFIG[source];
  await db(
    async (tx) =>
      await tx
        .insert(sanctionsSources)
        .values({
          id: source,
          issuer: config.issuer,
          markerUrl: config.markerUrl,
        })
        .onConflictDoUpdate({
          target: sanctionsSources.id,
          set: {
            issuer: config.issuer,
            markerUrl: config.markerUrl,
            updatedAt: new Date(),
          },
        }),
  );

  const [snapshot] = await db(
    async (tx) =>
      await tx
        .select({
          activeEditionId: sanctionsSources.activeEditionId,
          editionId: sanctionsEditions.id,
          markerKey: sanctionsEditions.markerKey,
          publishedAt: sanctionsEditions.publishedAt,
          entryCount: sanctionsEditions.entryCount,
        })
        .from(sanctionsSources)
        .leftJoin(
          sanctionsEditions,
          eq(sanctionsSources.activeEditionId, sanctionsEditions.id),
        )
        .where(eq(sanctionsSources.id, source))
        .limit(1),
  );
  if (!snapshot) {
    return panic("Sanctions source insert was not visible");
  }
  if (snapshot.activeEditionId !== snapshot.editionId) {
    return panic("Sanctions active edition reference is broken");
  }

  const current = await fetchCurrentEdition({
    source,
    activeMarkerKey: snapshot.markerKey,
    hasActiveEdition: snapshot.activeEditionId !== null,
    fetchOptions: { signal, euXmlUrlOverride, userAgent },
    fetchMarker,
    fetchEdition,
  });
  switch (current.status) {
    case "aborted":
      return { status: "aborted", source };
    case "failed": {
      const recorded = await markFailure({
        db,
        source,
        expectedActiveId: snapshot.activeEditionId,
        code: current.code,
      });
      return recorded
        ? { status: "failed", source, code: current.code }
        : { status: "lost-race", source };
    }
    case "unchanged": {
      if (snapshot.activeEditionId === null) {
        return panic(
          "Sanctions edition cannot be unchanged without an active edition",
        );
      }
      const recorded = await markVerifiedUnchanged({
        db,
        source,
        expectedActiveId: snapshot.activeEditionId,
      });
      return recorded
        ? { status: "unchanged", source }
        : { status: "lost-race", source };
    }
    case "ready":
      break;
    default:
      current satisfies never;
      return panic("Unknown sanctions download outcome");
  }
  const { parsed, contentHash } = current.edition;
  const markerKey = current.markerKey;

  let previous: {
    source: SanctionsSource;
    publishedAt: string;
    entryCount: number;
  } | null = null;
  if (snapshot.activeEditionId !== null) {
    if (snapshot.publishedAt === null || snapshot.entryCount === null) {
      return panic("Sanctions active edition statistics are missing");
    }
    previous = {
      source,
      publishedAt: snapshot.publishedAt,
      entryCount: snapshot.entryCount,
    };
  }
  const replacement = checkListReplacement({ previous, next: parsed });
  if (replacement.isErr()) {
    return await recordRejectedReplacement({
      db,
      source,
      snapshotActiveId: snapshot.activeEditionId,
      markerKey,
      parsed,
      contentHash,
      previous,
      guardCode: replacement.error.code,
    });
  }

  return await stageAcceptedEdition({
    db,
    source,
    signal,
    snapshotActiveId: snapshot.activeEditionId,
    markerKey,
    parsed,
    contentHash,
    previous,
  });
};
