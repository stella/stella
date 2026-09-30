import { panic } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

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

const MATTER_REFERENCE_BATCH_SIZE = 10;
const MAX_MATTER_REFERENCE_ALLOCATION_ROUNDS = 10;
export const MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS =
  MATTER_REFERENCE_BATCH_SIZE * MAX_MATTER_REFERENCE_ALLOCATION_ROUNDS;

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
  // Reserve the bounded search range under one counter lock. Keep that lock
  // until the chosen sequence is committed, returning unused numbers to it.
  const counters = await tx
    .insert(matterCounters)
    .values({
      id: createSafeId<"matterCounter">(),
      organizationId,
      scopeKey,
      lastValue: MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS,
    })
    .onConflictDoUpdate({
      target: [matterCounters.organizationId, matterCounters.scopeKey],
      set: {
        lastValue: sql`${matterCounters.lastValue} + ${MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS}`,
      },
    })
    .returning({ lastValue: matterCounters.lastValue });
  const counter = counters.at(0);
  if (!counter) {
    panic("Failed to create matter counter");
  }
  const candidates = Array.from(
    { length: MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS },
    (_, index) => {
      const sequence =
        counter.lastValue -
        MAX_MATTER_REFERENCE_ALLOCATION_ATTEMPTS +
        index +
        1;
      return {
        sequence,
        reference: renderMatterReference({
          pattern,
          now,
          seq: sequence,
          padding,
        }),
      };
    },
  );
  let selected: (typeof candidates)[number] | undefined;
  for (let round = 0; round < MAX_MATTER_REFERENCE_ALLOCATION_ROUNDS; round++) {
    const batch = candidates.slice(
      round * MATTER_REFERENCE_BATCH_SIZE,
      (round + 1) * MATTER_REFERENCE_BATCH_SIZE,
    );
    const ledger = await tx
      .select({ reference: documentReferenceCounters.reference })
      .from(documentReferenceCounters)
      .where(
        and(
          eq(documentReferenceCounters.organizationId, organizationId),
          inArray(
            documentReferenceCounters.reference,
            batch.map(({ reference }) => reference),
          ),
        ),
      )
      .orderBy(documentReferenceCounters.reference)
      .limit(MATTER_REFERENCE_BATCH_SIZE)
      .for("update");
    const unavailable = new Set(ledger.map(({ reference }) => reference));
    selected = batch.find(({ reference }) => !unavailable.has(reference));
    if (selected !== undefined) {
      break;
    }
  }
  if (selected !== undefined) {
    await tx
      .update(matterCounters)
      .set({ lastValue: selected.sequence })
      .where(
        and(
          eq(matterCounters.organizationId, organizationId),
          eq(matterCounters.scopeKey, scopeKey),
        ),
      );
    return selected.reference;
  }
  throw new HandlerError({
    status: 409,
    code: "MATTER_REFERENCE_ALLOCATION_EXHAUSTED",
    message:
      "Could not allocate a matter reference. Choose a different matter numbering pattern and try again.",
  });
};
