import { expect, test } from "bun:test";

import {
  canTransitionCorpusIndexIntent,
  CORPUS_INDEX_INTENT_STATUSES,
  CORPUS_INDEX_INTENT_TRANSITIONS,
  corpusIndexIntentStatusAfterUnknownAppend,
  isCorpusIndexIntentOutstanding,
  isCorpusIndexProjectionConverged,
  type CorpusIndexDesiredProjection,
} from "@/api/lib/legal-search/corpus-index-projection-contract";

test("intent transitions are total and never reuse an uncertain append", () => {
  expect(Object.keys(CORPUS_INDEX_INTENT_TRANSITIONS).sort()).toEqual(
    [...CORPUS_INDEX_INTENT_STATUSES].sort(),
  );
  expect(canTransitionCorpusIndexIntent("reserved", "append_started")).toBe(
    true,
  );
  expect(canTransitionCorpusIndexIntent("append_started", "reserved")).toBe(
    false,
  );
  expect(corpusIndexIntentStatusAfterUnknownAppend("append_started")).toBe(
    "cleanup_pending",
  );
  expect(corpusIndexIntentStatusAfterUnknownAppend("append_committed")).toBe(
    "cleanup_pending",
  );
  expect(corpusIndexIntentStatusAfterUnknownAppend("reserved")).toBe(
    "reserved",
  );
});

test("cleanup retries until one retired revision settles", () => {
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.applied).toEqual(["cleanup_pending"]);
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.cleanup_pending).toEqual([
    "cleanup_started",
  ]);
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.cleanup_started).toEqual([
    "cleanup_pending",
    "cleanup_committed",
  ]);
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.cleanup_committed).toEqual([
    "settled",
  ]);
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.settled).toEqual(["cleanup_pending"]);
  expect(CORPUS_INDEX_INTENT_TRANSITIONS.cancelled).toEqual([]);
});

test("an applied intent is quiet only when authoritative state references it", () => {
  const revision = "0198e331-e578-7000-8000-000000000001";
  expect(
    isCorpusIndexIntentOutstanding({
      status: "applied",
      revision,
      appliedRevision: revision,
    }),
  ).toBe(false);
  expect(
    isCorpusIndexIntentOutstanding({
      status: "applied",
      revision,
      appliedRevision: null,
    }),
  ).toBe(true);
  expect(
    isCorpusIndexIntentOutstanding({
      status: "applied",
      revision,
      appliedRevision: "0198e331-e578-7000-8000-000000000002",
    }),
  ).toBe(true);
  expect(
    isCorpusIndexIntentOutstanding({
      status: "settled",
      revision,
      appliedRevision: null,
    }),
  ).toBe(false);
});

test("convergence requires desired state, epoch, fingerprint, and quiet intents", () => {
  const desired = {
    action: "upsert",
    epoch: 8n,
    fingerprint: "a".repeat(64),
    indexId: "case_law_v5_cs_sk",
  } as const satisfies CorpusIndexDesiredProjection;
  const applied = {
    ...desired,
    revision: "0198e331-e578-7000-8000-000000000001",
  };

  expect(
    isCorpusIndexProjectionConverged({
      desired,
      applied,
      outstandingIntentCount: 0,
    }),
  ).toBe(true);
  expect(
    isCorpusIndexProjectionConverged({
      desired,
      applied,
      outstandingIntentCount: 1,
    }),
  ).toBe(false);
  expect(
    isCorpusIndexProjectionConverged({
      desired,
      applied: { ...applied, epoch: 7n },
      outstandingIntentCount: 0,
    }),
  ).toBe(false);
  expect(
    isCorpusIndexProjectionConverged({
      desired,
      applied: { ...applied, fingerprint: "b".repeat(64) },
      outstandingIntentCount: 0,
    }),
  ).toBe(false);
  expect(
    isCorpusIndexProjectionConverged({
      desired,
      applied: { ...applied, indexId: "case_law_v5_eu" },
      outstandingIntentCount: 0,
    }),
  ).toBe(false);
});

test("an erased entity converges without an index revision", () => {
  expect(
    isCorpusIndexProjectionConverged({
      desired: { action: "erase", epoch: 11n },
      applied: { action: "erase", epoch: 11n },
      outstandingIntentCount: 0,
    }),
  ).toBe(true);
  expect(
    isCorpusIndexProjectionConverged({
      desired: { action: "erase", epoch: 11n },
      applied: { action: "missing" },
      outstandingIntentCount: 0,
    }),
  ).toBe(false);
});
