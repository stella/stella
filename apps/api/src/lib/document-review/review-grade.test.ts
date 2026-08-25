import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { AskExtraction } from "@/api/lib/document-review/review-extract";
import type {
  Position,
  ResolvedTiers,
} from "@/api/lib/workflow/playbook-positions";

const realVerdictEngine = await import("@/api/lib/workflow/verdict-engine");

let modelCallCount = 0;
let abortAfterFirstCall: AbortController | null = null;
let returnVerdicts = true;
const gradeTierMatchesMock = mock(
  async ({
    items,
  }: Parameters<typeof realVerdictEngine.gradeTierMatches>[0]) => {
    modelCallCount += 1;
    if (modelCallCount === 1) {
      abortAfterFirstCall?.abort();
    }
    const verdicts = returnVerdicts
      ? new Map(
          items.map(({ key }) => [
            key,
            {
              tier: "deviation" as const,
              rationale: "The extracted value differs from the standard.",
            },
          ]),
        )
      : new Map();
    return await Promise.resolve(Result.ok(verdicts));
  },
);

void mock.module("@/api/lib/workflow/verdict-engine", () => ({
  ...realVerdictEngine,
  gradeTierMatches: gradeTierMatchesMock,
}));

const { buildFindings } =
  await import("@/api/lib/document-review/review-grade");

const ORGANIZATION_ID = toSafeId<"organization">(
  "11111111-1111-4111-8111-111111111111",
);
const WORKSPACE_ID = toSafeId<"workspace">(
  "22222222-2222-4222-8222-222222222222",
);
const ENTITY_VERSION_ID = toSafeId<"entityVersion">(
  "33333333-3333-4333-8333-333333333333",
);
const FILE_FIELD_ID = toSafeId<"field">("44444444-4444-4444-8444-444444444444");

const sourceId = (index: number): string =>
  `55555555-5555-4555-8555-${String(index).padStart(12, "0")}`;

const position = (index: number): Position => ({
  mode: "graded",
  sourceId: sourceId(index),
  issue: `Position ${index}`,
  severity: "high",
  tiers: {
    acceptable: {
      rules: [],
      ideal: { source: "inline", text: "Thirty days' written notice." },
    },
    fallback: { entries: [] },
    notAcceptable: { rules: [] },
  },
  ask: {
    mode: "manual",
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
});

const extraction = (): AskExtraction => ({
  content: { version: 1, type: "text", value: "Ten days" },
  citations: [
    {
      kind: "docx-folio",
      fileFieldId: FILE_FIELD_ID,
      blockId: "paragraph-1",
      text: "Ten days' written notice.",
      statement: "Ten days' written notice.",
    },
  ],
});

const resolvedTiers: ResolvedTiers = {
  ideal: "Thirty days' written notice.",
  fallbacks: [],
  acceptableRules: [],
  notAcceptableRules: [],
};

const buildArgs = (
  positions: readonly Position[],
  abortSignal: AbortSignal,
) => ({
  positions,
  contentBySourceId: new Map(
    positions.map(({ sourceId: id }) => [id, extraction()]),
  ),
  tiersBySourceId: new Map(
    positions.map(({ sourceId: id }) => [id, resolvedTiers]),
  ),
  abortSignal,
  organizationId: ORGANIZATION_ID,
  workspaceId: WORKSPACE_ID,
  entityVersionId: ENTITY_VERSION_ID,
  orgAIConfig: null,
  promptCachingEnabled: false,
  serviceTier: "standard" as const,
});

beforeEach(() => {
  modelCallCount = 0;
  abortAfterFirstCall = null;
  returnVerdicts = true;
  gradeTierMatchesMock.mockClear();
});

describe("document review grading", () => {
  test("does not propose a fix when model grading produced no verdict", async () => {
    returnVerdicts = false;

    const findings = await buildFindings(
      buildArgs([position(1)], new AbortController().signal),
    );

    expect(findings.at(0)).toMatchObject({
      verdict: "deviation",
      rationale:
        "Automated comparison against the standard could not be completed.",
      fix: null,
    });
  });

  test("stops after cancellation and preserves completed-batch grading", async () => {
    const controller = new AbortController();
    abortAfterFirstCall = controller;
    const positions = Array.from(
      { length: realVerdictEngine.TIER_MATCH_BATCH_SIZE + 1 },
      (_, index) => position(index + 1),
    );

    const findings = await buildFindings(
      buildArgs(positions, controller.signal),
    );

    expect(modelCallCount).toBe(1);
    expect(findings.at(0)).toMatchObject({
      rationale: "The extracted value differs from the standard.",
      fix: {
        kind: "replaceBlock",
        blockId: "paragraph-1",
        text: "Thirty days' written notice.",
      },
    });
    expect(findings.at(-1)).toMatchObject({
      rationale:
        "Automated comparison against the standard could not be completed.",
      fix: null,
    });
  });
});
