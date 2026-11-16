import { panic } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import {
  CASE_LAW_JURISDICTIONS,
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";
import { searchHistoryEntryMatch } from "@stll/api-contract/search-history-identity";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { sha256Hex } from "@stll/sha256/bun";
import { normalizeUnicode } from "@stll/text-normalize";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import {
  SEARCH_HISTORY_KINDS,
  searchHistoryCountryClears,
  searchHistoryEntries,
  type SearchHistoryKind,
  searchHistoryOwners,
  searchHistoryTombstones,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decryptContent,
  encryptContent,
  keyedContentLookupKey,
} from "@/api/lib/content-encryption";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

const documentIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LIMITS.searchHistoryTitleMaxLength),
  v.description(
    "The opened document's public identifier: a decision id or a statute ELI.",
  ),
);
const titleSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LIMITS.searchHistoryTitleMaxLength),
);
const pathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LIMITS.searchHistoryPathMaxLength),
  v.regex(/^\/law\/[A-Za-z0-9_/-]+$/u),
  v.description("The public law page the entry reopens."),
);

const unknownDocumentIdentitySchema = v.strictObject({
  kind: v.literal("unknown"),
});
const decisionDocumentIdentitySchema = v.strictObject({
  kind: v.literal("decision"),
  courtAbbreviation: v.nullable(
    v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  ),
  courtTier: v.optional(
    v.enum(
      Object.fromEntries(
        COURT_TIER_LABELS.map((tier) => [tier, tier] as const),
      ),
    ),
  ),
});
const statuteDocumentIdentitySchema = v.strictObject({
  kind: v.literal("statute"),
  number: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(32))),
  year: v.nullable(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(4),
      v.regex(/^[0-9]{1,4}$/u),
    ),
  ),
});

// Enum derives its choices without assigning a default to an omitted filter.
export const searchHistoryCountrySchema = v.pipe(
  v.enum(
    Object.fromEntries(
      CASE_LAW_JURISDICTIONS.map((country) => [country, country] as const),
    ),
  ),
  v.description(
    "The jurisdiction the law pages were scoped to, as its corpus code (CZE, POL, EU).",
  ),
);

const searchQuerySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LIMITS.searchQueryMaxLength),
);

const openedEntrySchemas = [
  v.strictObject({
    kind: v.literal("decision"),
    courtId: v.optional(
      v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
    ),
    documentIdentity: v.optional(
      v.union([decisionDocumentIdentitySchema, unknownDocumentIdentitySchema]),
    ),
    documentId: documentIdSchema,
    title: titleSchema,
    path: pathSchema,
  }),
  v.strictObject({
    kind: v.literal("statute"),
    documentIdentity: v.optional(
      v.union([statuteDocumentIdentitySchema, unknownDocumentIdentitySchema]),
    ),
    documentId: documentIdSchema,
    title: titleSchema,
    path: pathSchema,
  }),
] as const;

/**
 * One use to record: a query typed under a jurisdiction, or a decision or
 * statute opened. An opened document's jurisdiction is the one its path names.
 */
export const searchHistoryEntryInputSchema = v.union([
  v.strictObject({
    kind: v.literal("search"),
    query: searchQuerySchema,
    country: searchHistoryCountrySchema,
  }),
  ...openedEntrySchemas,
]);

/**
 * What an import reads. A browser kept its searches before they named a
 * jurisdiction, so an imported query may lack one; it is stored without it
 * and no country-scoped list shows it.
 */
const searchHistoryImportEntrySchema = v.union([
  v.strictObject({
    kind: v.literal("search"),
    query: searchQuerySchema,
    country: v.optional(searchHistoryCountrySchema),
  }),
  ...openedEntrySchemas,
]);

export type SearchHistoryEntryInput = v.InferOutput<
  typeof searchHistoryImportEntrySchema
>;

// Enum derives its choices without assigning a default to an omitted filter.
export const searchHistoryKindSchema = v.enum(
  Object.fromEntries(SEARCH_HISTORY_KINDS.map((kind) => [kind, kind] as const)),
);

/** What the row stores encrypted: the entry without its kind. */
const searchPayloadSchema = v.object({ query: v.string() });
const openedPayloadSchema = v.object({
  documentId: v.string(),
  title: v.string(),
  path: v.string(),
});

