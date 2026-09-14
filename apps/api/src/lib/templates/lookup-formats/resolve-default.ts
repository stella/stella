import type { Result } from "better-result";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import type { SafeDbError, SafeDbOrTx } from "@/api/db/safe-db";
import { withScopedTx } from "@/api/db/safe-db";
import {
  LOOKUP_FORMAT_PREFERENCE,
  templateLookupFormatUserDefaults,
  templateLookupFormats,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { LookupRegistry } from "@/api/lib/docx/types";

type ResolveLookupFormatDefaultArgs = SafeDbOrTx & {
  organizationId: SafeId<"organization">;
  registry: LookupRegistry;
  userId: SafeId<"user">;
};

export const LOOKUP_FORMAT_DEFAULT_SOURCE = {
  USER: "user",
  ORGANIZATION: "organization",
} as const;

/** Who the resolved default belongs to: the member, or the organization. */
type LookupFormatDefaultSource =
  (typeof LOOKUP_FORMAT_DEFAULT_SOURCE)[keyof typeof LOOKUP_FORMAT_DEFAULT_SOURCE];

type ResolvedLookupFormatDefault = {
  id: SafeId<"templateLookupFormat">;
  name: string;
  format: string;
  source: LookupFormatDefaultSource;
};

/**
 * The company specification format a member actually gets for a registry:
 * their own choice when they made one, otherwise the organization's default,
 * otherwise `null` — the caller's cue to use the registry's built-in format.
 *
 * Both candidates are read in one statement, so the two-level fallback has one
 * owner rather than a copy per call site. The join is also what proves a
 * personal choice still points at a format of this organization and registry;
 * the preference row alone is not evidence of that, and it is what `source`
 * reports, so a caller can tell a personal default from the firm's without a
 * second query.
 */
export const resolveLookupFormatDefault = async ({
  organizationId,
  registry,
  userId,
  ...handle
}: ResolveLookupFormatDefaultArgs): Promise<
  Result<ResolvedLookupFormatDefault | null, SafeDbError>
> =>
  (
    await withScopedTx(handle, async (tx) =>
      tx
        .select({
          id: templateLookupFormats.id,
          name: templateLookupFormats.name,
          format: templateLookupFormats.format,
          // The joined member id is the evidence of whose default this is:
          // present only when the member's own row matched.
          chosenBy: templateLookupFormatUserDefaults.userId,
        })
        .from(templateLookupFormats)
        .leftJoin(
          templateLookupFormatUserDefaults,
          and(
            eq(
              templateLookupFormatUserDefaults.formatId,
              templateLookupFormats.id,
            ),
            eq(templateLookupFormatUserDefaults.userId, userId),
            eq(templateLookupFormatUserDefaults.organizationId, organizationId),
            eq(templateLookupFormatUserDefaults.registry, registry),
          ),
        )
        .where(
          and(
            eq(templateLookupFormats.organizationId, organizationId),
            eq(templateLookupFormats.registry, registry),
            or(
              isNotNull(templateLookupFormatUserDefaults.userId),
              eq(
                templateLookupFormats.preference,
                LOOKUP_FORMAT_PREFERENCE.DEFAULT,
              ),
            ),
          ),
        )
        // `false` sorts first, so the member's own row precedes the
        // organization's. At most one of each kind can match.
        .orderBy(sql`${templateLookupFormatUserDefaults.userId} IS NULL`)
        .limit(1),
    )
  ).map((rows) => {
    const row = rows.at(0);
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      name: row.name,
      format: row.format,
      source:
        row.chosenBy === null
          ? LOOKUP_FORMAT_DEFAULT_SOURCE.ORGANIZATION
          : LOOKUP_FORMAT_DEFAULT_SOURCE.USER,
    };
  });
