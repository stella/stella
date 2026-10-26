import { panic } from "better-result";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { PUBLIC_COUNTRIES } from "@stll/api-contract/public-country-capability";
import type { PublicCountry } from "@stll/api-contract/public-country-capability";
import {
  searchHistoryEntryMatch,
  searchHistoryPathJurisdiction,
} from "@stll/api-contract/search-history-identity";
import { parseStatutePath } from "@stll/api-contract/statute-route";
import { normalizeUnicode } from "@stll/text-normalize";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import {
  SEARCH_HISTORY_KINDS,
  searchHistoryEntries,
  searchHistoryJurisdictionClears,
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

/** One use to record: a typed query, or a decision or statute opened. */
export const searchHistoryJurisdictionSchema = v.pipe(
  v.picklist(PUBLIC_COUNTRIES),
  v.description(
    "A country code such as CZE or POL: the country whose law a search ran against, or whose page an opened document is on.",
  ),
);

const searchQuerySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(LIMITS.searchQueryMaxLength),
);

export const searchHistoryEntryInputSchema = v.union([
  v.strictObject({
    kind: v.literal("search"),
    query: searchQuerySchema,
    jurisdiction: searchHistoryJurisdictionSchema,
  }),
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
]);

type SearchHistoryEntryInput = v.InferOutput<
  typeof searchHistoryEntryInputSchema
>;

const uncountriedSearchEntrySchema = v.strictObject({
  kind: v.literal("search"),
  query: searchQuerySchema,
});

export type SearchHistoryEntry =
  | Exclude<SearchHistoryEntryInput, { kind: "search" }>
  | { kind: "search"; query: string; jurisdiction: PublicCountry | null };

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

/**
 * The entry as stored, its country, and the text its repeats are matched on.
 * A query is matched case- and spacing-insensitively within its country, so
 * "Náhrada  škody" and "náhrada škody" are one entry; an opened document is
 * matched on its identifier. `null` when the entry is not one the law pages
 * could have recorded.
 */
