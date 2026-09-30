import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { renderMatterReference } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import { documentReferenceCounters, matterCounters } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { toScopeKey } from "@/api/lib/matter-reference";

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
  for (;;) {
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
};