const unknownDocumentIdentityPayloadSchema = v.object({
  kind: v.literal("unknown"),
});
const decisionPayloadSchema = v.object({
  ...openedPayloadSchema.entries,
  documentIdentity: v.variant("kind", [
    v.object({
      kind: v.literal("decision"),
      courtAbbreviation: v.nullable(v.string()),
      courtTier: v.optional(v.picklist(COURT_TIER_LABELS)),
    }),
    unknownDocumentIdentityPayloadSchema,
  ]),
});
const statutePayloadSchema = v.object({
  ...openedPayloadSchema.entries,
  documentIdentity: v.variant("kind", [
    v.object({
      kind: v.literal("statute"),
      number: v.nullable(v.string()),
      year: v.nullable(v.string()),
    }),
    unknownDocumentIdentityPayloadSchema,
  ]),
});

const collapseWhitespace = (value: string) =>
  normalizeUnicode(value, "NFC").trim().replaceAll(/\s+/gu, " ");

/** The jurisdiction a law page path names, when it names a declared one. */
const pathCountry = (segment: string): CaseLawJurisdiction | null => {
  const code = segment.toUpperCase();
  return isCaseLawJurisdiction(code) ? code : null;
};

/**
 * The entry as stored, the jurisdiction it was recorded under, and the text
 * its repeats are matched on. A query is matched case- and
 * spacing-insensitively, so "Náhrada  škody" and "náhrada škody" are one
 * entry; an opened document is matched on its identifier. The jurisdiction
 * is not part of the match: it files the entry, and a deletion recorded under
 * the match holds whichever jurisdiction a later import names. `null` when
 * the entry is not one the law pages could have recorded.
 */
export const canonicalSearchHistoryEntry = (
  entry: SearchHistoryEntryInput,
): {
  entry: SearchHistoryEntryInput;
  country: CaseLawJurisdiction | null;
  match: string;
} | null => {
  switch (entry.kind) {
    case "search": {
      const query = collapseWhitespace(entry.query);
      if (query.length === 0) {
        return null;
      }
      return {
        entry: { kind: "search", query },
        // An imported query from before jurisdictions has none.
        country: entry.country ?? null,
        match: searchHistoryEntryMatch(entry),
      };
    }
    case "decision":
    case "statute": {
      const title = collapseWhitespace(entry.title);
      const documentId = entry.documentId.trim();
      const route =
        entry.kind === "decision"
          ? parseCaseLawDecisionPath(entry.path)
          : parseStatutePath(entry.path);
      const country = route === null ? null : pathCountry(route.country);
      if (title.length === 0 || documentId.length === 0 || country === null) {
        return null;
      }
      return {
        entry: { ...entry, documentId, title },
        country,
        match: searchHistoryEntryMatch(entry),
      };
    }
    default: {
      entry satisfies never;
      return panic("Unhandled search history kind");
    }
  }
};

/** Reads an untrusted value as an entry, or `null` (import is best effort). */
export const readSearchHistoryEntryInput = (
  value: unknown,
): SearchHistoryEntryInput | null =>
  v.is(searchHistoryImportEntrySchema, value) ? value : null;

const payloadOf = (entry: SearchHistoryEntryInput) => {
  switch (entry.kind) {
    case "search":
      return { query: entry.query };
    case "decision":
      return {
        documentId: entry.documentId,
        title: entry.title,
        path: entry.path,
        documentIdentity: entry.documentIdentity ?? { kind: "unknown" },
      };
    case "statute":
      return {
        documentId: entry.documentId,
        title: entry.title,
        path: entry.path,
        documentIdentity: entry.documentIdentity ?? { kind: "unknown" },
      };
    default:
      entry satisfies never;
      return panic("Unhandled search history payload kind");
  }
};

type SearchHistoryOwner = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export type SearchHistoryUse = {
  entry: SearchHistoryEntryInput;
  usedAt: Date;
};

type PreparedUse = {
  kind: SearchHistoryEntryInput["kind"];
  country: CaseLawJurisdiction | null;
  /** When the latest use that named a jurisdiction happened. */
  countryUsedAt: Date | null;
  lookupKey: string;
  entry: SearchHistoryEntryInput;
  firstUsedAt: Date;
  lastUsedAt: Date;
  useCount: number;
};

