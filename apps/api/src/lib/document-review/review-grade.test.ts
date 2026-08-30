import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import {
  type gradeReferencePositions,
  REFERENCE_GRADE_BATCH_SIZE,
  ungradedReferenceGrading,
} from "@/api/lib/document-review/reference-grade";
import type { AskExtraction } from "@/api/lib/document-review/review-extract";
import { buildFindings } from "@/api/lib/document-review/review-grade";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type {
  Position,
  ResolvedTiers,
} from "@/api/lib/workflow/playbook-positions";
import {
  type gradeTierMatches,
  TIER_MATCH_BATCH_SIZE,
} from "@/api/lib/workflow/verdict-engine";

let modelCallCount = 0;
let abortAfterFirstCall: AbortController | null = null;
let returnVerdicts = true;
const gradeTierMatchesMock = mock(
  async ({ items }: Parameters<typeof gradeTierMatches>[0]) => {
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

/** One call the reference grader made, still unresolved: the test decides
 *  when (and in what order) it lands. */
type ReferenceGradeCall = {
  positions: Parameters<typeof gradeReferencePositions>[0]["positions"];
  resolve: (value: Awaited<ReturnType<typeof gradeReferencePositions>>) => void;
};

let referenceGradeCalls: ReferenceGradeCall[] = [];
const gradeReferencePositionsMock = mock(
  async ({ positions }: Parameters<typeof gradeReferencePositions>[0]) =>
    await new Promise<Awaited<ReturnType<typeof gradeReferencePositions>>>(
      (resolve) => {
        referenceGradeCalls.push({ positions, resolve });
      },
    ),
);

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
  standard: {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: [],
        ideal: { source: "inline", text: "Thirty days' written notice." },
      },
      fallback: { entries: [] },
      notAcceptable: { rules: [] },
    },
  },
  ask: {
    mode: "manual",
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
  },
  enabled: true,
});

