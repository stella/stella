import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { DocumentReviewTopic } from "@/api/lib/document-review/contract";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
  PinnedReference,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";

const GRADEABLE_POSITION_ID = "11111111-1111-4111-8111-111111111111";
const UNANSWERABLE_POSITION_ID = "22222222-2222-4222-8222-222222222222";
const DISABLED_POSITION_ID = "33333333-3333-4333-8333-333333333333";
const GRADEABLE_TOPIC_ID = "44444444-4444-4444-8444-444444444444";
const UNANSWERABLE_TOPIC_ID = "55555555-5555-4555-8555-555555555555";
const DISABLED_TOPIC_ID = "66666666-6666-4666-8666-666666666666";
const REFERENCE_TOPIC_ID = "77777777-7777-4777-8777-777777777777";

const textContent = { version: 1, type: "text" } as const;

const positions: PlaybookPositions = {
  version: 2,
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

const playbookTopic = (
  topicId: string,
  positionId: string,
  included = true,
): DocumentReviewTopic => ({
  type: "playbook",
  topicId,
  positionId,
  title: `Topic ${topicId}`,
  context: "",
  included,
});

const referenceTopic = (
  topicId: string,
  included = true,
): DocumentReviewTopic => ({
  type: "reference",
  topicId,
  title: `Topic ${topicId}`,
  context: "",
  included,
});

const allTopics: DocumentReviewTopic[] = [
  playbookTopic(GRADEABLE_TOPIC_ID, GRADEABLE_POSITION_ID),
  playbookTopic(UNANSWERABLE_TOPIC_ID, UNANSWERABLE_POSITION_ID),
  playbookTopic(DISABLED_TOPIC_ID, DISABLED_POSITION_ID),
  referenceTopic(REFERENCE_TOPIC_ID),
];

describe("planReviewRun", () => {
  test("plans one playbook check per confirmed, executable position", () => {
    const basis: DocumentReviewRunBasis = { type: "playbook", playbook };
    const plan = planReviewRun({ basis, topics: allTopics });

    expect(plan.playbookChecks.map((check) => check.positionId)).toEqual([
      GRADEABLE_POSITION_ID,
    ]);
    expect(plan.referenceTopics).toEqual([]);
    expect(plan.expectedFindingCount).toBe(1);
  });

  test("compares every confirmed topic when the basis pins references", () => {
    const basis: DocumentReviewRunBasis = {
      type: "references",
      references: [reference],
      perspective: { type: "party", role: "Buyer", name: null },
    };
    const plan = planReviewRun({ basis, topics: allTopics });

    expect(plan.playbookChecks).toEqual([]);
    expect(plan.referenceTopics.map((topic) => topic.topicId)).toEqual([
      GRADEABLE_TOPIC_ID,
      UNANSWERABLE_TOPIC_ID,
      DISABLED_TOPIC_ID,
      REFERENCE_TOPIC_ID,
    ]);
    expect(plan.expectedFindingCount).toBe(4);
  });

  test("a combined basis expects both kinds for the same topics", () => {
    const basis: DocumentReviewRunBasis = {
      type: "combined",
      playbook,
      references: [reference],
      perspective: { type: "party", role: "Buyer", name: null },
    };
    const plan = planReviewRun({ basis, topics: allTopics });

    // One playbook finding for the single executable position plus one
    // comparison finding per confirmed topic: the exact row count the worker
    // must observe before it may complete the run.
    expect(plan.expectedFindingCount).toBe(5);
  });

  test("an unconfirmed topic is planned for neither kind", () => {
    const basis: DocumentReviewRunBasis = {
      type: "combined",
      playbook,
      references: [reference],
      perspective: { type: "party", role: "Buyer", name: null },
    };
    const plan = planReviewRun({
      basis,
      topics: [
        playbookTopic(GRADEABLE_TOPIC_ID, GRADEABLE_POSITION_ID, false),
        referenceTopic(REFERENCE_TOPIC_ID),
      ],
    });

    expect(plan.playbookChecks).toEqual([]);
    expect(plan.referenceTopics.map((topic) => topic.topicId)).toEqual([
      REFERENCE_TOPIC_ID,
    ]);
    expect(plan.expectedFindingCount).toBe(1);
  });

  test("a playbook topic naming an unknown position is not planned", () => {
    const basis: DocumentReviewRunBasis = { type: "playbook", playbook };
    const plan = planReviewRun({
      basis,
      topics: [
        playbookTopic(
          GRADEABLE_TOPIC_ID,
          "88888888-8888-4888-8888-888888888888",
        ),
      ],
    });

    expect(plan.expectedFindingCount).toBe(0);
  });
});
