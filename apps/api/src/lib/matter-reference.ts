import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { renderMatterReference } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { documentReferenceCounters, matterCounters } from "@/api/db/schema";
import {
  toNumberPatternScopeKey,
  validateNumberPattern,
} from "@/api/lib/billing/number-pattern";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export const MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS = 100;

export const validatePattern = (pattern: string, padding: number) =>
  validateNumberPattern({ pattern, padding, sequenceDigitsBudget: 6 });

export const toScopeKey = (pattern: string, now: Date) =>
  toNumberPatternScopeKey({ pattern, now });

export {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@stll/api-contract";

type AllocateMatterReferenceOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  pattern: string;
  padding: number;
  now: Date;
};

export const allocateMatterReference = async ({
  tx,
  organizationId,
  pattern,
  padding,
  now,
}: AllocateMatterReferenceOptions): Promise<string> => {
  const scopeKey = toScopeKey(pattern, now);
  // The counter lock serializes candidate selection across matter creation.
  for (
    let attempt = 0;
    attempt < MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS;
    attempt++
  ) {
    const counters = await tx
      .insert(matterCounters)
      .values({
        id: createSafeId<"matterCounter">(),
        organizationId,
        scopeKey,
        lastValue: 1,
      })
      .onConflictDoUpdate({
        target: [matterCounters.organizationId, matterCounters.scopeKey],
        set: { lastValue: sql`${matterCounters.lastValue} + 1` },
      })
      .returning({ lastValue: matterCounters.lastValue });
    const counter = counters.at(0);
    if (!counter) {
      panic("Failed to create matter counter");
    }
    const reference = renderMatterReference({
      pattern,
      now,
      seq: counter.lastValue,
      padding,
    });
    const ledger = await tx
      .select({ id: documentReferenceCounters.id })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, organizationId),
          eq(documentReferenceCounters.reference, reference),
        ),
      )
      .limit(1)
      .for("update");
    if (ledger.length === 0) {
      return reference;
    }
  }
  throw new HandlerError({
    status: 409,
    code: "MATTER_REFERENCE_ALLOCATION_EXHAUSTED",
    message:
      "Could not allocate a matter reference. Choose a different matter numbering pattern and try again.",
  });
};