const referencePosition = (index: number): Position => ({
  mode: "graded",
  sourceId: sourceId(index),
  issue: `Reference position ${index}`,
  severity: "high",
  standard: {
    source: "reference",
    termKind: "language",
    passages: [
      {
        workspaceId: WORKSPACE_ID,
        entityId: toSafeId<"entity">("77777777-7777-4777-8777-777777777777"),
        fileFieldId: FILE_FIELD_ID,
        entityVersionId: ENTITY_VERSION_ID,
        blockId: `ref-block-${index}`,
        text: `Standard clause ${index}.`,
      },
    ],
  },
  ask: { mode: "auto" },
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

// Grading a tier standard never meters: `gradeTierMatches` is mocked and no
// reference standard is in play, so this handle is never called.
const unreachableSafeDb: SafeDb = () =>
  panic("review grading metered a call the test did not expect");

const target: PreparedDocxFile = {
  kind: "docx",
  fileFieldId: FILE_FIELD_ID,
  fileId: "file-1",
  blocks: [
    { kind: "paragraph", id: "paragraph-1", text: "Ten days' written notice." },
  ],
  simplifiedName: "F0",
};

/** What a caller was handed, batch by batch, while the pass was still
 *  running: the run worker commits exactly this, so progress is durable
 *  before the last model call returns. */
let gradedBatches: string[][] = [];

const buildArgs = (
  positions: readonly Position[],
  abortSignal: AbortSignal,
) => ({
  positions,
  onGraded: async (findings: readonly { positionId: string }[]) => {
    gradedBatches.push(findings.map(({ positionId }) => positionId));
    await Promise.resolve();
  },
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
  usageMetering: {
    actionType: "doc_review" as const,
    organizationId: ORGANIZATION_ID,
    safeDb: unreachableSafeDb,
    serviceTier: "standard" as const,
    userId: toSafeId<"user">("66666666-6666-4666-8666-666666666666"),
    workspaceId: WORKSPACE_ID,
  },
  target,
  perspective: NEUTRAL_PERSPECTIVE,
  referenceEntityVersionIds: [],
  gradeTierMatches: gradeTierMatchesMock,
  gradeReferencePositions: gradeReferencePositionsMock,
});

beforeEach(() => {
  modelCallCount = 0;
  abortAfterFirstCall = null;
  returnVerdicts = true;
  gradedBatches = [];
  gradeTierMatchesMock.mockClear();
  referenceGradeCalls = [];
  gradeReferencePositionsMock.mockClear();
});

describe("document review grading", () => {
  test("does not propose a fix when model grading produced no verdict", async () => {
    returnVerdicts = false;

    const findings = await buildFindings(
      buildArgs([position(1)], new AbortController().signal),
    );

    expect(findings.at(0)).toMatchObject({
      verdict: "deviation",
      standardSource: "tiers",
      delta: { kind: "language" },
      rationale:
        "Automated comparison against the standard could not be completed.",
      fix: null,
    });
  });

  test("stops after cancellation and preserves completed-batch grading", async () => {
    const controller = new AbortController();
    abortAfterFirstCall = controller;
    const positions = Array.from(
      { length: TIER_MATCH_BATCH_SIZE + 1 },
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

  // The reviewer polls `completed/total`. A pass that hands nothing over until
  // its last model call returns leaves that number at zero for the whole run.
  test("hands each batch over as it is graded, not once at the end", async () => {
    const positions = Array.from(
      { length: TIER_MATCH_BATCH_SIZE + 1 },
      (_, index) => position(index + 1),
    );

    const findings = await buildFindings(
      buildArgs(positions, new AbortController().signal),
    );

    expect(modelCallCount).toBe(2);
    expect(gradedBatches).toHaveLength(2);
    expect(gradedBatches.at(0)).toHaveLength(TIER_MATCH_BATCH_SIZE);
    expect(gradedBatches.at(1)).toHaveLength(1);
    // Every position reaches a caller before the pass returns, and the return
    // value is still the whole set in position order.
    expect(gradedBatches.flat()).toEqual(
      positions.map(({ sourceId: id }) => id),
    );
    expect(findings.map(({ positionId }) => positionId)).toEqual(
      positions.map(({ sourceId: id }) => id),
    );
  });

  // Reference-standard batches run with bounded concurrency: several model
  // calls are in flight together, so they do not necessarily land in the
  // order they were launched. `onGraded` still has to fire once per batch as
  // it lands, and the pass's return value still has to read as one ordered
  // set regardless of which model call happened to finish first.
  test("hands reference batches over as each resolves, out of launch order, but keeps the final findings in position order", async () => {
    const positions = Array.from(
      { length: REFERENCE_GRADE_BATCH_SIZE * 2 + 1 },
      (_, index) => referencePosition(index + 1),
    );

    const resultPromise = buildFindings(
      buildArgs(positions, new AbortController().signal),
    );

    // Bounded concurrency (3) means all three batches launch before any of
    // them resolves.
    expect(referenceGradeCalls).toHaveLength(3);

    const gradingFor = (
      call: (typeof referenceGradeCalls)[number],
    ): Awaited<ReturnType<typeof gradeReferencePositions>> =>
      Result.ok(
        new Map(
          call.positions.map((referencedPosition) => [
            referencedPosition.sourceId,
            ungradedReferenceGrading(referencedPosition),
          ]),
        ),
      );

    // Resolve out of the order the batches were launched in.
    const [first, second, third] = referenceGradeCalls;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("expected three reference-grading batches");
    }
    third.resolve(gradingFor(third));
    first.resolve(gradingFor(first));
    second.resolve(gradingFor(second));

    const findings = await resultPromise;

    const expectedOrder = positions.map(({ sourceId: id }) => id);
    expect(gradedBatches).toHaveLength(3);
    // The hand-off order tracked completion, not launch order.
    expect(gradedBatches.flat()).not.toEqual(expectedOrder);
    expect(gradedBatches.flat().toSorted()).toEqual([...expectedOrder].sort());
    // The final findings are still in the positions' original order.
    expect(findings.map(({ positionId }) => positionId)).toEqual(expectedOrder);
  });
});
