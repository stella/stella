import { expect, mock, test } from "bun:test";

import type { Verdict, VerdictKind } from "@stll/db-load-gate/health";

import {
  createReconcileCaseLawDecisionIdentifiersTask,
  DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN,
} from "@/api/lib/scheduler/tasks/case-law-decision-identifier-reconciliation";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const verdictOf = (kind: VerdictKind): Verdict => ({ kind, signals: [] });

const run = async (kinds: readonly VerdictKind[]) => {
  const verdicts = [...kinds];
  const step = mock(async () => ({ status: "advanced" as const }));
  const info = mock();
  await createReconcileCaseLawDecisionIdentifiersTask({
    readVerdict: async () => verdictOf(verdicts.shift() ?? "normal"),
    step,
  })(
    asTestRaw<SchedulerTaskContext>({
      db: {},
      logger: { info },
      signal: new AbortController().signal,
    }),
  );
  return { info, step };
};

test("a held database admits no page and logs the hold", async () => {
  const { info, step } = await run(["stop"]);
  expect(step).not.toHaveBeenCalled();
  expect(info).toHaveBeenCalledWith(
    "case_law.decision_identifier_reconciliation.held",
    { verdict: "stop" },
  );
});

test("each page asks the gate again and the run ends at the first hold", async () => {
  const { step } = await run(["normal", "degraded", "unknown"]);
  // A degraded verdict still admits backfill batches; an unknown one holds.
  expect(step).toHaveBeenCalledTimes(2);
});

test("a healthy database runs the bounded page budget", async () => {
  const { step } = await run([]);
  expect(step).toHaveBeenCalledTimes(
    DECISION_IDENTIFIER_RECONCILIATION_PAGES_PER_RUN,
  );
});
