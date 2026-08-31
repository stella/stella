/**
 * A proposed position is only as good as the passages it quotes: what the
 * model returns is a claim about the reference documents, and everything below
 * is about holding it to them — to the one term it is allowed to be, and to
 * being a term at all rather than a particular of this deal.
 *
 * The streaming and batch endpoints share this module, so the last block here
 * asserts what that sharing is worth: the same model output decided element by
 * element and decided all at once produces the same list.
 */

import { describe, expect, test } from "bun:test";

import {
  cappedSeverity,
  createPartialProposalReader,
  createProposalNormalizer,
  DEAL_SPECIFIC_VALUE_SKIP_REASON,
  LOWER_WEIGHT_SKIP_REASON,
  normalizeProposal,
  proposedPositionSchema,
  proposedPositionsSchema,
  REVIEW_PROPOSAL_CAP,
  statesComparableValue,
  STRUCTURAL_SKIP_REASON,
} from "@/api/handlers/document-reviews/reference-position-normalizer";
import type {
  ProposedPositions,
  ReferenceSource,
  ReviewProposalEvent,
} from "@/api/handlers/document-reviews/reference-position-normalizer";
import { toSafeId } from "@/api/lib/branded-types";
import {
  REVIEW_PARTIES_MAX,
  REVIEW_SKIPPED_MAX,
} from "@/api/lib/document-review/contract";
import type { ProposedReferencePosition } from "@/api/lib/document-review/reference-passages";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import {
  POSITION_PURPOSE_MAX_LENGTH,
  POSITION_TERM_KINDS,
  type Position,
} from "@/api/lib/workflow/playbook-positions";

const SOURCE_KEY = "F1";
const CLAIMS_BLOCK = "Claims must be notified within 6 months of Completion.";
const WORDED_BLOCK = "Claims must be notified within six months of Completion.";
const DATE_BLOCK = "The Locked Box Date is 31 December 2025.";
const PLACEHOLDER_BLOCK = "The Long Stop Date is [●].";

const source: ReferenceSource = {
  workspaceId: toSafeId<"workspace">("11111111-1111-4111-8111-111111111111"),
  entityId: toSafeId<"entity">("22222222-2222-4222-8222-222222222222"),
  entityVersionId: toSafeId<"entityVersion">(
    "33333333-3333-4333-8333-333333333333",
  ),
  file: {
    kind: "docx",
    fileFieldId: toSafeId<"field">("44444444-4444-4444-8444-444444444444"),
    fileId: "file-1",
    blocks: [
      { kind: "paragraph", id: "r-1", text: CLAIMS_BLOCK },
      { kind: "paragraph", id: "r-2", text: "   " },
      { kind: "paragraph", id: "r-3", text: DATE_BLOCK },
      { kind: "paragraph", id: "r-4", text: PLACEHOLDER_BLOCK },
      { kind: "paragraph", id: "r-5", text: WORDED_BLOCK },
    ],
    simplifiedName: SOURCE_KEY,
  },
};

const proposed = (overrides: Record<string, unknown> = {}) => ({
  termKind: "parameter" as const,
  issue: "Time-bar: general warranty claims",
  purpose: "  Bounds how long the seller stays exposed to warranty claims.  ",
  guidance: " Compare the notification window. ",
  severity: "high" as const,
  passages: [{ sourceKey: SOURCE_KEY, blockId: "r-1" }],
  ...overrides,
});