/**
 * Folds uses of one entry into one row per lookup key, keeping the spelling
 * of the latest use. One insert may not touch a row twice, so repeats inside
 * a batch merge here before they reach the database.
 */
const prepareUses = async (
  organizationId: SafeId<"organization">,
  uses: readonly SearchHistoryUse[],
): Promise<PreparedUse[]> => {
  const prepared = new Map<string, PreparedUse>();
  for (const use of uses) {
    const canonical = canonicalSearchHistoryEntry(use.entry);
    if (canonical === null) {
      continue;
    }
    const lookupKey = await keyedContentLookupKey(
      organizationId,
      `${use.entry.kind}\u0000${canonical.match}`,
    ).then((result) =>
      result.match({ ok: (value) => value, err: abortTransaction }),
    );
    const mapKey = `${use.entry.kind}:${lookupKey}`;
    const previous = prepared.get(mapKey);
    if (previous === undefined) {
      prepared.set(mapKey, {
        kind: use.entry.kind,
        country: canonical.country,
        countryUsedAt: canonical.country === null ? null : use.usedAt,
        lookupKey,
        entry: canonical.entry,
        firstUsedAt: use.usedAt,
        lastUsedAt: use.usedAt,
        useCount: 1,
      });
      continue;
    }
    const isLatest = use.usedAt >= previous.lastUsedAt;
    // The latest use that names a jurisdiction files the entry, whatever
    // order the uses arrive in; a use without one never unfiles it.
    const refiles =
      canonical.country !== null &&
      (previous.countryUsedAt === null || use.usedAt >= previous.countryUsedAt);
    prepared.set(mapKey, {
      kind: previous.kind,
      country: refiles ? canonical.country : previous.country,
      countryUsedAt: refiles ? use.usedAt : previous.countryUsedAt,
      lookupKey,
      entry: isLatest ? canonical.entry : previous.entry,
      firstUsedAt:
        use.usedAt < previous.firstUsedAt ? use.usedAt : previous.firstUsedAt,
      lastUsedAt: isLatest ? use.usedAt : previous.lastUsedAt,
      useCount: previous.useCount + 1,
    });
  }
  return [...prepared.values()].toSorted((left, right) => {
    if (left.lookupKey === right.lookupKey) {
      return 0;
    }
    return left.lookupKey < right.lookupKey ? -1 : 1;
  });
};

/**
 * The rows that record `uses` for one owner, encrypted and keyed. Built
 * before the transaction opens, so it holds no lock while hashing.
 */
export const prepareSearchHistoryRows = async (
  owner: SearchHistoryOwner,
  uses: readonly SearchHistoryUse[],
) => {
  const prepared = await prepareUses(owner.organizationId, uses);
  return await Promise.all(
    prepared.map(async (use) => {
      const { ciphertext, iv } = await encryptContent(
        owner.organizationId,
        JSON.stringify(payloadOf(use.entry)),
      );
      return {
        organizationId: owner.organizationId,
        userId: owner.userId,
        kind: use.kind,
        country: use.country,
        countryUsedAt: use.countryUsedAt,
        courtId:
          use.entry.kind === "decision" ? (use.entry.courtId ?? null) : null,
        lookupKey: use.lookupKey,
        baseLookupKey: use.kind === "search" ? use.lookupKey : null,
        ciphertext,
        iv,
        firstUsedAt: use.firstUsedAt,
        lastUsedAt: use.lastUsedAt,
        useCount: use.useCount,
      };
    }),
  );
};

/** Keep import uses separate until the deletion cutoffs have been applied. */
export const prepareSearchHistoryImportRows = async (
  owner: SearchHistoryOwner,
  uses: readonly SearchHistoryUse[],
) =>
  (
    await Promise.all(
      uses.map(async (use) => prepareSearchHistoryRows(owner, [use])),
    )
  ).flat();

/** Membership locks precede the owner mutex for every history write. */
export const holdSearchHistoryOwnerAccess = async (
  tx: Transaction,
  owner: SearchHistoryOwner,
) => {
  const membership = await withAggregateRowQuery({
    tx,
    aggregate: "desktopMembership",
    id: owner,
    mode: "share",
    select: (lockedTx) =>
      lockedTx
        .select({
          organizationId: member.organizationId,
          userId: member.userId,
          createdAt: member.createdAt,
        })
        .from(member),
  });
  const currentMember = membership.rows.at(0);
  if (currentMember === undefined) {
    abortTransaction(
      new HandlerError({
        status: 403,
        message: "Organization membership is required to write search history.",
      }),
    );
  }
  return currentMember.createdAt;
};

