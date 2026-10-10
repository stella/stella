import type { Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { panic } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { COURT_TIER_LABELS } from "@stll/api-contract/case-law-court-tiers";
import { parseCaseLawDecisionPath } from "@stll/api-contract/case-law-decision-route";
import { searchHistoryEntryMatch } from "@stll/api-contract/search-history-identity";
import { parseStatutePath } from "@stll/api-contract/statute-route";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import {
  searchHistoryEntries,
  searchHistoryOwners,
  searchHistoryTombstones,
  SEARCH_HISTORY_KINDS,
  type SearchHistoryKind,
} from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { searchHistoryAuditEvent } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  keyedContentLookupKey,
  decryptContent,
  encryptContent,
} from "@/api/lib/content-encryption";
import { withAggregateRowQuery } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

import { importUseCutoffLowerBound } from "./import-used-at";

const documentIdSchema = t.String({
  minLength: 1,
  maxLength: LIMITS.searchHistoryTitleMaxLength,
  description:
    "The opened document's public identifier: a decision id or a statute ELI.",
});
const titleSchema = t.String({
  minLength: 1,
  maxLength: LIMITS.searchHistoryTitleMaxLength,
});
const pathSchema = t.String({
  minLength: 1,
  maxLength: LIMITS.searchHistoryPathMaxLength,
  pattern: "^/law/[A-Za-z0-9_/-]+$",
  description: "The public law page the entry reopens.",
});

