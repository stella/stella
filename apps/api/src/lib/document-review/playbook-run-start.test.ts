import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  PLAYBOOK_RUN_START_OUTCOME,
  playbookRunStartOutcome,
} from "@/api/lib/document-review/playbook-run-start";
import { WORKFLOW_START_STATUSES } from "@/api/lib/workflow-queue";

const OUTCOMES = Object.values(PLAYBOOK_RUN_START_OUTCOME);

const API_ROOT = path.resolve(import.meta.dir, "../../..");
const QUEUE_SOURCE = "src/lib/workflow-queue.ts";

/** The finalizer's body: from its declaration to the closing brace in column
 *  one, so only its own statements are read. */
const finalizerSource = (): string => {
  const source = readFileSync(path.join(API_ROOT, QUEUE_SOURCE), "utf-8");
  const start = source.indexOf("const finishWorkflow = async (");
  const end = source.indexOf("\n};", start);
  if (start === -1 || end === -1) {
    // A renamed or moved finalizer must fail loudly: an empty body would
    // satisfy the assertion below without anything having been checked.
    throw new Error(`${QUEUE_SOURCE} no longer declares finishWorkflow`);
  }
  return source.slice(start, end);
};

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

  test("a deferred start is benign only because every finished run catches up", () => {
    // What `deferred` promises: the run holding the workspace grades the
    // columns this start materialized. The finalizer kept that promise for a
    // workspace-wide run and broke it for a cell-scoped one, which returned
    // before the catch-up — so a review deferred by a cell retry waited for
    // whatever workflow happened to run next. Any top-level early return ahead
    // of the catch-up reopens that window.
    const finalizer = finalizerSource();
    // From the point the run is known to have finalization state (before it,
    // returning is how the finalizer refuses a run it cannot read) to the
    // catch-up.
    const validAt = finalizer.indexOf("const manifest = manifestResult.value;");
    const catchUpAt = finalizer.indexOf("startStragglerCatchUp({");

    expect(validAt).toBeGreaterThan(-1);
    expect(catchUpAt).toBeGreaterThan(validAt);
    expect(finalizer.slice(validAt, catchUpAt)).not.toMatch(/^\s*return\b/mu);
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