/** Called after creating the owner row under its membership lock. */
export const lockSearchHistoryOwner = async (
  tx: Transaction,
  owner: SearchHistoryOwner,
) => {
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "searchHistory",
    id: owner,
    mode: "update",
    select: (lockedTx) =>
      lockedTx
        .select({
          organizationId: searchHistoryOwners.organizationId,
          userId: searchHistoryOwners.userId,
          clearedAt: searchHistoryOwners.clearedAt,
          legacyClearedAt: searchHistoryOwners.legacyClearedAt,
          tombstoneCutoffAt: searchHistoryOwners.tombstoneCutoffAt,
        })
        .from(searchHistoryOwners),
  });
  const state = locked.rows.at(0);
  if (state === undefined) {
    panic("Search history owner mutex was not created");
  }
  return state;
};

type SearchHistoryReadIdentity = Pick<
  SearchHistoryEntryRow,
  | "organizationId"
  | "userId"
  | "kind"
  | "country"
  | "baseLookupKey"
  | "lookupKey"
>;

type SearchHistoryReadIdentityOperand = {
  [Key in keyof SearchHistoryReadIdentity]:
    SearchHistoryReadIdentity[Key] | SQLWrapper;
};

type SearchHistoryReadIdentityOptions = {
  entry: SearchHistoryReadIdentityOperand;
  identity: SearchHistoryReadIdentityOperand;
};

/** Base and scoped representations share an identity only within the same country. */
export const searchHistoryReadIdentityPredicate = ({
  entry,
  identity,
}: SearchHistoryReadIdentityOptions) => sql`
  ${entry.organizationId} = ${identity.organizationId}
  AND ${entry.userId} = ${identity.userId}
  AND ${entry.kind} = ${identity.kind}
  AND ${entry.country} IS NOT DISTINCT FROM ${identity.country}
  AND COALESCE(${entry.baseLookupKey}, ${entry.lookupKey}) = COALESCE(${identity.baseLookupKey}, ${identity.lookupKey})
`;

const COUNTRY_IDENTITY_DOMAIN = "search-history-country:v1";

/** Scoped read identities derive from the same opaque base kept by all writers. */
const countryReadLookupKey = (
  country: CaseLawJurisdiction,
  baseLookupKey: string,
) =>
  sha256Hex(`${COUNTRY_IDENTITY_DOMAIN}\u0000${country}\u0000${baseLookupKey}`);

type SearchHistoryInsert = Awaited<
  ReturnType<typeof prepareSearchHistoryRows>
>[number];

/** Split country aggregates before selecting the one row the expand index stores. */
const aggregateCountryUses = (rows: readonly SearchHistoryInsert[]) => {
  const byCountry = new Map<string, SearchHistoryInsert>();
  for (const row of rows) {
    const key = `${row.kind}:${row.lookupKey}:${row.country ?? "legacy"}`;
    const previous = byCountry.get(key);
    if (previous === undefined) {
      byCountry.set(key, row);
      continue;
    }
    byCountry.set(key, {
      ...(row.lastUsedAt >= previous.lastUsedAt ? row : previous),
      firstUsedAt:
        row.firstUsedAt < previous.firstUsedAt
          ? row.firstUsedAt
          : previous.firstUsedAt,
      lastUsedAt:
        row.lastUsedAt > previous.lastUsedAt
          ? row.lastUsedAt
          : previous.lastUsedAt,
      useCount: row.useCount + previous.useCount,
    });
  }
  const latestByBaseKey = new Map<string, SearchHistoryInsert>();
  for (const row of byCountry.values()) {
    const key = `${row.kind}:${row.lookupKey}`;
    const previous = latestByBaseKey.get(key);
    if (
      previous === undefined ||
      (row.countryUsedAt !== null &&
        (previous.countryUsedAt === null ||
          row.countryUsedAt >= previous.countryUsedAt)) ||
      (row.countryUsedAt === null &&
        previous.countryUsedAt === null &&
        row.lastUsedAt >= previous.lastUsedAt)
    ) {
      latestByBaseKey.set(key, row);
    }
  }
  return [...latestByBaseKey.values()];
};

