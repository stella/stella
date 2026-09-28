import { panic } from "better-result";
import { and, asc, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

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
  sanctionsEntries,
  sanctionsSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { SANCTIONS_SOURCE_CONFIG } from "@/api/lib/sanctions/source-config";
import {
  fetchSanctionsEdition,
  fetchSanctionsMarker,
} from "@/api/lib/sanctions/source-fetch";

const ENTRY_BATCH_SIZE = 500;
const MAX_SOURCE_ENTRY_ID_LENGTH = 512;

const REPLACEMENT_FAILURE_CODES = {
  "below-minimum": "replacement-below-minimum",
  contracted: "replacement-contracted",
  stale: "replacement-stale",
  "source-mismatch": "replacement-source-mismatch",
} as const satisfies Record<ListReplacementError["code"], string>;

type RefreshFailureCode =
  | "access-denied"
  | "fetch-failed"
  | "metadata-invalid"
  | "parse-failed"
  | (typeof REPLACEMENT_FAILURE_CODES)[keyof typeof REPLACEMENT_FAILURE_CODES];

export type SanctionsRefreshOutcome =
  | { status: "activated"; source: SanctionsSource; entryCount: number }
  | { status: "unchanged"; source: SanctionsSource }
  | { status: "held"; source: SanctionsSource; code: RefreshFailureCode }
  | { status: "failed"; source: SanctionsSource; code: RefreshFailureCode }
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

const markFailure = async ({
  code,
  db,
  expectedActiveId,
  nextCount,
  previousCount,
  source,
}: {
  code: RefreshFailureCode;
  db: ScopedDb;
  expectedActiveId: SafeId<"sanctionsEdition"> | null;
  nextCount?: number | undefined;
  previousCount?: number | undefined;
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
        lastFailurePreviousCount: previousCount ?? null,
        lastFailureNextCount: nextCount ?? null,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return true;
  });

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
        lastFailurePreviousCount: null,
        lastFailureNextCount: null,
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
    await tx
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
      .onConflictDoNothing();
    const now = new Date();
    await tx
      .update(sanctionsSources)
      .set({
        lastCheckedAt: now,
        lastFailureAt: now,
        lastFailureCode: code,
        lastFailurePreviousCount: previous?.entryCount ?? null,
        lastFailureNextCount: parsed.entries.length,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return true;
  });
  return recorded
    ? { status: "held", source, code }
    : { status: "lost-race", source };
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
    const code = REPLACEMENT_FAILURE_CODES[edition.guardCode];
    const recorded = await markFailure({
      db,
      source,
      expectedActiveId: snapshotActiveId,
      code,
      previousCount: previous?.entryCount,
      nextCount: parsed.entries.length,
    });
    return recorded
      ? { status: "held", source, code }
      : { status: "lost-race", source };
  }

  const expectedEntries = parsed.entries
    .map((entry) => ({
      sourceEntryId: entry.sourceId,
      contentHash: sha256(stableStringify(entry)),
      payload: entry,
    }))
    .toSorted((left, right) => {
      if (left.sourceEntryId < right.sourceEntryId) {return -1;}
      if (left.sourceEntryId > right.sourceEntryId) {return 1;}
      return 0;
    });

  for (
    let start = 0;
    start < expectedEntries.length;
    start += ENTRY_BATCH_SIZE
  ) {
    if (signal.aborted) {
      return { status: "aborted", source };
    }
    const batch = expectedEntries
      .slice(start, start + ENTRY_BATCH_SIZE)
      .map((entry) => ({
        editionId: edition.id,
        sourceEntryId: entry.sourceEntryId,
        contentHash: entry.contentHash,
        payload: entry.payload,
      }));
    // db-await-in-loop: each bounded batch persists before the next; retry fills the same edition by stable source-entry id.
    await db(
      async (tx) =>
        await tx.insert(sanctionsEntries).values(batch).onConflictDoNothing(),
    );
  }

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
      return "lost-race" as const;
    }
    const [lockedEdition] = await tx
      .select({ state: sanctionsEditions.state })
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.id, edition.id))
      .limit(1)
      .for("update");
    if (lockedEdition?.state !== "staging") {
      return "lost-race" as const;
    }
    const storedEntries = await tx
      .select({
        sourceEntryId: sanctionsEntries.sourceEntryId,
        contentHash: sanctionsEntries.contentHash,
      })
      .from(sanctionsEntries)
      .where(eq(sanctionsEntries.editionId, edition.id))
      .orderBy(asc(sanctionsEntries.sourceEntryId))
      .limit(expectedEntries.length + 1);
    const matches =
      storedEntries.length === expectedEntries.length &&
      storedEntries.every(
        (stored, index) =>
          stored.sourceEntryId === expectedEntries[index]?.sourceEntryId &&
          stored.contentHash === expectedEntries[index]?.contentHash,
      );
    if (!matches) {
      const now = new Date();
      await tx
        .update(sanctionsSources)
        .set({
          lastCheckedAt: now,
          lastFailureAt: now,
          lastFailureCode: "parse-failed",
          lastFailurePreviousCount: previous?.entryCount ?? null,
          lastFailureNextCount: storedEntries.length,
          updatedAt: now,
        })
        .where(eq(sanctionsSources.id, source));
      return "invalid-stage" as const;
    }
    const now = new Date();
    await tx
      .update(sanctionsEditions)
      .set({ state: "ready", activatedAt: now })
      .where(eq(sanctionsEditions.id, edition.id));
    await tx
      .update(sanctionsSources)
      .set({
        activeEditionId: edition.id,
        lastCheckedAt: now,
        lastSuccessfulVerifiedAt: now,
        lastFailureAt: null,
        lastFailureCode: null,
        lastFailurePreviousCount: null,
        lastFailureNextCount: null,
        updatedAt: now,
      })
      .where(eq(sanctionsSources.id, source));
    return "activated" as const;
  });
  switch (activated) {
    case "activated":
      return { status: "activated", source, entryCount: parsed.entries.length };
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

  const fetchOptions = { signal, euXmlUrlOverride, userAgent };
  const marker = await fetchMarker(source, fetchOptions);
  if (signal.aborted) {
    return { status: "aborted", source };
  }
  if (marker.isErr()) {
    const recorded = await markFailure({
      db,
      source,
      expectedActiveId: snapshot.activeEditionId,
      code: marker.error.code,
    });
    return recorded
      ? { status: "failed", source, code: marker.error.code }
      : { status: "lost-race", source };
  }
  if (
    marker.value.source !== source ||
    marker.value.version.source !== source
  ) {
    const recorded = await markFailure({
      db,
      source,
      expectedActiveId: snapshot.activeEditionId,
      code: "metadata-invalid",
    });
    return recorded
      ? { status: "failed", source, code: "metadata-invalid" }
      : { status: "lost-race", source };
  }

  const markerKey = sha256(stableStringify(marker.value.version));
  if (snapshot.markerKey === markerKey && snapshot.activeEditionId !== null) {
    const recorded = await markVerifiedUnchanged({
      db,
      source,
      expectedActiveId: snapshot.activeEditionId,
    });
    return recorded
      ? { status: "unchanged", source }
      : { status: "lost-race", source };
  }

  const downloaded = await fetchEdition(marker.value, fetchOptions);
  if (signal.aborted) {
    return { status: "aborted", source };
  }
  if (downloaded.isErr()) {
    const recorded = await markFailure({
      db,
      source,
      expectedActiveId: snapshot.activeEditionId,
      code: downloaded.error.code,
    });
    return recorded
      ? { status: "failed", source, code: downloaded.error.code }
      : { status: "lost-race", source };
  }

  const { parsed, contentHash } = downloaded.value;
  if (
    stableStringify(parsed.version) !== stableStringify(marker.value.version) ||
    parsed.entries.some(
      (entry) =>
        entry.source !== source ||
        entry.sourceId.length === 0 ||
        entry.sourceId.length > MAX_SOURCE_ENTRY_ID_LENGTH,
    ) ||
    new Set(parsed.entries.map((entry) => entry.sourceId)).size !==
      parsed.entries.length
  ) {
    const recorded = await markFailure({
      db,
      source,
      expectedActiveId: snapshot.activeEditionId,
      code: "parse-failed",
    });
    return recorded
      ? { status: "failed", source, code: "parse-failed" }
      : { status: "lost-race", source };
  }

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
