import {
  SCOUT_KEY,
  SIGNAL_KIND,
  SUGGESTION_KIND,
} from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
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
}: EmitInfoSoudHearingSignalsArgs): Promise<number> => {
  if (inserted.length === 0) {
    return 0;
  }
  const proposed: NewSignal[] = inserted
    .filter(({ hearing }) => !hearing.cancelled)
    .map(({ entityId, hearing }) => {
      const currentAt = hearing.startAt?.toISOString() ?? hearing.date ?? "";
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

  const { insertedIds: emitted } = await emitSignals({
    tx,
    organizationId,
    signals: proposed,
  });
  return emitted.length;
};