/**
 * Writes prepared rows. A use of an entry the owner already has bumps that
 * row (latest use, count, and the latest spelling) instead of adding one.
 * Returns the id of each distinct entry written.
 */
type UpsertSearchHistoryRowsOptions = {
  tx: Transaction;
  rows: readonly SearchHistoryInsert[];
  recordAuditEvent: AuditRecorder;
  mode: "record" | "import";
  timestampSource: "database" | "prepared";
};

export const upsertSearchHistoryRows = async ({
  tx,
  rows,
  mode,
  timestampSource,
  recordAuditEvent,
}: UpsertSearchHistoryRowsOptions) => {
  if (rows.length === 0) {
    return { entries: [], skipped: 0 };
  }
  const owner = rows.at(0);
  if (
    !owner ||
    rows.some(
      (row) =>
        row.organizationId !== owner.organizationId ||
        row.userId !== owner.userId,
    )
  ) {
    return panic("Search history batch must have one owner");
  }
  const memberSince = await holdSearchHistoryOwnerAccess(tx, owner);
  await tx
    .insert(searchHistoryOwners)
    .values({ organizationId: owner.organizationId, userId: owner.userId })
    .onConflictDoNothing();
  const state = await lockSearchHistoryOwner(tx, owner);
  const countryClears =
    mode === "import"
      ? await tx
          .select({
            country: searchHistoryCountryClears.country,
            clearedAt: searchHistoryCountryClears.clearedAt,
          })
          .from(searchHistoryCountryClears)
          .where(
            and(
              eq(
                searchHistoryCountryClears.organizationId,
                owner.organizationId,
              ),
              eq(searchHistoryCountryClears.userId, owner.userId),
            ),
          )
      : [];
  const clearedByCountry = new Map(
    countryClears.map((row) => [row.country, row.clearedAt]),
  );
  const tombstones =
    mode === "import"
      ? await tx
          .select({
            kind: searchHistoryTombstones.kind,
            lookupKey: searchHistoryTombstones.lookupKey,
            deletedAt: searchHistoryTombstones.deletedAt,
          })
          .from(searchHistoryTombstones)
          .where(
            and(
              eq(searchHistoryTombstones.organizationId, owner.organizationId),
              eq(searchHistoryTombstones.userId, owner.userId),
              or(
                ...SEARCH_HISTORY_KINDS.map((kind) =>
                  and(
                    eq(searchHistoryTombstones.kind, kind),
                    inArray(
                      searchHistoryTombstones.lookupKey,
                      rows
                        .filter((row) => row.kind === kind)
                        .flatMap((row) =>
                          row.kind === "search" && row.country !== null
                            ? [
                                row.lookupKey,
                                countryReadLookupKey(
                                  row.country,
                                  row.lookupKey,
                                ),
                              ]
                            : [row.lookupKey],
                        ),
                    ),
                  ),
                ),
              ),
            ),
          )
      : [];
  const deletedAt = new Map(
    tombstones.map((row) => [`${row.kind}:${row.lookupKey}`, row.deletedAt]),
  );
  const accepted: SearchHistoryInsert[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = `${row.kind}:${row.lookupKey}`;
    const tombstone = deletedAt.get(key);
    const scopedTombstone =
      row.kind === "search" && row.country !== null
        ? deletedAt.get(
            `${row.kind}:${countryReadLookupKey(row.country, row.lookupKey)}`,
          )
        : undefined;
    const scopedClear =
      row.country === null
        ? state.legacyClearedAt
        : clearedByCountry.get(row.country);
    // Imported rows carry their conservative lower time bound. Uses whose
    // possible time overlaps a barrier are deliberately not restored.
    if (
      mode === "import" &&
      (row.lastUsedAt <= memberSince ||
        (scopedClear !== undefined &&
          scopedClear !== null &&
          row.lastUsedAt <= scopedClear) ||
        (state.clearedAt !== null && row.lastUsedAt <= state.clearedAt) ||
        (state.tombstoneCutoffAt !== null &&
          row.lastUsedAt <= state.tombstoneCutoffAt) ||
        (tombstone !== undefined && row.lastUsedAt <= tombstone) ||
        (scopedTombstone !== undefined && row.lastUsedAt <= scopedTombstone))
    ) {
      skipped += row.useCount;
      continue;
    }
    accepted.push(row);
  }
  const acceptedRows = aggregateCountryUses(accepted);
  const table = searchHistoryEntries;
  // A later use replaces the stored spelling; an older one (an import of
  // what a browser kept) merges its first use and preserves replay counts.
  const incomingIsLatest = sql`excluded.last_used_at::timestamptz >= ${table.lastUsedAt}`;
  const incomingCountryIsLatest = sql`excluded.country_used_at IS NOT NULL AND (${table.countryUsedAt} IS NULL OR excluded.country_used_at::timestamptz >= ${table.countryUsedAt})`;
  const differentKnownCountry = sql`${table.country} IS NOT NULL AND excluded.country IS NOT NULL AND ${table.country} IS DISTINCT FROM excluded.country`;
  const keepCountryAggregates = sql`(${differentKnownCountry}) AND NOT (${incomingCountryIsLatest})`;
  const incomingCountryCutoff = sql`(SELECT cleared_at FROM public.search_history_country_clears WHERE organization_id = ${table.organizationId} AND user_id = ${table.userId} AND country = excluded.country)`;
  const restartCountryAggregates = sql`(${incomingCountryIsLatest}) AND ((${differentKnownCountry}) OR ${table.firstUsedAt} <= ${incomingCountryCutoff})`;
  const written =
    acceptedRows.length === 0
      ? []
      : await tx
          .insert(table)
          .values(
            acceptedRows.map((row) => {
              if (timestampSource === "prepared") {
                return row;
              }
              const cutoff =
                row.country === null
                  ? sql`(SELECT legacy_cleared_at FROM public.search_history_owners WHERE organization_id = ${owner.organizationId} AND user_id = ${owner.userId})`
                  : sql`(SELECT cleared_at FROM public.search_history_country_clears WHERE organization_id = ${owner.organizationId} AND user_id = ${owner.userId} AND country = ${row.country})`;
              const usedAt = sql`GREATEST(statement_timestamp(), COALESCE(${cutoff}, '-infinity'::timestamptz) + interval '1 microsecond')`;
              return {
                ...row,
                firstUsedAt: usedAt,
                lastUsedAt: usedAt,
                countryUsedAt: row.country === null ? null : usedAt,
              };
            }),
          )
          .onConflictDoUpdate({
            target: [
              table.organizationId,
              table.userId,
              table.kind,
              table.lookupKey,
            ],
            set: {
              baseLookupKey: sql`COALESCE(${table.baseLookupKey}, excluded.base_lookup_key)`,
              // Each side carries the time of its latest jurisdiction-naming
              // use; the later one files the entry.
              country: sql`CASE WHEN ${incomingCountryIsLatest} THEN excluded.country ELSE ${table.country} END`,
              countryUsedAt: sql`GREATEST(${table.countryUsedAt}, excluded.country_used_at)`,
              courtId: sql`CASE WHEN ${incomingIsLatest} THEN excluded.court_id ELSE ${table.courtId} END`,
              ciphertext: sql`CASE WHEN ${incomingIsLatest} THEN excluded.ciphertext ELSE ${table.ciphertext} END`,
              iv: sql`CASE WHEN ${incomingIsLatest} THEN excluded.iv ELSE ${table.iv} END`,
              firstUsedAt: sql`CASE WHEN ${keepCountryAggregates} THEN ${table.firstUsedAt} WHEN ${restartCountryAggregates} THEN excluded.first_used_at ELSE LEAST(${table.firstUsedAt}, excluded.first_used_at) END`,
              lastUsedAt: sql`CASE WHEN ${keepCountryAggregates} THEN ${table.lastUsedAt} WHEN ${restartCountryAggregates} THEN excluded.last_used_at ELSE GREATEST(${table.lastUsedAt}, excluded.last_used_at) END`,
              useCount: sql`CASE WHEN ${keepCountryAggregates} THEN ${table.useCount} WHEN ${restartCountryAggregates} THEN excluded.use_count ELSE ${
                mode === "record"
                  ? sql`${table.useCount} + excluded.use_count`
                  : sql`GREATEST(${table.useCount}, excluded.use_count)`
              } END`,
            },
          })
          .returning({ id: table.id });
  await recordAuditEvent(
    tx,
    searchHistoryAuditEvent({
      resourceId: owner.userId,
      operation: mode,
      entryCount: written.length,
      kinds: SEARCH_HISTORY_KINDS.filter((kind) =>
        acceptedRows.some((row) => row.kind === kind),
      ),
    }),
  );
  return { entries: written, skipped };
};

