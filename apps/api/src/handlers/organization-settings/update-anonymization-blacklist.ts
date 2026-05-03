import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { anonymizationBlacklistEntries } from "@/api/db/schema";
import { normalizeAnonymizationBlacklistEntries } from "@/api/lib/anonymization-blacklist";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
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

const updateAnonymizationBlacklist = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user }) {
    const entries = normalizeAnonymizationBlacklistEntries(body.entries);
    if (Result.isError(entries)) {
      return Result.err(entries.error);
    }

    yield* Result.await(
      safeDb(async (tx) => {
        const existingRows = await tx
          .select({
            canonical: anonymizationBlacklistEntries.canonical,
            id: anonymizationBlacklistEntries.id,
          })
          .from(anonymizationBlacklistEntries)
          .where(
            eq(
              anonymizationBlacklistEntries.organizationId,
              session.activeOrganizationId,
            ),
          );

        const existingByCanonical = new Map(
          existingRows.map((row) => [row.canonical.toLocaleLowerCase(), row]),
        );
        const incomingCanonicalKeys = new Set(
          entries.value.map((entry) => entry.canonical.toLocaleLowerCase()),
        );

        for (const existing of existingRows) {
          if (
            incomingCanonicalKeys.has(existing.canonical.toLocaleLowerCase())
          ) {
            continue;
          }

          await tx
            .delete(anonymizationBlacklistEntries)
            .where(
              and(
                eq(anonymizationBlacklistEntries.id, existing.id),
                eq(
                  anonymizationBlacklistEntries.organizationId,
                  session.activeOrganizationId,
                ),
              ),
            );
        }

        if (entries.value.length === 0) {
          return;
        }

        const now = new Date();

        for (const entry of entries.value) {
          const existing = existingByCanonical.get(
            entry.canonical.toLocaleLowerCase(),
          );

          if (existing) {
            await tx
              .update(anonymizationBlacklistEntries)
              .set({
                label: entry.label,
                canonical: entry.canonical,
                variants: entry.variants,
                enabled: entry.enabled,
                updatedBy: user.id,
                updatedAt: now,
              })
              .where(
                and(
                  eq(anonymizationBlacklistEntries.id, existing.id),
                  eq(
                    anonymizationBlacklistEntries.organizationId,
                    session.activeOrganizationId,
                  ),
                ),
              );
            continue;
          }

          await tx.insert(anonymizationBlacklistEntries).values({
            id: createSafeId<"anonymizationBlacklistEntry">(),
            organizationId: session.activeOrganizationId,
            label: entry.label,
            canonical: entry.canonical,
            variants: entry.variants,
            enabled: entry.enabled,
            createdBy: user.id,
            updatedBy: user.id,
          });
        }
      }),
    );

    return Result.ok({ entries: entries.value });
  },
);

export default updateAnonymizationBlacklist;