const seeded: Position = {
  mode: "extract",
  sourceId: "55555555-5555-4555-8555-555555555555",
  issue: "Governing law",
  ask: {
    question: "Which law governs?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
};

/** Ids are handed in, so the same model output normalizes identically twice —
 *  which is what lets the streaming and batch paths be compared at all. */
const sequentialIds = () => {
  let next = 0;
  return () => {
    next += 1;
    return `position-${String(next)}`;
  };
};

const normalizePositions = (
  proposedPositions: readonly ReturnType<typeof proposed>[],
  {
    seededPositions = [],
    positionsMax = 10,
  }: { seededPositions?: readonly Position[]; positionsMax?: number } = {},
): ProposedReferencePosition[] =>
  normalizeProposal({
    output: { parties: [], positions: [...proposedPositions], skipped: [] },
    seededPositions,
    sources: [source],
    positionsMax,
    newSourceId: sequentialIds(),
  }).positions;

describe("proposedPositionsSchema", () => {
  // The schema is handed to the provider as JSON Schema; a valibot action
  // with no JSON Schema form (trim, transform) only fails at request time.
  test("converts to provider JSON Schema", () => {
    const schema = toTanStackValibotSchema(proposedPositionsSchema);
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(json).toMatchObject({ type: "object" });
  });

  // Time to the first position is bought here: the sides land before the
  // checklist, and what was left out lands after it.
  test("asks for the sides first and the skips last", () => {
    const schema = toTanStackValibotSchema(proposedPositionsSchema);
    const json = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    expect(Object.keys(json["properties"] ?? {})).toEqual([
      "parties",
      "positions",
      "skipped",
    ]);
  });

  test("refuses a purpose longer than one sentence's worth", () => {
    const tooLong = proposedPositionSchema["~standard"].validate(
      proposed({ purpose: "x".repeat(POSITION_PURPOSE_MAX_LENGTH + 1) }),
    );
    expect(tooLong).toMatchObject({ issues: expect.anything() });
  });
});

describe("parties", () => {
  const parties = (input: readonly { role: string; name: string | null }[]) =>
    normalizeProposal({
      output: { parties: [...input], positions: [], skipped: [] },
      seededPositions: [],
      sources: [source],
      positionsMax: 10,
      newSourceId: sequentialIds(),
    }).parties;

  test("trims parties and omits entries without a role", () => {
    expect(
      parties([
        { role: "  Purchaser  ", name: "  Example Holdings a.s.  " },
        { role: " Seller ", name: "   " },
        { role: "   ", name: "Ignored Entity" },
      ]),
    ).toEqual([
      { role: "Purchaser", name: "Example Holdings a.s." },
      { role: "Seller", name: null },
    ]);
  });

  test("caps normalized parties at the review limit", () => {
    const normalized = parties(
      Array.from({ length: REVIEW_PARTIES_MAX + 2 }, (_, index) => ({
        role: `Party ${String(index + 1)}`,
        name: null,
      })),
    );

    expect(normalized).toHaveLength(REVIEW_PARTIES_MAX);
    expect(normalized.at(-1)?.role).toBe(`Party ${String(REVIEW_PARTIES_MAX)}`);
  });
});

describe("positions", () => {
  test("pins the quoted text, the purpose and the guidance onto the position", () => {
    const [position] = normalizePositions([proposed()]);

    expect(position).toMatchObject({
      mode: "graded",
      issue: "Time-bar: general warranty claims",
      severity: "high",
      purpose: "Bounds how long the seller stays exposed to warranty claims.",
      guidance: "Compare the notification window.",
      ask: { mode: "auto" },
      enabled: true,
      standard: {
        source: "reference",
        termKind: "parameter",
        passages: [
          {
            workspaceId: source.workspaceId,
            entityId: source.entityId,
            fileFieldId: source.file.fileFieldId,
            entityVersionId: source.entityVersionId,
            blockId: "r-1",
            text: CLAIMS_BLOCK,
          },
        ],
      },
    });
  });

  // Absent, not empty: an optional field left blank must not persist as `""`
  // and read as "someone wrote nothing here on purpose".
  test("omits a purpose the model left blank", () => {
    const [position] = normalizePositions([proposed({ purpose: "   " })]);

    expect(position).not.toHaveProperty("purpose");
  });

  // A standard nobody can quote is not a standard: a position whose passages
  // all fail verification is dropped rather than proposed with nothing behind
  // it, since that text is what the run will grade against.
  test("drops a position whose passages the reference does not contain", () => {
    expect(
      normalizePositions([
        proposed({ passages: [{ sourceKey: SOURCE_KEY, blockId: "nope" }] }),
        proposed({
          issue: "Blank block",
          passages: [{ sourceKey: SOURCE_KEY, blockId: "r-2" }],
        }),
        proposed({
          issue: "Unknown document",
          passages: [{ sourceKey: "F9", blockId: "r-1" }],
        }),
        proposed({ issue: "No passages at all", passages: [] }),
      ]),
    ).toEqual([]);
  });

  // Seeded positions are the caller's, not this pass's: they count against
  // dedup and the wire bound but are never repeated in the output — the
  // handler leads the answer with them.
  test("skips an issue the reviewer already has and keeps the rest", () => {
    const positions = normalizePositions(
      [
        proposed({ issue: " governing LAW " }),
        proposed({ issue: "Claims time bar" }),
        proposed({ issue: "claims TIME bar" }),
      ],
      { seededPositions: [seeded] },
    );

    expect(positions.map((position) => position.issue)).toEqual([
      "Claims time bar",
    ]);
  });

  // Every position a blocker is a review nobody can triage. Only a stated
  // quantity — money, a cap, a time bar — walks a deal away by itself.
  test("only a parameter term may be a blocker", () => {
    const positions = normalizePositions([
      proposed({ issue: "Cap: general warranties", severity: "blocker" }),
      proposed({
        issue: "W&I policy",
        termKind: "presence",
        severity: "blocker",
      }),
      proposed({
        issue: "Leakage limbs",
        termKind: "enumeration",
        severity: "blocker",
      }),
      proposed({
        issue: "Fairly Disclosed standard",
        termKind: "language",
        severity: "blocker",
      }),
    ]);

    expect(positions.map((position) => position.severity)).toEqual([
      "blocker",
      "high",
      "high",
      "high",
    ]);
  });

  test("carries the term kind onto the standard it will be graded as", () => {
    const positions = normalizePositions(
      POSITION_TERM_KINDS.map((termKind) =>
        proposed({ issue: `Term ${termKind}`, termKind, severity: "medium" }),
      ),
    );

    expect(positions.map((position) => position.standard.termKind)).toEqual([
      ...POSITION_TERM_KINDS,
    ]);
  });

  // The wire bound, which the seeded positions do count against: past it the
  // request carrying the list would be refused outright.
  test("stops at the hard wire bound", () => {
    const positions = normalizePositions(
      [
        proposed({ issue: "First" }),
        proposed({ issue: "Second" }),
        proposed({ issue: "Third" }),
      ],
      { seededPositions: [seeded], positionsMax: 2 },
    );

    expect(positions.map((position) => position.issue)).toEqual(["First"]);
  });

  // The cap is what a reviewer can read and confirm by hand. A model that
  // keeps writing past it does not get a longer checklist: the remainder is
  // reported as skipped, so the size of what was left out stays visible
  // without the list growing.
  test("reports comparable terms past the proposal cap as skipped", () => {
    const { positions, skipped } = normalizeProposal({
      output: {
        parties: [],
        positions: Array.from({ length: REVIEW_PROPOSAL_CAP + 2 }, (_, index) =>
          proposed({ issue: `Term ${String(index)}` }),
        ),
        skipped: [],
      },
      seededPositions: [],
      sources: [source],
      positionsMax: 200,
      newSourceId: sequentialIds(),
    });

    expect(positions).toHaveLength(REVIEW_PROPOSAL_CAP);
    expect(skipped).toEqual([
      {
        subject: `Term ${String(REVIEW_PROPOSAL_CAP)}`,
        reason: { kind: "lower-weight" },
      },
      {
        subject: `Term ${String(REVIEW_PROPOSAL_CAP + 1)}`,
        reason: { kind: "lower-weight" },
      },
    ]);
  });

  // A reviewer who brought a playbook is asking what the reference adds to
  // it, and must not get a shorter answer than one who brought nothing: the
  // seed counts against the wire bound, never against the proposal cap.
  test("spends the whole proposal cap alongside seeded positions", () => {
    const positions = normalizePositions(
      Array.from({ length: REVIEW_PROPOSAL_CAP }, (_, index) =>
        proposed({ issue: `Term ${String(index)}` }),
      ),
      { seededPositions: [seeded], positionsMax: 200 },
    );

    expect(positions).toHaveLength(REVIEW_PROPOSAL_CAP);
  });
});

describe("cappedSeverity", () => {
  test("leaves every non-blocker severity alone", () => {
    for (const termKind of POSITION_TERM_KINDS) {
      expect(cappedSeverity("high", termKind)).toBe("high");
      expect(cappedSeverity("medium", termKind)).toBe("medium");
      expect(cappedSeverity("low", termKind)).toBe("low");
    }
  });
});

// A locked-box date is not a position; the locked-box PERIOD is. Nothing
// downstream can compare two documents on a value that names one deal, so a
// parameter that quotes nothing else is reported as skipped instead.
describe("deal-specific values", () => {
  test("reads a date or a blank as no comparable value at all", () => {
    expect(statesComparableValue(DATE_BLOCK)).toBe(false);
    expect(statesComparableValue(PLACEHOLDER_BLOCK)).toBe(false);
    expect(statesComparableValue("Completion is on 2026-08-27.")).toBe(false);
    expect(statesComparableValue("The date is 31. 12. 2025.")).toBe(false);
  });

  test("leaves a term stated in figures or in words alone", () => {
    expect(statesComparableValue(CLAIMS_BLOCK)).toBe(true);
    expect(statesComparableValue(WORDED_BLOCK)).toBe(true);
    expect(
      statesComparableValue("Interest accrues at 5% from 1 January 2026."),
    ).toBe(true);
  });

  test("demotes a parameter that quotes only a date or a blank", () => {
    const { positions, skipped } = normalizeProposal({
      output: {
        parties: [],
        positions: [
          proposed({
            issue: "Locked-box date",
            passages: [{ sourceKey: SOURCE_KEY, blockId: "r-3" }],
          }),
          proposed({
            issue: "Long-stop date",
            passages: [{ sourceKey: SOURCE_KEY, blockId: "r-4" }],
          }),
          proposed({
            issue: "Locked-box period length",
            passages: [{ sourceKey: SOURCE_KEY, blockId: "r-5" }],
          }),
        ],
        skipped: [],
      },
      seededPositions: [],
      sources: [source],
      positionsMax: 10,
      newSourceId: sequentialIds(),
    });

    expect(positions.map((position) => position.issue)).toEqual([
      "Locked-box period length",
    ]);
    expect(skipped).toEqual([
      { subject: "Locked-box date", reason: { kind: "deal-specific-value" } },
      { subject: "Long-stop date", reason: { kind: "deal-specific-value" } },
    ]);
  });

  // The rule is about a term claiming to be a measurable quantity. Whether a
  // protection exists, and how a standard is worded, are answerable from a
  // passage that happens to state a date.
  test("leaves a non-parameter term quoting a date alone", () => {
    const positions = normalizePositions([
      proposed({
        issue: "Locked-box mechanism present",
        termKind: "presence",
        passages: [{ sourceKey: SOURCE_KEY, blockId: "r-3" }],
      }),
    ]);

    expect(positions.map((position) => position.issue)).toEqual([
      "Locked-box mechanism present",
    ]);
  });
});

describe("skipped", () => {
  const skips = (input: readonly { subject: string; reason: string }[]) =>
    normalizeProposal({
      output: { parties: [], positions: [], skipped: [...input] },
      seededPositions: [],
      sources: [source],
      positionsMax: 10,
      newSourceId: sequentialIds(),
    }).skipped;

  test("trims, drops half-stated entries, and reports a subject once", () => {
    expect(
      skips([
        {
          subject: "  Signing and closing sequence  ",
          reason: "  Deal mechanics.  ",
        },
        { subject: "signing and closing sequence", reason: "Repeated." },
        { subject: "Schedules", reason: "   " },
        { subject: "   ", reason: "No subject." },
      ]),
    ).toEqual([
      {
        subject: "Signing and closing sequence",
        reason: { kind: "other", text: "Deal mechanics." },
      },
    ]);
  });

  test("codes the reasons the prompt itself hands the model", () => {
    expect(
      skips([
        { subject: "Long-stop date", reason: DEAL_SPECIFIC_VALUE_SKIP_REASON },
        { subject: "Annex list", reason: ` ${STRUCTURAL_SKIP_REASON} ` },
        { subject: "Notary", reason: "Structural" },
        {
          subject: "Interest on late payment",
          reason: LOWER_WEIGHT_SKIP_REASON,
        },
        { subject: "Escrow agent", reason: "Only in the precedent." },
      ]),
    ).toEqual([
      { subject: "Long-stop date", reason: { kind: "deal-specific-value" } },
      { subject: "Annex list", reason: { kind: "structural" } },
      { subject: "Notary", reason: { kind: "structural" } },
      {
        subject: "Interest on late payment",
        reason: { kind: "lower-weight" },
      },
      {
        subject: "Escrow agent",
        reason: { kind: "other", text: "Only in the precedent." },
      },
    ]);
  });

  test("caps what it reports", () => {
    expect(
      skips(
        Array.from({ length: REVIEW_SKIPPED_MAX + 3 }, (_, index) => ({
          subject: `Subject ${String(index)}`,
          reason: "Deal-specific.",
        })),
      ),
    ).toHaveLength(REVIEW_SKIPPED_MAX);
  });
});

// ── Reading an unfinished response ────────────────────

describe("createPartialProposalReader", () => {
  const reader = () =>
    createPartialProposalReader(
      createProposalNormalizer({
        seededPositions: [],
        sources: [source],
        positionsMax: 10,
        newSourceId: sequentialIds(),
      }),
    );

  const first = proposed({ issue: "First" });
  const second = proposed({ issue: "Second" });

  test("holds the sides back until the checklist has started", () => {
    const read = reader();

    expect(read({ parties: [{ role: "Purch", name: null }] }, false)).toEqual(
      [],
    );
    expect(
      read(
        { parties: [{ role: "Purchaser", name: null }], positions: [] },
        false,
      ),
    ).toEqual([
      { type: "parties", parties: [{ role: "Purchaser", name: null }] },
    ]);
    // Reported once, however many partials follow.
    expect(
      read(
        { parties: [{ role: "Purchaser", name: null }], positions: [] },
        false,
      ),
    ).toEqual([]);
  });

  test("does not emit the element the model is still writing", () => {
    const read = reader();

    // The checklist has started, so the sides are closed; the one position in
    // flight is not.
    expect(read({ positions: [first] }, false)).toEqual([
      { type: "parties", parties: [] },
    ]);
    // A half-written sibling closes the first one; itself, it waits.
    const events = read({ positions: [first, { issue: "Sec" }] }, false);
    expect(events).toMatchObject([{ type: "position", index: 0 }]);
    expect(events.at(0)).toMatchObject({ position: { issue: "First" } });
  });

  test("emits an element once it is complete, and never twice", () => {
    const read = reader();

    read({ positions: [first] }, false);
    read({ positions: [first, second] }, false);
    // The following key closes the last element.
    expect(
      read({ positions: [first, second], skipped: [] }, false),
    ).toMatchObject([
      { type: "position", index: 1, position: { issue: "Second" } },
    ]);
    // The finished object repeats everything; nothing is decided twice.
    expect(
      read({ parties: [], positions: [first, second], skipped: [] }, true),
    ).toEqual([]);
  });

  test("indexes positions and skips monotonically from zero", () => {
    const read = reader();
    const events = read(
      {
        parties: [],
        positions: [first, second, proposed({ issue: "Third" })],
        skipped: [
          { subject: "Execution mechanics", reason: "Not comparable." },
          { subject: "Schedule list", reason: "Deal particulars." },
        ],
      },
      true,
    );

    expect(
      events.flatMap((event) =>
        event.type === "parties" ? [] : [[event.type, event.index]],
      ),
    ).toEqual([
      ["position", 0],
      ["position", 1],
      ["position", 2],
      ["skipped", 0],
      ["skipped", 1],
    ]);
  });

  // A truncated element is not a position with missing fields; it is not a
  // position. Nothing half-parsed may reach a reviewer's checklist.
  test("ignores an element that never became valid", () => {
    const read = reader();

    expect(
      read(
        { positions: [{ issue: "Only an issue" }, first, {}], skipped: [] },
        false,
      ),
    ).toMatchObject([
      { type: "parties" },
      { type: "position", index: 0, position: { issue: "First" } },
    ]);
  });
});

// The point of one normalizer behind two endpoints: a reviewer who confirms a
// streamed checklist and a reviewer who waits for the batch response are
// confirming the same list.
describe("streamed and batched proposals agree", () => {
  const output: ProposedPositions = {
    parties: [
      { role: "Purchaser", name: "Example Holdings a.s." },
      { role: "Seller", name: null },
    ],
    positions: [
      proposed({ issue: "Cap: general warranties", severity: "blocker" }),
      proposed({
        issue: "Locked-box date",
        passages: [{ sourceKey: SOURCE_KEY, blockId: "r-3" }],
      }),
      proposed({ issue: "Cap: GENERAL warranties" }),
      proposed({
        issue: "Leakage limbs",
        termKind: "enumeration",
        severity: "blocker",
      }),
      proposed({ issue: "Unquotable", passages: [] }),
    ],
    skipped: [{ subject: "Execution mechanics", reason: "Not comparable." }],
  };

  test("produce the same positions, skips and sides for the same raw output", () => {
    const batched = normalizeProposal({
      output,
      seededPositions: [seeded],
      sources: [source],
      positionsMax: 10,
      newSourceId: sequentialIds(),
    });

    const read = createPartialProposalReader(
      createProposalNormalizer({
        seededPositions: [seeded],
        sources: [source],
        positionsMax: 10,
        newSourceId: sequentialIds(),
      }),
    );
    const streamed: ReviewProposalEvent[] = [];
    // One partial per element the provider closes, then the finished object.
    for (let count = 1; count <= output.positions.length; count += 1) {
      streamed.push(
        ...read(
          {
            parties: output.parties,
            positions: output.positions.slice(0, count),
          },
          false,
        ),
      );
    }
    streamed.push(...read(output, true));

    expect(
      streamed.flatMap((event) =>
        event.type === "position" ? [event.position] : [],
      ),
    ).toEqual(batched.positions);
    expect(
      streamed.flatMap((event) =>
        event.type === "skipped" ? [event.skipped] : [],
      ),
    ).toEqual(batched.skipped);
    expect(
      streamed.flatMap((event) =>
        event.type === "parties" ? [event.parties] : [],
      ),
    ).toEqual([batched.parties]);
  });
});
