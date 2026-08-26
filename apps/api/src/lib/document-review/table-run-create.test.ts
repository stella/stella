/**
 * What a table run promises to produce.
 *
 * The run's `total` and its completion predicate both come from the plan, while
 * the findings that satisfy them come from the verdict columns
 * `materializePlaybookRun` emits. Nothing forces those two derivations to
 * agree, so the invariant below states it directly: for the `table` executor,
 * the promised finding count is exactly the number of verdict columns a
 * materialized run can grade. A position class that starts or stops
 * materializing a verdict fails here instead of leaving every run of that
 * playbook permanently unfinished.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { NEUTRAL_PERSPECTIVE } from "@/api/lib/document-review/contract";
import type {
  DocumentReviewRunBasis,
  PinnedPlaybook,
} from "@/api/lib/document-review/run-contract";
import { planReviewRun } from "@/api/lib/document-review/run-plan";
import type {
  Position,
  ReferencePassage,
  Tiers,
} from "@/api/lib/workflow/playbook-positions";
import {
  isTierStandard,
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
const REFERENCE_ID = "66666666-6666-4666-8666-666666666666";

const passage: ReferencePassage = {
  workspaceId: Bun.randomUUIDv7(),
  entityId: Bun.randomUUIDv7(),
  fileFieldId: Bun.randomUUIDv7(),
  entityVersionId: Bun.randomUUIDv7(),
  blockId: "b-1",
  text: "Thirty days' written notice.",
};

const positions: Position[] = [
  {
    mode: "graded",
    sourceId: GRADED_ID,
    issue: "Termination notice",
    severity: "high",
    standard: { source: "tiers", tiers },
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
    standard: { source: "tiers", tiers },
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
    standard: { source: "tiers", tiers },
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
    standard: { source: "tiers", tiers },
    ask: {
      mode: "manual",
      question: "Is the long issue graded?",
      content: textContent,
    },
    enabled: true,
  },
  {
    // A reference standard has no ladder to materialize into a column, so the
    // table path cannot grade it.
    mode: "graded",
    sourceId: REFERENCE_ID,
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
];

const playbook: PinnedPlaybook = {
  definitionId: toSafeId<"playbookDefinition">(Bun.randomUUIDv7()),
  versionId: toSafeId<"playbookDefinitionVersion">(Bun.randomUUIDv7()),
  provenance: "approved",
  definitionSnapshot: {
    name: "Approved playbook",
    positions: { version: 3, items: positions },
  },
};

/** What `materializePlaybookRun` emits a verdict column for, and what
 *  `computeVerdictBatch` can therefore decide: an enabled tier-standard
 *  position whose ask actually extracts a value. */
const gradeableVerdictColumns = (items: readonly Position[]): number =>
  selectEnabledPositions(items).filter((position) => {
    if (!isTierStandard(position)) {
      return false;
    }
    const ask = resolveEffectiveAsk(position);
    return ask.question.trim().length > 0 && ask.content.type !== "file";
  }).length;

const basis: DocumentReviewRunBasis = {
  playbook,
  references: [],
  perspective: NEUTRAL_PERSPECTIVE,
};

describe("planReviewRun over a table run", () => {
  test("a table run promises exactly the findings its verdict columns can produce", () => {
    const plan = planReviewRun({ basis, executor: "table" });

    expect(plan.expectedFindingCount).toBe(gradeableVerdictColumns(positions));
    expect(plan.positions.map((planned) => planned.positionId)).toEqual([
      GRADED_ID,
      LONG_TITLE_ID,
    ]);
  });

  test("the worker also carries extract-only and reference positions", () => {
    // With no columns, a finding is the only place an extracted value can
    // live, so the value positions come along and land as findings with no
    // verdict; a reference standard is compared against the document itself.
    const plan = planReviewRun({ basis, executor: "worker" });

    expect(plan.positions.map((planned) => planned.positionId)).toEqual([
      GRADED_ID,
      EXTRACT_ID,
      LONG_TITLE_ID,
      REFERENCE_ID,
    ]);
  });

  test("a planned title fits the finding column", () => {
    const plan = planReviewRun({ basis, executor: "table" });

    expect(plan.positions.at(0)?.title).toBe("Termination notice");
    // `document_review_findings.position_title` is varchar(256); an over-long
    // issue must not fail the insert of every finding for that position.
    expect(plan.positions.at(-1)?.title.length).toBe(256);
  });
});
