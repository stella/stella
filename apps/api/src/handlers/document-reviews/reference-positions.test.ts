/**
 * A proposed position is only as good as the passages it quotes: what the
 * model returns is a claim about the reference documents, and everything below
 * is about holding it to them.
 */

import { describe, expect, test } from "bun:test";

import {
  normalizeParties,
  normalizeProposedPositions,
  proposedPositionsSchema,
} from "@/api/handlers/document-reviews/reference-positions";
import type { ReferenceSource } from "@/api/handlers/document-reviews/reference-positions";
import { toSafeId } from "@/api/lib/branded-types";
import { REVIEW_PARTIES_MAX } from "@/api/lib/document-review/contract";
import { toTanStackValibotSchema } from "@/api/lib/tanstack-ai-schema";
import type { Position } from "@/api/lib/workflow/playbook-positions";

const SOURCE_KEY = "F1";
const CLAIMS_BLOCK = "Claims must be notified within 6 months of Completion.";

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
    ],
    simplifiedName: SOURCE_KEY,
  },
};

const proposed = (overrides: Record<string, unknown> = {}) => ({
  issue: "Claims time bar",
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
});

describe("normalizeParties", () => {
  test("trims parties and omits entries without a role", () => {
    expect(
      normalizeParties([
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
    const parties = Array.from(
      { length: REVIEW_PARTIES_MAX + 2 },
      (_, index) => ({ role: `Party ${index + 1}`, name: null }),
    );

    const normalized = normalizeParties(parties);

    expect(normalized).toHaveLength(REVIEW_PARTIES_MAX);
    expect(normalized.at(-1)?.role).toBe(`Party ${REVIEW_PARTIES_MAX}`);
  });
});

describe("normalizeProposedPositions", () => {
  test("pins the quoted text onto the position it proposes", () => {
    const [position] = normalizeProposedPositions({
      proposed: [proposed()],
      seededPositions: [],
      sources: [source],
      positionsMax: 10,
    });

    expect(position).toMatchObject({
      mode: "graded",
      issue: "Claims time bar",
      severity: "high",
      guidance: "Compare the notification window.",
      ask: { mode: "auto" },
      enabled: true,
      standard: {
        source: "reference",
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

  // A standard nobody can quote is not a standard: a position whose passages
  // all fail verification is dropped rather than proposed with nothing behind
  // it, since that text is what the run will grade against.
  test("drops a position whose passages the reference does not contain", () => {
    expect(
      normalizeProposedPositions({
        proposed: [
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
        ],
        seededPositions: [],
        sources: [source],
        positionsMax: 10,
      }),
    ).toEqual([]);
  });

  test("keeps what the reviewer already had and skips repeated issues", () => {
    const positions = normalizeProposedPositions({
      proposed: [
        proposed({ issue: " governing LAW " }),
        proposed({ issue: "Claims time bar" }),
        proposed({ issue: "claims TIME bar" }),
      ],
      seededPositions: [seeded],
      sources: [source],
      positionsMax: 10,
    });

    expect(positions.map((position) => position.issue)).toEqual([
      "Governing law",
      "Claims time bar",
    ]);
  });

  test("stops at the position cap", () => {
    const positions = normalizeProposedPositions({
      proposed: [
        proposed({ issue: "First" }),
        proposed({ issue: "Second" }),
        proposed({ issue: "Third" }),
      ],
      seededPositions: [seeded],
      sources: [source],
      positionsMax: 2,
    });

    expect(positions.map((position) => position.issue)).toEqual([
      "Governing law",
      "First",
    ]);
  });
});
