import { Result } from "better-result";
import { and, asc, count, eq, like, sql } from "drizzle-orm";
import * as v from "valibot";

import {
  dictationTermKey,
  MAX_DICTATION_TERM_LENGTH,
  MAX_ORGANIZATION_DICTATION_TERMS,
} from "@stll/api-contract/dictation-vocabulary";
import { numberFromString } from "@stll/api-contract/http-input";

import { dictationVocabularyTerms } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { escapeLike } from "@/api/lib/escape-like";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";

import { countOrganizationTerms } from "./terms";

type TermRow = typeof dictationVocabularyTerms.$inferSelect;

const TERM_COLUMNS = {
  id: dictationVocabularyTerms.id,
  term: dictationVocabularyTerms.term,
  termKey: dictationVocabularyTerms.termKey,
  createdAt: dictationVocabularyTerms.createdAt,
};

const UNPROJECTED_TERM_COLUMNS = [
  "organizationId", // The active organization scopes the list.
  "createdBy", // Attribution stays in the audit trail.
] as const satisfies readonly (keyof TermRow)[];

type MissingTermColumn = UnprojectedColumns<
  TermRow,
  typeof TERM_COLUMNS,
  (typeof UNPROJECTED_TERM_COLUMNS)[number]
>;
type UnexpectedTermColumn = UnbackedProjectionKeys<
  TermRow,
  typeof TERM_COLUMNS,
  (typeof UNPROJECTED_TERM_COLUMNS)[number]
>;
true satisfies MissingTermColumn extends never ? true : never;
true satisfies UnexpectedTermColumn extends never ? true : never;

const PAGE_SIZE_DEFAULT = 100;
const PAGE_SIZE_MAX = 200;

const querySchema = v.object({
  search: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(MAX_DICTATION_TERM_LENGTH)),
  ),
  limit: v.optional(
    numberFromString(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(PAGE_SIZE_MAX)),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

const config = {
  contract: "patch",
  description:
    "List the organization's dictation words in alphabetical order, a page " +
    "at a time, optionally only those containing a search text (case " +
    "insensitive). Also returns how many words the list holds, how many " +
    "match, and the most it may hold.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_admin",
    consumesServices: false,
  },
  query: querySchema,
} satisfies HandlerConfig;

/** A cursor is the last word's key and id: keys are unique per list. */
const readCursor = (cursor: string | undefined) => {
  if (cursor === undefined) {
    return Result.ok(null);
  }
  const parts = decodePaginationCursor(cursor);
  const refused = Result.err(
    new HandlerError({
      status: 400,
      code: "invalid_cursor",
      message: "Invalid cursor",
    }),
  );
  if (parts?.length !== 2) {
    return refused;
  }
  const [key, id] = parts;
  if (typeof key !== "string" || !isUuidPaginationCursorPart(id)) {
    return refused;
  }
  return Result.ok({ key, id });
};

const listDictationVocabulary = createSafeRootHandler(
  config,
  async function* ({ query, safeDb, session }) {
    const organizationId = session.activeOrganizationId;
    const limit = normalizeTenantPageLimit(query.limit ?? PAGE_SIZE_DEFAULT);
    const after = yield* readCursor(query.cursor);
    const search =
      query.search === undefined || query.search.length === 0
        ? null
        : // sql-perf-allow: bounded by MAX_ORGANIZATION_DICTATION_TERMS rows of one organization, index dictation_vocabulary_terms_org_key_idx
          like(
            dictationVocabularyTerms.termKey,
            `%${escapeLike(dictationTermKey(query.search))}%`,
          );
    const listed = yield* Result.await(
      safeDb(async (tx) => {
        const inList = eq(
          dictationVocabularyTerms.organizationId,
          organizationId,
        );
        const rows = await tx
          .select(TERM_COLUMNS)
          .from(dictationVocabularyTerms)
          .where(
            and(
              inList,
              search ?? undefined,
              after === null
                ? undefined
                : sql`(${dictationVocabularyTerms.termKey}, ${dictationVocabularyTerms.id}) > (${after.key}, ${after.id}::uuid)`,
            ),
          )
          .orderBy(
            asc(dictationVocabularyTerms.termKey),
            asc(dictationVocabularyTerms.id),
          )
          .limit(limit + 1);
        const total = await countOrganizationTerms(tx, organizationId);
        const matching =
          search === null
            ? total
            : ((
                await tx
                  .select({ words: count() })
                  .from(dictationVocabularyTerms)
                  .where(and(inList, search))
              ).at(0)?.words ?? 0);
        return { rows, total, matching };
      }),
    );
    const page = createCursorPage({
      rows: listed.rows,
      limit,
      cursorForItem: ({ termKey, id }) => encodePaginationCursor([termKey, id]),
    });
    return Result.ok({
      items: page.items.map(({ id, term, createdAt }) => ({
        id,
        term,
        createdAt,
      })),
      nextCursor: page.nextCursor,
      total: listed.total,
      matching: listed.matching,
      max: MAX_ORGANIZATION_DICTATION_TERMS,
    });
  },
);

export default listDictationVocabulary;