type SearchHistoryRow = Pick<
  SearchHistoryEntryRow,
  | "id"
  | "kind"
  | "country"
  | "courtId"
  | "ciphertext"
  | "iv"
  | "firstUsedAt"
  | "lastUsedAt"
  | "useCount"
>;

const SEARCH_HISTORY_PAYLOAD_SCHEMAS = {
  search: searchPayloadSchema,
  decision: decisionPayloadSchema,
  statute: statutePayloadSchema,
} as const satisfies Record<SearchHistoryKind, v.GenericSchema>;

/** The entry a row holds, decrypted, as the list returns it. */
export const toSearchHistoryEntryResponse = async (
  organizationId: SafeId<"organization">,
  row: SearchHistoryRow,
) => {
  const payload: unknown = JSON.parse(
    await decryptContent(organizationId, row.ciphertext, row.iv),
  );
  const usage = {
    id: row.id,
    country: row.country,
    firstUsedAt: row.firstUsedAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    useCount: row.useCount,
  };
  switch (row.kind) {
    case "search":
      return {
        ...usage,
        kind: row.kind,
        ...v.parse(searchPayloadSchema, payload),
      };
    case "decision":
      return {
        ...usage,
        kind: row.kind,
        courtId: row.courtId,
        ...v.parse(decisionPayloadSchema, payload),
      };
    case "statute":
      return {
        ...usage,
        kind: row.kind,
        ...v.parse(statutePayloadSchema, payload),
      };
    default: {
      row.kind satisfies never;
      return panic("Unhandled search history kind");
    }
  }
};

