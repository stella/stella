import { describe, expect, it } from "bun:test";

import {
  mergeStreamedPosition,
  parseReviewProposalEvent,
  REVIEW_PROPOSAL_EVENT,
} from "@/components/ai-suggestions/document-review-proposal-stream";
import type { IndexedPosition } from "@/components/ai-suggestions/document-review-proposal-stream";
import type { Position } from "@/lib/knowledge/playbook-types";

const gradedPosition = (sourceId: string): Position => ({
  mode: "graded",
  sourceId,
  issue: "Liability cap",
  severity: "high",
  standard: {
    source: "reference",
    termKind: "parameter",
    passages: [],
  },
  ask: { mode: "auto" },
  enabled: true,
});

const indexed = (index: number, sourceId: string): IndexedPosition => ({
  index,
  position: gradedPosition(sourceId),
});

describe("parseReviewProposalEvent", () => {
  it("reads a position frame", () => {
    const event = parseReviewProposalEvent(
      REVIEW_PROPOSAL_EVENT.POSITION,
      JSON.stringify({ index: 3, position: gradedPosition("a") }),
    );
    expect(event?.type).toBe(REVIEW_PROPOSAL_EVENT.POSITION);
    expect(event).toMatchObject({ index: 3 });
  });

  it("reads the nested skipped payload", () => {
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.SKIPPED,
        JSON.stringify({
          index: 0,
          skipped: {
            subject: "Governing law",
            reason: { kind: "other", text: "Not comparable" },
          },
        }),
      ),
    ).toEqual({
      type: REVIEW_PROPOSAL_EVENT.SKIPPED,
      index: 0,
      skipped: {
        subject: "Governing law",
        reason: { kind: "other", text: "Not comparable" },
      },
    });
  });

  it("reads a coded skip reason, and drops a code it has no words for", () => {
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.SKIPPED,
        JSON.stringify({
          index: 1,
          skipped: {
            subject: "Long-stop date",
            reason: { kind: "deal-specific-value" },
          },
        }),
      ),
    ).toEqual({
      type: REVIEW_PROPOSAL_EVENT.SKIPPED,
      index: 1,
      skipped: {
        subject: "Long-stop date",
        reason: { kind: "deal-specific-value" },
      },
    });
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.SKIPPED,
        JSON.stringify({
          index: 2,
          skipped: { subject: "Notary", reason: { kind: "invented-later" } },
        }),
      ),
    ).toBeNull();
  });

  it("reads parties, done and error frames", () => {
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.PARTIES,
        JSON.stringify({ parties: [{ role: "Purchaser", name: null }] }),
      ),
    ).toEqual({
      type: REVIEW_PROPOSAL_EVENT.PARTIES,
      parties: [{ role: "Purchaser", name: null }],
    });
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.DONE,
        JSON.stringify({ positionCount: 12, skippedCount: 2 }),
      ),
    ).toEqual({
      type: REVIEW_PROPOSAL_EVENT.DONE,
      positionCount: 12,
      skippedCount: 2,
    });
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.ERROR,
        JSON.stringify({ code: "proposal_failed" }),
      ),
    ).toEqual({
      type: REVIEW_PROPOSAL_EVENT.ERROR,
      code: "proposal_failed",
    });
  });

  it("drops a frame whose name is not part of the vocabulary", () => {
    expect(parseReviewProposalEvent("heartbeat", "{}")).toBeNull();
  });

  it("drops a frame whose payload does not carry what the name promises", () => {
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.POSITION,
        JSON.stringify({ index: 0, position: { issue: "no identity" } }),
      ),
    ).toBeNull();
    expect(
      parseReviewProposalEvent(REVIEW_PROPOSAL_EVENT.DONE, "not json"),
    ).toBeNull();
    expect(
      parseReviewProposalEvent(
        REVIEW_PROPOSAL_EVENT.SKIPPED,
        JSON.stringify({
          index: 0,
          subject: "flat",
          reason: { kind: "structural" },
        }),
      ),
    ).toBeNull();
  });
});

describe("mergeStreamedPosition", () => {
  it("places a position by the index the server states, not by arrival", () => {
    const merged = mergeStreamedPosition(
      [indexed(0, "a"), indexed(2, "c")],
      indexed(1, "b"),
    );
    expect(merged.map((entry) => entry.position.sourceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("replaces a replayed index rather than duplicating it", () => {
    const merged = mergeStreamedPosition([indexed(0, "a")], indexed(0, "a2"));
    expect(merged.map((entry) => entry.position.sourceId)).toEqual(["a2"]);
  });
});
