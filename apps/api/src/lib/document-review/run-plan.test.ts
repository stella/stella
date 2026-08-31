import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type {
  PlaybookPositions,
  ReferencePassage,
} from "@/api/lib/workflow/playbook-positions";

const GRADEABLE_POSITION_ID = "11111111-1111-4111-8111-111111111111";
const UNANSWERABLE_POSITION_ID = "22222222-2222-4222-8222-222222222222";
const DISABLED_POSITION_ID = "33333333-3333-4333-8333-333333333333";
const REFERENCE_POSITION_ID = "77777777-7777-4777-8777-777777777777";

const textContent = { version: 1, type: "text" } as const;

const passage: ReferencePassage = {
  id: Bun.randomUUIDv7(),
  workspaceId: Bun.randomUUIDv7(),
  entityId: Bun.randomUUIDv7(),
  fileFieldId: Bun.randomUUIDv7(),
  entityVersionId: Bun.randomUUIDv7(),
  blockId: "b-1",
};

const positions: PlaybookPositions = {
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: GRADEABLE_POSITION_ID,
      issue: "Termination notice",
      ask: { question: "What is the notice period?", content: textContent },
      enabled: true,
    },
    {
      // An empty question extracts nothing, so grading never emits a finding
      // for it; promising one would leave the run permanently incomplete.
      mode: "extract",
      sourceId: UNANSWERABLE_POSITION_ID,
      issue: "Unanswerable",
      ask: { question: "   ", content: textContent },
      enabled: true,
    },
    {
      mode: "extract",
      sourceId: DISABLED_POSITION_ID,
      issue: "Retired position",
      ask: { question: "Is this still required?", content: textContent },
      enabled: false,
    },
    {
      // A reference standard carries no ASK: the worker compares it against
      // the document's own blocks.
      mode: "graded",
      sourceId: REFERENCE_POSITION_ID,
      issue: "Claims time bar",
      severity: "high",
      standard: {
        source: "reference",
        termKind: "parameter",
        passages: [passage],
      },
      ask: { mode: "auto" },
      enabled: true,
    },
  ],
};

const playbook: PinnedPlaybook = {
  definitionId: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
  versionId: toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7()),
  provenance: "approved",
  definitionSnapshot: { name: "Approved playbook", positions },
};

const reference: PinnedReference = {
  workspaceId: toSafeId<"workspace">(Bun.randomUUIDv7()),
  workspaceName: "Precedent matter",
  entityId: toSafeId<"entity">(Bun.randomUUIDv7()),
  fileFieldId: toSafeId<"field">(Bun.randomUUIDv7()),
  entityVersionId: toSafeId<"entityVersion">(Bun.randomUUIDv7()),
  contentSha256: "a".repeat(64),
  name: "Precedent SPA",
};

const basis: DocumentReviewRunBasis = {
  playbook,
  references: [reference],
  perspective: { type: "party", role: "Buyer", name: null },
};

describe("planReviewRun", () => {
  test("the worker plans every enabled position it can answer", () => {
    const plan = planReviewRun({ basis, executor: "worker" });

    expect(plan.positions.map((planned) => planned.positionId)).toEqual([
      GRADEABLE_POSITION_ID,
      REFERENCE_POSITION_ID,
    ]);
    expect(plan.expectedFindingCount).toBe(2);
  });

  test("the plan carries the title its finding row will hold", () => {
    const plan = planReviewRun({ basis, executor: "worker" });

    expect(plan.positions.map((planned) => planned.title)).toEqual([
      "Termination notice",
      "Claims time bar",
    ]);
  });

  test("the table path plans only graded tier-standard positions", () => {
    // It grades through materialized verdict columns: an extract position has
    // none, and a reference standard cannot fill one.
    const plan = planReviewRun({ basis, executor: "table" });

    expect(plan.positions).toEqual([]);
    expect(plan.expectedFindingCount).toBe(0);
  });

  test("a basis with no enabled position promises nothing", () => {
    const plan = planReviewRun({
      basis: {
        playbook: {
          definitionId: null,
          versionId: null,
          provenance: "ephemeral",
          definitionSnapshot: {
            name: "Positions confirmed for this review",
            positions: { version: 3, items: [] },
          },
        },
        references: [],
        perspective: NEUTRAL_PERSPECTIVE,
      },
      executor: "worker",
    });

    expect(plan.expectedFindingCount).toBe(0);
  });
});
