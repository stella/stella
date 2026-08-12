import { describe, expect, test } from "bun:test";

import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { WORKFLOW_START_STATUSES } from "@/api/lib/workflow-queue";

const OUTCOMES = Object.values(PLAYBOOK_RUN_START_OUTCOME);

describe("classifying a playbook run's workflow start", () => {
  test("every status the queue can answer is classified", () => {
    // Totality at runtime as well as in the type: a status the map missed
    // would classify as undefined, and every caller's `=== NOT_STARTED` check
    // would quietly pass it as a success.
    for (const status of WORKFLOW_START_STATUSES) {
      expect(OUTCOMES).toContain(playbookRunStartOutcome(status));
    }
  });

  test("a failed enqueue is the only status a run surface must refuse", () => {
    // The distinction the surfaces depend on, asserted over the whole status
    // set rather than restating the map: anything but a failed enqueue leaves
    // the materialized columns to an in-flight or later run, so reporting the
    // review as started stays true.
    expect(
      WORKFLOW_START_STATUSES.filter(
        (status) =>
          playbookRunStartOutcome(status) ===
          PLAYBOOK_RUN_START_OUTCOME.NOT_STARTED,
      ),
    ).toEqual(["failed"]);
  });

  test("a started workflow is the only status that queued anything", () => {
    expect(
      WORKFLOW_START_STATUSES.filter(
        (status) =>
          playbookRunStartOutcome(status) === PLAYBOOK_RUN_START_OUTCOME.QUEUED,
      ),
    ).toEqual(["started"]);
  });
});
