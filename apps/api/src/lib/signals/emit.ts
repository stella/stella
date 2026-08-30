import { SIGNAL_KIND_ORIGIN } from "@stll/api-contract/signals";
import type {
  SignalEvidence,
  SignalKind,
  SignalSeverity,
  SignalSubject,
  SignalSuggestion,
} from "@stll/api-contract/signals";

import type { Transaction } from "@/api/db/root";
import { SIGNAL_EVENT_TYPE, signalEvents, signals } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * A signal as a scout proposes it. `kind` fixes the origin (total map in
 * the contract) and narrows the evidence shape; `confidence` is required
 * exactly when the origin is `model` (also a DB check).
 */
type NewSignalOf<K extends SignalKind> = {
  kind: K;
  scoutKey: string;
  workspaceId: SafeId<"workspace"> | null;
  severity: SignalSeverity;
  confidence: (typeof SIGNAL_KIND_ORIGIN)[K] extends "model" ? number : null;
  title: string;
  summary: string;
  subject: SignalSubject;
  evidence: Extract<SignalEvidence, { kind: K }>;
  suggestions: SignalSuggestion[];
  /** Stable per observation; re-emitting the same key is a no-op. */
  dedupeKey: string;
  assigneeUserId?: SafeId<"user"> | null;
  createdByUserId?: SafeId<"user"> | null;
};

export type NewSignal = {
  [K in SignalKind]: NewSignalOf<K>;
}[SignalKind];

export type EmitSignalsArgs = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  signals: NewSignal[];
};

export type EmitSignalsResult = {
  insertedIds: SafeId<"signal">[];
  emittedCount: number;
};

/**
 * Insert signals idempotently on `(organization_id, dedupe_key)` and log a
 * `created` event for each row that landed. Must run inside the caller's
 * transaction so the signal and its event commit together.
 */
export const emitSignals = async ({
  tx,
  organizationId,
  signals: proposed,
}: EmitSignalsArgs): Promise<EmitSignalsResult> => {
  if (proposed.length === 0) {
    return { insertedIds: [], emittedCount: 0 };
  }
  const values = proposed.map((signal) => ({
    id: createSafeId<"signal">(),
    organizationId,
    workspaceId: signal.workspaceId,
    kind: signal.kind,
    origin: SIGNAL_KIND_ORIGIN[signal.kind],
    scoutKey: signal.scoutKey,
    severity: signal.severity,
    confidence: signal.confidence,
    title: signal.title,
    summary: signal.summary,
    subject: signal.subject,
    evidence: signal.evidence,
    suggestions: signal.suggestions,
    dedupeKey: signal.dedupeKey,
    assigneeUserId: signal.assigneeUserId ?? null,
    createdByUserId: signal.createdByUserId ?? null,
  }));

  const inserted = await tx
    .insert(signals)
    .values(values)
    .onConflictDoNothing({
      target: [signals.organizationId, signals.dedupeKey],
    })
    .returning({ id: signals.id, createdByUserId: signals.createdByUserId });

  if (inserted.length > 0) {
    await tx.insert(signalEvents).values(
      inserted.map((row) => ({
        id: createSafeId<"signalEvent">(),
        organizationId,
        signalId: row.id,
        type: SIGNAL_EVENT_TYPE.CREATED,
        actorUserId: row.createdByUserId,
      })),
    );
  }

  return {
    insertedIds: inserted.map((row) => row.id),
    emittedCount: proposed.length,
  };
};
