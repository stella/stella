import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import type { AnonymizationBlacklistEntryInput } from "@/api/lib/anonymization-blacklist";
import { normalizeAnonymizationBlacklistEntry } from "@/api/lib/anonymization-blacklist";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const blacklistEntrySchema = t.Object({
  canonical: t.String({ minLength: 1, maxLength: 512 }),
  enabled: t.Optional(t.Boolean()),
  label: t.String({ minLength: 1, maxLength: 64 }),
  variants: t.Optional(
    t.Array(t.String({ minLength: 1, maxLength: 512 }), {
      maxItems: LIMITS.anonymizationBlacklistVariantsPerEntry,
    }),
  ),
});

const updateAnonymizationBlacklistBodySchema = t.Object({
  entries: t.Array(blacklistEntrySchema, {
    maxItems: LIMITS.anonymizationBlacklistEntriesPerOrganization,
  }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateAnonymizationBlacklistBodySchema,
} satisfies HandlerConfig;

const normalizeEntries = (entries: AnonymizationBlacklistEntryInput[]) => {
  const seenCanonical = new Set<string>();
  const normalized = [];

  for (const entry of entries) {
    const next = normalizeAnonymizationBlacklistEntry(entry);
    const canonicalKey = next.canonical.toLocaleLowerCase();

    if (seenCanonical.has(canonicalKey)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Duplicate anonymization blacklist term",
        }),
      );
    }

    seenCanonical.add(canonicalKey);
    normalized.push(next);
  }

  return Result.ok(normalized);
};

const updateAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    const entries = normalizeEntries(body.entries);
    if (Result.isError(entries)) {
      return Result.err(entries.error);
    }

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .delete(anonymizationBlacklistEntries)
          .where(
            eq(
              anonymizationBlacklistEntries.organizationId,
              session.activeOrganizationId,
            ),
          );

        if (entries.value.length === 0) {
          return;
        }

        await tx.insert(anonymizationBlacklistEntries).values(
          entries.value.map((entry) => ({
            id: createSafeId<"anonymizationBlacklistEntry">(),
            organizationId: session.activeOrganizationId,
            label: entry.label,
            canonical: entry.canonical,
            variants: entry.variants,
            enabled: entry.enabled,
            createdBy: user.id,
            updatedBy: user.id,
          })),
        );
      }),
    );

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