type SearchHistoryEntryRow = typeof searchHistoryEntries.$inferSelect;

// Columns intentionally not sent to the client.
const UNPROJECTED_SEARCH_HISTORY_COLUMNS = [
  // The list is the caller's own history in their active organization.
  "organizationId",
  "userId",
  // A keyed hash for matching repeats; meaningless outside the database.
  "lookupKey",
  // Orders refiling between uses; the entry's `country` is what it decides.
  "countryUsedAt",
  "baseLookupKey",
  "countryRepairFailedAt",
  // Sent decrypted, as the entry's own fields (query, or document, title
  // and path).
  "ciphertext",
  "iv",
] as const satisfies readonly (keyof SearchHistoryEntryRow)[];

type SearchHistoryEntryResponse = Awaited<
  ReturnType<typeof toSearchHistoryEntryResponse>
>;

// Bind each encrypted payload to its own response branch; their document
// identities are mutually exclusive, so they cannot form one intersection.
type SearchHistoryProjectionSource<Kind extends SearchHistoryKind> =
  SearchHistoryEntryRow &
    v.InferOutput<(typeof SEARCH_HISTORY_PAYLOAD_SCHEMAS)[Kind]>;

// Court identity is meaningful only on a decision, never a query or statute.
type UnprojectedSearchHistoryColumns<Kind extends SearchHistoryKind> =
  | (typeof UNPROJECTED_SEARCH_HISTORY_COLUMNS)[number]
  | (Kind extends "decision" ? never : "courtId");

type MissingProjectedSearchHistoryColumn = {
  [Kind in SearchHistoryKind]: UnprojectedColumns<
    SearchHistoryProjectionSource<Kind>,
    Extract<SearchHistoryEntryResponse, { kind: Kind }>,
    UnprojectedSearchHistoryColumns<Kind>
  >;
}[SearchHistoryKind];
type UnexpectedProjectedSearchHistoryColumn = {
  [Kind in SearchHistoryKind]: UnbackedProjectionKeys<
    SearchHistoryProjectionSource<Kind>,
    Extract<SearchHistoryEntryResponse, { kind: Kind }>,
    UnprojectedSearchHistoryColumns<Kind>
  >;
}[SearchHistoryKind];

true satisfies MissingProjectedSearchHistoryColumn extends never ? true : never;
true satisfies UnexpectedProjectedSearchHistoryColumn extends never
  ? true
  : never;
