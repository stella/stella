import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  templateLookupFormatUserDefaults,
  templateLookupFormats,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { LookupRegistry } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type SetLookupFormatUserDefaultArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  registry: LookupRegistry;
  /** `null` clears the choice, so the organization's default applies again. */
  formatId: SafeId<"templateLookupFormat"> | null;
};

/**
 * Record or clear a member's own default company specification format.
 *
 * The web settings page and the desktop registry search both write this
 * preference, so the upsert, the ownership check, and the clear live here
 * rather than once per entry point.
 *
 * Answers `HandlerError` (404) before writing anything when the format is not
 * one of this organization's formats for this registry, so the caller's
 * transaction has nothing to roll back.
 */
export const setLookupFormatUserDefault = async ({
  formatId,
  organizationId,
  registry,
  tx,
  userId,
}: SetLookupFormatUserDefaultArgs): Promise<Result<void, HandlerError>> => {
  // audit: skip — a personal display preference no colleague can observe;
  // the organization-wide default next door is the audited decision.
  if (formatId === null) {
    await tx
      .delete(templateLookupFormatUserDefaults)
      .where(
        and(
          eq(templateLookupFormatUserDefaults.userId, userId),
          eq(templateLookupFormatUserDefaults.organizationId, organizationId),
          eq(templateLookupFormatUserDefaults.registry, registry),
        ),
      );
    return Result.ok();
  }
  // No lock: a format's organization and registry never change, so this is a
  // decision about immutable columns rather than a read-decide-write race. A
  // format deleted between here and the insert is refused by the foreign key,
  // and a repeated save converges on the primary key.
  const target = await tx
    .select({ id: templateLookupFormats.id })
    .from(templateLookupFormats)
    .where(
      and(
        eq(templateLookupFormats.organizationId, organizationId),
        eq(templateLookupFormats.registry, registry),
        eq(templateLookupFormats.id, formatId),
      ),
    )
    .limit(1);
  if (target.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Saved format not found" }),
    );
  }
  await tx
    .insert(templateLookupFormatUserDefaults)
    .values({ userId, organizationId, registry, formatId })
    .onConflictDoUpdate({
      target: [
        templateLookupFormatUserDefaults.userId,
        templateLookupFormatUserDefaults.organizationId,
        templateLookupFormatUserDefaults.registry,
      ],
      set: { formatId, updatedAt: new Date() },
    });
  return Result.ok();
};
