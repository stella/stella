/**
 * What a table run promises to produce.
 *
 * The run's `total` and its completion predicate both come from planning the
 * topics built here, while the findings that satisfy them come from the verdict
 * columns `materializePlaybookRun` emits. Nothing forces those two derivations
 * to agree, so the invariant below states it directly: under the `columns`
 * projection, the promised finding count is exactly the number of verdict
 * columns a materialized run can grade. A position class that starts or stops
 * materializing a verdict fails here instead of leaving every run of that
 * playbook permanently unfinished.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import type { PinnedPlaybook } from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import { buildTableRunTopics } from "@/api/lib/document-review/table-run-create";
import type { Position, Tiers } from "@/api/lib/workflow/playbook-positions";
import {
  resolveEffectiveAsk,
  selectEnabledPositions,
} from "@/api/lib/workflow/position-runtime";

const textContent = { version: 1, type: "text" } as const;
const fileContent = { version: 1, type: "file" } as const;

const tiers: Tiers = {
  acceptable: {
    rules: [],
    ideal: { source: "inline", text: "Thirty days' written notice." },
  },
  fallback: { entries: [] },
  notAcceptable: { rules: [] },
};

const GRADED_ID = "11111111-1111-4111-8111-111111111111";
const GRADED_FILE_ASK_ID = "22222222-2222-4222-8222-222222222222";
const EXTRACT_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED_GRADED_ID = "44444444-4444-4444-8444-444444444444";
const LONG_TITLE_ID = "55555555-5555-4555-8555-555555555555";

const positions: Position[] = [
  {
    mode: "graded",
    sourceId: GRADED_ID,
    issue: "Termination notice",
    severity: "high",
    tiers,
    ask: {
      mode: "manual",
      question: "What is the notice period?",
      content: textContent,
    },
    enabled: true,
  },
  {
    // A file-typed ask extracts nothing the grader can read, so no finding is
    // ever emitted for it.
    mode: "graded",
    sourceId: GRADED_FILE_ASK_ID,
    issue: "Signed counterpart",
    severity: "low",
    tiers,
    ask: {
      mode: "manual",
      question: "Attach the counterpart",
      content: fileContent,
    },
    enabled: true,
  },
  {
    mode: "extract",
    sourceId: EXTRACT_ID,
    issue: "Counterparty name",
    ask: { question: "Who is the counterparty?", content: textContent },
    enabled: true,
  },
  {
    mode: "graded",
    sourceId: DISABLED_GRADED_ID,
    issue: "Retired position",
    severity: "medium",
    tiers,
    ask: {
      mode: "manual",
      question: "Is this still required?",
      content: textContent,
    },
    enabled: false,
  },
  {
    mode: "graded",
    sourceId: LONG_TITLE_ID,
    issue: "L".repeat(300),
    severity: "medium",
    tiers,
    ask: {
      mode: "manual",
      question: "Is the long issue graded?",
      content: textContent,
    },
    enabled: true,
  },
];

const playbook: PinnedPlaybook = {
  definitionId: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
  versionId: toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7()),
  provenance: "approved",
  definitionSnapshot: {
    name: "Approved playbook",
    positions: { version: 2, items: positions },
  },
};

/** What `materializePlaybookRun` emits a verdict column for, and what
 *  `computeVerdictBatch` can therefore decide: an enabled graded position whose
 *  ask actually extracts a value. */
const gradeableVerdictColumns = (items: readonly Position[]): number =>
  selectEnabledPositions(items).filter((position) => {
    if (position.mode !== "graded") {
      return false;
    }
    const ask = resolveEffectiveAsk(position);
    return ask.question.trim().length > 0 && ask.content.type !== "file";
  }).length;

describe("buildTableRunTopics", () => {
  test("a projected run promises exactly the findings its verdict columns can produce", () => {
    const topics = buildTableRunTopics(positions, "columns");
    const plan = planReviewRun({
      basis: { type: "playbook", playbook },
      topics,
    });

    expect(plan.expectedFindingCount).toBe(gradeableVerdictColumns(positions));
    expect(plan.playbookChecks.map((check) => check.positionId)).toEqual([
      GRADED_ID,
      LONG_TITLE_ID,
    ]);
  });

  test("an unprojected run also carries extract-only positions", () => {
    // With no columns, a finding is the only place an extracted value can
    // live, so the value positions come along and land as findings with no
    // verdict.
    const topics = buildTableRunTopics(positions, "none");
    expect(topics.map((topic) => topic.topicId)).toEqual([
      GRADED_ID,
      GRADED_FILE_ASK_ID,
      EXTRACT_ID,
      LONG_TITLE_ID,
    ]);
  });

  test("a topic is its position, and its title fits the finding column", () => {
    const topics = buildTableRunTopics(positions, "columns");
    const first = topics.at(0);

    expect(first).toEqual({
      type: "playbook",
      topicId: GRADED_ID,
      positionId: GRADED_ID,
      title: "Termination notice",
      context: "",
      included: true,
    });
    // `document_review_findings.topic_title` is varchar(256); an over-long
    // issue must not fail the insert of every finding for that position.
    expect(topics.at(-1)?.title.length).toBe(256);
  });
});
