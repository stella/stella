import { expect, test } from "bun:test";

import {
  REMOVAL_SUPERSEDED_REASON,
  supersededRemovalEvidence,
} from "./removal-evidence";
import type {
  RemovalEvidence,
  RemovalSupersededReason,
} from "./removal-evidence";

type Revision = Parameters<typeof supersededRemovalEvidence>[1];
const now = new Date("2026-10-28T09:00:00.000Z");
const current = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000002",
  sourceDocumentId: "uksc/2024/1",
  sourceObservedAt: now,
  sourceObservationOrder: 1n,
  redactedAt: now,
} as const satisfies Revision;
const evidence = {
  type: "existing-redaction",
  decisionId: current.id,
  sourceId: current.sourceId,
  sourceDocumentId: current.sourceDocumentId,
  observedAt: now.toISOString(),
  sourceObservedAt: now.toISOString(),
  sourceObservationOrder: "1",
} as const satisfies RemovalEvidence;

const changes = {
  id: {
    decision: { ...current, id: "00000000-0000-4000-8000-000000000003" },
    reason: REMOVAL_SUPERSEDED_REASON.IDENTITY_CHANGED,
  },
  sourceId: {
    decision: { ...current, sourceId: "00000000-0000-4000-8000-000000000004" },
    reason: REMOVAL_SUPERSEDED_REASON.IDENTITY_CHANGED,
  },
  sourceDocumentId: {
    decision: { ...current, sourceDocumentId: "uksc/2024/2" },
    reason: REMOVAL_SUPERSEDED_REASON.IDENTITY_CHANGED,
  },
  sourceObservedAt: {
    decision: { ...current, sourceObservedAt: new Date(now.getTime() + 1) },
    reason: REMOVAL_SUPERSEDED_REASON.OBSERVATION_CHANGED,
  },
  sourceObservationOrder: {
    decision: { ...current, sourceObservationOrder: 2n },
    reason: REMOVAL_SUPERSEDED_REASON.OBSERVATION_CHANGED,
  },
  redactedAt: {
    decision: { ...current, redactedAt: null },
    reason: REMOVAL_SUPERSEDED_REASON.RESTORED,
  },
} as const satisfies Record<
  keyof Revision,
  { decision: Revision; reason: RemovalSupersededReason }
>;

for (const [field, { decision, reason }] of Object.entries(changes)) {
  test(`a changed ${field} supersedes its captured removal evidence`, () => {
    expect(supersededRemovalEvidence(evidence, current)).toBeNull();
    expect(supersededRemovalEvidence(evidence, decision)).toBe(reason);
  });
}

test("redaction retains the original absence revision for completion retries", () => {
  const absence = {
    ...evidence,
    type: "publisher-absence",
    absence: "http-410",
  } as const satisfies RemovalEvidence;
  expect(
    supersededRemovalEvidence(absence, { ...current, redactedAt: null }),
  ).toBeNull();
  expect(supersededRemovalEvidence(absence, current)).toBeNull();
});

test("legacy null observation watermarks compare exactly", () => {
  const legacy = {
    ...evidence,
    sourceObservedAt: null,
    sourceObservationOrder: null,
  };
  expect(
    supersededRemovalEvidence(legacy, {
      ...current,
      sourceObservedAt: null,
      sourceObservationOrder: null,
    }),
  ).toBeNull();
  expect(supersededRemovalEvidence(legacy, current)).toBe(
    REMOVAL_SUPERSEDED_REASON.OBSERVATION_CHANGED,
  );
});
