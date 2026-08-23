import { and, eq, notInArray } from "drizzle-orm";

import { SIGNAL_KIND, SUGGESTION_KIND } from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { AGENDA_ITEM_KIND } from "@/api/lib/entity-constants";
import {
  findPreviousStart,
  hearingDedupeKey,
  hearingSeverity,
  infoSoudLocalDate,
  toHearingRecord,
} from "@/api/lib/scouts/infosoud-hearings.logic";
import type { HearingRecord } from "@/api/lib/scouts/infosoud-hearings.logic";
import type { NewSignal } from "@/api/lib/signals/emit";
import { emitSignals } from "@/api/lib/signals/emit";
import { SCOUT_KEY } from "@/api/lib/signals/scout";

const INFO_SOUD_EXTERNAL_SOURCE = "infosoud";

export type EmitInfoSoudHearingSignalsArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  /** Hearing entities inserted by this import, with their new ids. */
  inserted: { entityId: SafeId<"entity">; hearing: HearingRecord }[];
  now?: Date;
};

const hearingTitle = (hearing: HearingRecord, previousAt: Date | null) =>
  previousAt
    ? `Hearing rescheduled: ${hearing.caseMark}`
    : `Hearing listed: ${hearing.caseMark}`;

const hearingSummary = (hearing: HearingRecord, previousAt: Date | null) => {
  const when = hearing.startAt?.toISOString() ?? hearing.date ?? "unknown";
  const type = hearing.hearingType ?? "hearing";
  if (previousAt) {
    return `${hearing.court}: ${type} moved from ${previousAt.toISOString()} to ${when}.`;
  }
  return `${hearing.court}: ${type} on ${when}.`;
};

/**
 * Emit one `hearing.changed` signal per newly imported hearing, inside the
 * import transaction. Earlier hearings of the same case and type are loaded
 * from the workspace so a reschedule can carry its previous date.
 */
export const emitInfoSoudHearingSignals = async ({
  tx,
  organizationId,
  workspaceId,
  inserted,
  now = new Date(),
}: EmitInfoSoudHearingSignalsArgs): Promise<number> => {
  if (inserted.length === 0) {
    return 0;
  }
  const insertedIds = inserted.map((item) => item.entityId);
  const priorRows = await tx
    .select({
      externalId: entities.externalId,
      externalData: entities.externalData,
      startAt: entities.startAt,
    })
    .from(entities)
    .where(
      and(
        eq(entities.workspaceId, workspaceId),
        eq(entities.externalSource, INFO_SOUD_EXTERNAL_SOURCE),
        eq(entities.agendaKind, AGENDA_ITEM_KIND.HEARING),
        notInArray(entities.id, insertedIds),
      ),
    );
  const existing = priorRows
    .map(toHearingRecord)
    .filter((record) => record !== null);

  const proposed: NewSignal[] = inserted
    .filter(({ hearing }) => !hearing.cancelled)
    .map(({ entityId, hearing }) => {
      const previousAt = findPreviousStart(hearing, existing);
      const currentAt = hearing.startAt?.toISOString() ?? hearing.date ?? "";
      return {
        kind: SIGNAL_KIND.HEARING_CHANGED,
        scoutKey: SCOUT_KEY.INFOSOUD_HEARINGS,
        workspaceId,
        severity: hearingSeverity(hearing, previousAt, now),
        confidence: null,
        title: hearingTitle(hearing, previousAt),
        summary: hearingSummary(hearing, previousAt),
        subject: { type: "entity", workspaceId, entityId },
        evidence: {
          kind: SIGNAL_KIND.HEARING_CHANGED,
          courtName: hearing.court,
          caseNumber: hearing.caseMark,
          previousAt: previousAt?.toISOString() ?? null,
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

  const { insertedIds: emitted } = await emitSignals({
    tx,
    organizationId,
    signals: proposed,
  });
  return emitted.length;
};
