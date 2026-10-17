import { and, eq, or, sql } from "drizzle-orm";

import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";
import { mapWithConcurrency } from "@stll/concurrency";

import {
  assertCallerOrg,
  proveOrgScope,
  withOrgScope,
} from "@/api/db/org-scope";
import type { Transaction } from "@/api/db/root";
import { entities, pendingScoutEmissions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { mutateRecoveryReceipt } from "@/api/lib/db/recovery-bookkeeping/receipts";
import { findSignalsBackgroundActor } from "@/api/lib/feature-access/background";
import { lockFeatureRecoveryAdmission } from "@/api/lib/feature-access/recovery-admission-lock";
import {
  hearingDedupeKey,
  hearingSeverity,
  infoSoudLocalDate,
} from "@/api/lib/scouts/infosoud-hearings.logic";
import type { HearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { emitSignals } from "@/api/lib/signals/emit";

export type EmitInfoSoudHearingSignalsArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** Hearing entities inserted by this import, with their new ids. */
  inserted: { entityId: SafeId<"entity">; hearing: HearingRecord }[];
  now?: Date;
};

const hearingTitle = (hearing: HearingRecord) =>
  `Hearing listed: ${hearing.caseMark}`;

const hearingSummary = (hearing: HearingRecord) => {
  const when = hearing.startAt?.toISOString() ?? hearing.date ?? "unknown";
  const type = hearing.hearingType ?? "hearing";
  return `${hearing.court}: ${type} on ${when}.`;
};

/**
 * Emit one `hearing.changed` signal per newly imported hearing, inside the
 * import transaction. InfoSoud derives its hearing identifier from mutable
 * schedule fields and exposes no stable occurrence identity, so a new row is
 * reported as a listing without guessing that another hearing was rescheduled.
 */
export const emitInfoSoudHearingSignals = async ({
  tx,
  organizationId,
  workspaceId,
  inserted,
  now = new Date(),
}: EmitInfoSoudHearingSignalsArgs): Promise<void> => {
  if (inserted.length === 0) {
    return;
  }
  await lockFeatureRecoveryAdmission({
    tx,
    organizationId,
    featureId: "signals",
  });
  const entityIds = [...new Set(inserted.map(({ entityId }) => entityId))];
  const scopes = await mapWithConcurrency({
    items: entityIds,
    limit: 1,
    operation: async (entityId) => {
      const proof = await proveOrgScope(tx, {
        table: "entities",
        where: sql`${and(eq(entities.id, entityId), eq(entities.workspaceId, workspaceId))}`,
      });
      return proof.unwrapOr(null);
    },
  });
  const scope = scopes.at(0);
  if (
    scope === undefined ||
    scope === null ||
    scopes.some(
      (proof) =>
        proof === null || assertCallerOrg(proof, organizationId).isErr(),
    )
  ) {
    return;
  }
  await withOrgScope({
    tx,
    scope,
    actor: { type: "system" },
    fn: async (scopedTx) => {
      const recorded = await mutateRecoveryReceipt({
        type: "create-hearing",
        tx: scopedTx,
        table: pendingScoutEmissions,
        rows: inserted.map(({ entityId }) => ({
          organizationId: scope.organizationId,
          workspaceId,
          sourceKind: "infosoud-hearing" as const,
          sourceId: entityId,
        })),
      });
      if (
        (await findSignalsBackgroundActor({
          tx: scopedTx,
          organizationId: scope.organizationId,
          workspaceId,
        })) === null
      ) {
        return;
      }
      const proposed: NewSignal[] = inserted
        .filter(({ hearing }) => !hearing.cancelled)
        .map(({ entityId, hearing }) => {
          const currentAt =
            hearing.startAt?.toISOString() ?? hearing.date ?? "";
          return {
            kind: SIGNAL_KIND.HEARING_CHANGED,
            scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
            workspaceId,
            severity: hearingSeverity(hearing, null, now),
            confidence: null,
            title: hearingTitle(hearing),
            summary: hearingSummary(hearing),
            subject: { type: "entity", workspaceId, entityId },
            evidence: {
              kind: SIGNAL_KIND.HEARING_CHANGED,
              courtName: hearing.court,
              caseNumber: hearing.caseMark,
              previousAt: null,
              currentAt,
              hearingType: hearing.hearingType,
              sourceUrl: null,
            },
            suggestions: [
              ...(hearing.startAt
                ? [
                    {
                      kind: SUGGESTION_KIND.CREATE_DEADLINE,
                      workspaceId,
                      name: `${hearing.court} ${hearing.caseMark} hearing`,
                      dueAt: infoSoudLocalDate(hearing.startAt),
                    } as const,
                  ]
                : []),
              {
                kind: SUGGESTION_KIND.OPEN_CHAT,
                prompt: `Summarize what needs to be prepared for the ${hearing.hearingType ?? "hearing"} in ${hearing.caseMark} at ${hearing.court}.`,
              },
            ],
            dedupeKey: hearingDedupeKey(workspaceId, hearing.externalId),
          };
        });

      await emitSignals({
        tx: scopedTx,
        organizationId: scope.organizationId,
        signals: proposed,
      });
      if (recorded.length === 0) {
        return;
      }
      await mutateRecoveryReceipt({
        type: "dequeue-scout",
        tx: scopedTx,
        table: pendingScoutEmissions,
        where: sql`${and(
          eq(pendingScoutEmissions.organizationId, organizationId),
          eq(pendingScoutEmissions.sourceKind, "infosoud-hearing"),
          or(
            ...recorded.map(({ sourceId, nextAttemptAt }) =>
              and(
                eq(pendingScoutEmissions.sourceId, sourceId),
                sql`${pendingScoutEmissions.nextAttemptAt} = ${nextAttemptAt}::timestamptz`,
              ),
            ),
          ),
        )}`,
      });
    },
  });
};