export const canonicalSearchHistoryEntry = (
  entry: SearchHistoryEntry,
): {
  entry: SearchHistoryEntry;
  jurisdiction: string | null;
  match: string;
} | null => {
  switch (entry.kind) {
    case "search": {
      const query = collapseWhitespace(entry.query);
      return query.length === 0
        ? null
        : {
            entry: { kind: "search", query, jurisdiction: entry.jurisdiction },
            jurisdiction: entry.jurisdiction,
            match: searchHistoryEntryMatch(entry),
          };
    }
    case "decision":
    case "statute": {
      const title = collapseWhitespace(entry.title);
      const documentId = entry.documentId.trim();
      const opensDocument =
        entry.kind === "decision"
          ? parseCaseLawDecisionPath(entry.path) !== null
          : parseStatutePath(entry.path) !== null;
      const jurisdiction = searchHistoryPathJurisdiction(entry.path);
      if (
        title.length === 0 ||
        documentId.length === 0 ||
        !opensDocument ||
        jurisdiction === null
      ) {
        return null;
      }
      return {
        entry: { ...entry, documentId, title },
        jurisdiction,
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
): SearchHistoryEntry | null => {
  if (v.is(searchHistoryEntryInputSchema, value)) {
    return value;
  }
  return v.is(uncountriedSearchEntrySchema, value)
    ? { ...value, jurisdiction: null }
    : null;
};

const payloadOf = (entry: SearchHistoryEntry) => {
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
  entry: SearchHistoryEntry;
  usedAt: Date;
};

type PreparedUse = {
  kind: SearchHistoryEntry["kind"];
  jurisdiction: string | null;
  lookupKey: string;
  /** A search's key from before history was kept per country, when it differs. */
  uncountriedLookupKey: string | null;
  /** Existing country-specific rows that make an imported legacy search redundant. */
  countryLookupKeys: readonly string[];
  entry: SearchHistoryEntry;
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
    const keyOf = async (material: string) =>
      await keyedContentLookupKey(organizationId, material).then((result) =>
        result.match({ ok: (value) => value, err: abortTransaction }),
      );
    const uncountriedLookupKey = await keyOf(
      `${use.entry.kind}\u0000${canonical.match}`,
    );
    // A search is one entry per country; a document's id fixes its country.
    const lookupKey =
      use.entry.kind === "search" && canonical.jurisdiction !== null
        ? await keyOf(
            `${use.entry.kind}\u0000${canonical.jurisdiction}\u0000${canonical.match}`,
          )
        : uncountriedLookupKey;
    const countryLookupKeys =
      use.entry.kind === "search" && canonical.jurisdiction === null
        ? await Promise.all(
            PUBLIC_COUNTRIES.map(
              async (country) =>
                await keyOf(
                  `${use.entry.kind}\u0000${country}\u0000${canonical.match}`,
                ),
            ),
          )
        : [];
    const mapKey = `${use.entry.kind}:${lookupKey}`;
    const previous = prepared.get(mapKey);
    if (previous === undefined) {
      prepared.set(mapKey, {
        kind: use.entry.kind,
        jurisdiction: canonical.jurisdiction,
        lookupKey,
        uncountriedLookupKey:
          lookupKey === uncountriedLookupKey ? null : uncountriedLookupKey,
        countryLookupKeys,
        entry: canonical.entry,
        firstUsedAt: use.usedAt,
        lastUsedAt: use.usedAt,
        useCount: 1,
      });
      continue;
    }
    const isLatest = use.usedAt >= previous.lastUsedAt;
    prepared.set(mapKey, {
      ...previous,
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
        courtId:
          use.entry.kind === "decision" ? (use.entry.courtId ?? null) : null,
        jurisdiction: use.jurisdiction,
        lookupKey: use.lookupKey,
        uncountriedLookupKey: use.uncountriedLookupKey,
        countryLookupKeys: use.countryLookupKeys,
        adoptedFirstUsedAt: null,
        adoptedLastUsedAt: null,
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

type SearchHistoryInsert = Awaited<
  ReturnType<typeof prepareSearchHistoryRows>
>[number];

/**
 * Records deleted identities so an import of an older use cannot restore
 * them. Only the newest tombstones are kept; retiring older ones moves the
 * owner's cutoff past them, so the barrier holds for every device. Called
 * under the owner lock.
 */
export const recordSearchHistoryTombstones = async (
  tx: Transaction,
  owner: SearchHistoryOwner,
  identities: readonly { kind: SearchHistoryKind; lookupKey: string }[],
) => {
  const unique = new Map(
    identities.map((identity) => [
      `${identity.kind}:${identity.lookupKey}`,
      identity,
    ]),
  );
  if (unique.size === 0) {
    return;
  }
  // audit: skip - callers audit the deletion in this transaction
  await tx
    .insert(searchHistoryTombstones)
    .values(
      [...unique.values()].map((identity) => ({
        organizationId: owner.organizationId,
        userId: owner.userId,
        kind: identity.kind,
        lookupKey: identity.lookupKey,
        deletedAt: sql`date_trunc('milliseconds', clock_timestamp())`,
      })),
    )
    .onConflictDoUpdate({
      target: [
        searchHistoryTombstones.organizationId,
        searchHistoryTombstones.userId,
        searchHistoryTombstones.kind,
        searchHistoryTombstones.lookupKey,
      ],
      set: {
        deletedAt: sql`GREATEST(${searchHistoryTombstones.deletedAt}, excluded.deleted_at)`,
      },
    });
  const retained = await tx
    .select({ deletedAt: searchHistoryTombstones.deletedAt })
    .from(searchHistoryTombstones)
    .where(
      and(
        eq(searchHistoryTombstones.organizationId, owner.organizationId),
        eq(searchHistoryTombstones.userId, owner.userId),
      ),
    )
    .orderBy(
      desc(searchHistoryTombstones.deletedAt),
      desc(searchHistoryTombstones.kind),
      desc(searchHistoryTombstones.lookupKey),
    )
    .offset(LIMITS.searchHistoryTombstonesMax)
    .limit(1);
  const oldestExcess = retained.at(0);
  if (oldestExcess === undefined) {
    return;
  }
  // Retiring an identity must retain its ordering barrier for other devices.
  // audit: skip - callers audit the deletion in this transaction
  await tx
    .update(searchHistoryOwners)
    .set({
      tombstoneCutoffAt: sql`GREATEST(${searchHistoryOwners.tombstoneCutoffAt}, ${oldestExcess.deletedAt}::timestamptz)`,
    })
    .where(
      and(
        eq(searchHistoryOwners.organizationId, owner.organizationId),
        eq(searchHistoryOwners.userId, owner.userId),
      ),
    );
  // audit: skip - compacting import barriers keeps no user-visible state
  await tx
    .delete(searchHistoryTombstones)
    .where(
      and(
        eq(searchHistoryTombstones.organizationId, owner.organizationId),
        eq(searchHistoryTombstones.userId, owner.userId),
        lte(
          searchHistoryTombstones.deletedAt,
          sql`${oldestExcess.deletedAt}::timestamptz`,
        ),
      ),
    );
};

/**
 * A search kept before history was per country becomes the entry of the
 * country it is next run in, so one query is never listed twice. Its uses
 * fold into that entry, and a tombstone stops an older import restoring it.
 */
const adoptUncountriedSearches = async (
  tx: Transaction,
  owner: SearchHistoryOwner,
  rows: readonly SearchHistoryInsert[],
) => {
  const keys = [
    ...new Set(
      rows.flatMap((row) =>
        row.uncountriedLookupKey === null ? [] : [row.uncountriedLookupKey],
      ),
    ),
  ];
  if (keys.length === 0) {
    return rows;
  }
  // audit: skip - folded into the recorded entry, which the write audits
  const adopted = await tx
    .delete(searchHistoryEntries)
    .where(
      and(
        eq(searchHistoryEntries.organizationId, owner.organizationId),
        eq(searchHistoryEntries.userId, owner.userId),
        eq(searchHistoryEntries.kind, "search"),
        isNull(searchHistoryEntries.jurisdiction),
        inArray(searchHistoryEntries.lookupKey, keys),
      ),
    )
    .returning({
      lookupKey: searchHistoryEntries.lookupKey,
      firstUsedAt: searchHistoryEntries.firstUsedAt,
      lastUsedAt: searchHistoryEntries.lastUsedAt,
      useCount: searchHistoryEntries.useCount,
    });
  if (adopted.length === 0) {
    return rows;
  }
  await recordSearchHistoryTombstones(
    tx,
    owner,
    adopted.map(({ lookupKey }) => ({ kind: "search", lookupKey })),
  );
  const unfolded = new Map(adopted.map((row) => [row.lookupKey, row]));
  return rows.map((row) => {
    const earlier =
      row.uncountriedLookupKey === null
        ? undefined
        : unfolded.get(row.uncountriedLookupKey);
    if (earlier === undefined) {
      return row;
    }
    unfolded.delete(earlier.lookupKey);
    return {
      ...row,
      adoptedFirstUsedAt: earlier.firstUsedAt,
      adoptedLastUsedAt: earlier.lastUsedAt,
      firstUsedAt:
        earlier.firstUsedAt < row.firstUsedAt
          ? earlier.firstUsedAt
          : row.firstUsedAt,
      lastUsedAt:
        earlier.lastUsedAt > row.lastUsedAt
          ? earlier.lastUsedAt
          : row.lastUsedAt,
      useCount: row.useCount + earlier.useCount,
    };
  });
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
} & (
  | { mode: "record"; timestampSource: "database" | "prepared" }
  | { mode: "import"; timestampSource: "prepared" }
);

type ReadImportBarriersOptions = {
  tx: Transaction;
  rows: readonly SearchHistoryInsert[];
  owner: SearchHistoryOwner;
  mode: "record" | "import";
};

const readImportBarriers = async ({
  tx,
  rows,
  owner,
  mode,
}: ReadImportBarriersOptions) => {
  const countries = [
    ...new Set(
      rows.flatMap((row) =>
        row.jurisdiction === null ? [] : [row.jurisdiction],
      ),
    ),
  ];
  const countryClears =
    mode === "import" && countries.length > 0
      ? await tx
          .select({
            jurisdiction: searchHistoryJurisdictionClears.jurisdiction,
            clearedAt: searchHistoryJurisdictionClears.clearedAt,
          })
          .from(searchHistoryJurisdictionClears)
          .where(
            and(
              eq(
                searchHistoryJurisdictionClears.organizationId,
                owner.organizationId,
              ),
              eq(searchHistoryJurisdictionClears.userId, owner.userId),
              inArray(searchHistoryJurisdictionClears.jurisdiction, countries),
            ),
          )
      : [];
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
                        .map((row) => row.lookupKey),
                    ),
                  ),
                ),
              ),
            ),
          )
      : [];
  return {
    countryClearByJurisdiction: new Map(
      countryClears.map(({ jurisdiction, clearedAt }) => [
        jurisdiction,
        clearedAt,
      ]),
    ),
    deletedAt: new Map(
      tombstones.map((row) => [`${row.kind}:${row.lookupKey}`, row.deletedAt]),
    ),
  };
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
  const { countryClearByJurisdiction, deletedAt } = await readImportBarriers({
    tx,
    rows,
    owner,
    mode,
  });
  const accepted = new Map<string, SearchHistoryInsert>();
  let skipped = 0;
  for (const row of rows) {
    const key = `${row.kind}:${row.lookupKey}`;
    const tombstone = deletedAt.get(key);
    const scopedClear =
      row.jurisdiction === null
        ? state.legacyClearedAt
        : (countryClearByJurisdiction.get(row.jurisdiction) ?? null);
    // Imported rows carry their conservative lower time bound. Uses whose
    // possible time overlaps a barrier are deliberately not restored.
    if (
      mode === "import" &&
      (row.lastUsedAt <= memberSince ||
        (state.clearedAt !== null && row.lastUsedAt <= state.clearedAt) ||
        (scopedClear !== null && row.lastUsedAt <= scopedClear) ||
        (state.tombstoneCutoffAt !== null &&
          row.lastUsedAt <= state.tombstoneCutoffAt) ||
        (tombstone !== undefined && row.lastUsedAt <= tombstone))
    ) {
      skipped += row.useCount;
      continue;
    }
    const previous = accepted.get(key);
    if (previous === undefined) {
      accepted.set(key, row);
      continue;
    }
    accepted.set(key, {
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
  if (mode === "import") {
    const legacyRows = [...accepted.values()].filter(
      (row) => row.kind === "search" && row.jurisdiction === null,
    );
    // The old row does not say which country the query ran in. Once any
    // countryful copy exists, keeping the old row would show a duplicate on
    // that country's page; preserve the countryful copy and skip the ambiguous
    // import, including when both copies arrive in this same batch.
    const possibleCountryKeys = [
      ...new Set(legacyRows.flatMap((row) => row.countryLookupKeys)),
    ];
    const matchingCountryRows =
      possibleCountryKeys.length === 0
        ? []
        : await tx
            .select({ lookupKey: searchHistoryEntries.lookupKey })
            .from(searchHistoryEntries)
            .where(
              and(
                eq(searchHistoryEntries.organizationId, owner.organizationId),
                eq(searchHistoryEntries.userId, owner.userId),
                eq(searchHistoryEntries.kind, "search"),
                inArray(searchHistoryEntries.lookupKey, possibleCountryKeys),
              ),
            );
    const claimedCountryKeys = new Set([
      ...matchingCountryRows.map(({ lookupKey }) => lookupKey),
      ...[...accepted.values()]
        .filter((row) => row.kind === "search" && row.jurisdiction !== null)
        .map((row) => row.lookupKey),
    ]);
    for (const row of legacyRows) {
      if (row.countryLookupKeys.some((key) => claimedCountryKeys.has(key))) {
        accepted.delete(`${row.kind}:${row.lookupKey}`);
        skipped += row.useCount;
      }
    }
  }
  const acceptedRows = await adoptUncountriedSearches(tx, owner, [
    ...accepted.values(),
  ]);
  const table = searchHistoryEntries;
  // A later use replaces the stored spelling; an older one (an import of
  // what a browser kept) merges its first use and preserves replay counts.
  const incomingIsLatest = sql`excluded.last_used_at::timestamptz >= ${table.lastUsedAt}`;
  const timestampFor = (jurisdiction: SearchHistoryInsert["jurisdiction"]) => {
    if (timestampSource === "prepared") {
      return null;
    }
    const cutoff =
      jurisdiction === null
        ? sql`(SELECT legacy_cleared_at FROM public.search_history_owners WHERE organization_id = ${owner.organizationId} AND user_id = ${owner.userId})`
        : sql`(SELECT cleared_at FROM public.search_history_jurisdiction_clears WHERE organization_id = ${owner.organizationId} AND user_id = ${owner.userId} AND jurisdiction = ${jurisdiction})`;
    // The SQL statement starts after the owner lock. A backward wall-clock
    // adjustment still cannot put a new use on the cleared side of its fence.
    return sql`GREATEST(statement_timestamp(), COALESCE(${cutoff}, '-infinity'::timestamptz) + interval '1 microsecond')`;
  };
  const written =
    acceptedRows.length === 0
      ? []
      : await tx
          .insert(table)
          .values(
            acceptedRows.map(
              ({
                uncountriedLookupKey: _adopted,
                countryLookupKeys: _countryKeys,
                adoptedFirstUsedAt,
                adoptedLastUsedAt,
                ...row
              }) => {
                const useAt = timestampFor(row.jurisdiction);
                return useAt === null
                  ? row
                  : {
                      ...row,
                      firstUsedAt:
                        adoptedFirstUsedAt === null
                          ? useAt
                          : sql`LEAST(${adoptedFirstUsedAt}, ${useAt})`,
                      lastUsedAt:
                        adoptedLastUsedAt === null
                          ? useAt
                          : sql`GREATEST(${adoptedLastUsedAt}, ${useAt})`,
                    };
              },
            ),
          )
          .onConflictDoUpdate({
            target: [
              table.organizationId,
              table.userId,
              table.kind,
              table.lookupKey,
            ],
            set: {
              courtId: sql`CASE WHEN ${incomingIsLatest} THEN excluded.court_id ELSE ${table.courtId} END`,
              // A document opened before history was per country gains one.
              jurisdiction: sql`COALESCE(excluded.jurisdiction, ${table.jurisdiction})`,
              ciphertext: sql`CASE WHEN ${incomingIsLatest} THEN excluded.ciphertext ELSE ${table.ciphertext} END`,
              iv: sql`CASE WHEN ${incomingIsLatest} THEN excluded.iv ELSE ${table.iv} END`,
              firstUsedAt: sql`LEAST(${table.firstUsedAt}, excluded.first_used_at)`,
              lastUsedAt: sql`GREATEST(${table.lastUsedAt}, excluded.last_used_at)`,
              useCount:
                mode === "record"
                  ? sql`${table.useCount} + excluded.use_count`
                  : sql`GREATEST(${table.useCount}, excluded.use_count)`,
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
  | "courtId"
  | "jurisdiction"
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
    firstUsedAt: row.firstUsedAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    useCount: row.useCount,
    jurisdiction: row.jurisdiction,
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
  "jurisdictionRepairFailedAt",
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