const unknownDocumentIdentitySchema = t.Object(
  { kind: t.Literal("unknown") },
  { additionalProperties: false },
);
const decisionDocumentIdentitySchema = t.Object(
  {
    kind: t.Literal("decision"),
    courtAbbreviation: t.Nullable(t.String({ minLength: 1, maxLength: 128 })),
    courtTier: t.Optional(
      t.Enum(
        Object.fromEntries(
          COURT_TIER_LABELS.map((tier) => [tier, tier] as const),
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
const statuteDocumentIdentitySchema = t.Object(
  {
    kind: t.Literal("statute"),
    number: t.Nullable(t.String({ minLength: 1, maxLength: 32 })),
    year: t.Nullable(
      t.String({ minLength: 1, maxLength: 4, pattern: "^[0-9]{1,4}$" }),
    ),
  },
  { additionalProperties: false },
);

/** One use to record: a typed query, or a decision or statute opened. */
export const searchHistoryEntryInputSchema = t.Union([
  t.Object(
    {
      kind: t.Literal("search"),
      query: t.String({
        minLength: 1,
        maxLength: LIMITS.searchQueryMaxLength,
      }),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      kind: t.Literal("decision"),
      courtId: t.Optional(
        t.Nullable(t.String({ minLength: 1, maxLength: 128 })),
      ),
      documentIdentity: t.Optional(
        t.Union([
          decisionDocumentIdentitySchema,
          unknownDocumentIdentitySchema,
        ]),
      ),
      documentId: documentIdSchema,
      title: titleSchema,
      path: pathSchema,
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      kind: t.Literal("statute"),
      documentIdentity: t.Optional(
        t.Union([statuteDocumentIdentitySchema, unknownDocumentIdentitySchema]),
      ),
      documentId: documentIdSchema,
      title: titleSchema,
      path: pathSchema,
    },
    { additionalProperties: false },
  ),
]);

export type SearchHistoryEntryInput = Static<
  typeof searchHistoryEntryInputSchema
>;

// Enum derives its choices without assigning a default to an omitted filter.
export const searchHistoryKindSchema = t.Enum(
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
  value.normalize("NFC").trim().replaceAll(/\s+/gu, " ");

/**
 * The entry as stored and the text its repeats are matched on. A query is
 * matched case- and spacing-insensitively, so "Náhrada  škody" and "náhrada
 * škody" are one entry; an opened document is matched on its identifier.
 * `null` when the entry is not one the law pages could have recorded.
 */
export const canonicalSearchHistoryEntry = (
  entry: SearchHistoryEntryInput,
): { entry: SearchHistoryEntryInput; match: string } | null => {
  switch (entry.kind) {
    case "search": {
      const query = collapseWhitespace(entry.query);
      return query.length === 0
        ? null
        : {
            entry: { kind: "search", query },
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
      if (title.length === 0 || documentId.length === 0 || !opensDocument) {
        return null;
      }
      return {
        entry: { ...entry, documentId, title },
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
  Value.Check(searchHistoryEntryInputSchema, value) ? value : null;

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
        lookupKey,
        entry: canonical.entry,
        firstUsedAt: use.usedAt,
        lastUsedAt: use.usedAt,
        useCount: 1,
      });
      continue;
    }
    const isLatest = use.usedAt >= previous.lastUsedAt;
    prepared.set(mapKey, {
      kind: previous.kind,
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
        courtId:
          use.entry.kind === "decision" ? (use.entry.courtId ?? null) : null,
        lookupKey: use.lookupKey,
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
  if (membership.status === "busy") {
    return panic("Blocking search history membership lock was busy");
  }
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
          tombstoneCutoffAt: searchHistoryOwners.tombstoneCutoffAt,
        })
        .from(searchHistoryOwners),
  });
  if (locked.status === "busy") {
    return panic("Blocking search history owner lock was busy");
  }
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
 * Writes prepared rows. A use of an entry the owner already has bumps that
 * row (latest use, count, and the latest spelling) instead of adding one.
 * Returns the id of each distinct entry written.
 */
type UpsertSearchHistoryRowsOptions = {
  tx: Transaction;
  rows: readonly SearchHistoryInsert[];
  recordAuditEvent: AuditRecorder;
} & ({ mode: "record" } | { mode: "import"; importClockMarginMs: number });

export const upsertSearchHistoryRows = async (
  options: UpsertSearchHistoryRowsOptions,
) => {
  const { tx, rows, mode, recordAuditEvent } = options;
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
  const deletedAt = new Map(
    tombstones.map((row) => [`${row.kind}:${row.lookupKey}`, row.deletedAt]),
  );
  const accepted = new Map<string, SearchHistoryInsert>();
  let skipped = 0;
  for (const row of rows) {
    const key = `${row.kind}:${row.lookupKey}`;
    const tombstone = deletedAt.get(key);
    // The browser obtains the signed database clock before capturing clientNow.
    // Subtract the observed serverNow-issuedAt interval before cutoff checks:
    // uses whose possible time overlaps a barrier are deliberately not restored.
    let cutoffUsedAt = row.lastUsedAt;
    switch (options.mode) {
      case "record":
        break;
      case "import":
        cutoffUsedAt = importUseCutoffLowerBound(
          row.lastUsedAt,
          options.importClockMarginMs,
        );
        break;
      default:
        options satisfies never;
        return panic("Unhandled search history write mode");
    }
    if (
      mode === "import" &&
      (cutoffUsedAt <= memberSince ||
        (state.clearedAt !== null && cutoffUsedAt <= state.clearedAt) ||
        (state.tombstoneCutoffAt !== null &&
          cutoffUsedAt <= state.tombstoneCutoffAt) ||
        (tombstone !== undefined && cutoffUsedAt <= tombstone))
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
  const acceptedRows = [...accepted.values()];
  const table = searchHistoryEntries;
  // A later use replaces the stored spelling; an older one (an import of
  // what a browser kept) merges its first use and preserves replay counts.
  const incomingIsLatest = sql`excluded.last_used_at::timestamptz >= ${table.lastUsedAt}`;
  const written =
    acceptedRows.length === 0
      ? []
      : await tx
          .insert(table)
          .values(acceptedRows)
          .onConflictDoUpdate({
            target: [
              table.organizationId,
              table.userId,
              table.kind,
              table.lookupKey,
            ],
            set: {
              courtId: sql`CASE WHEN ${incomingIsLatest} THEN excluded.court_id ELSE ${table.courtId} END`,
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
