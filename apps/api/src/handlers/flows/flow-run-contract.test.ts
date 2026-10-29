import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { buildFlowRunRows } from "@/api/lib/flows/start-flow-run";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

const definition = {
  name: "Review and file",
  steps: [
    {
      kind: "ai" as const,
      name: "Summarize",
      prompt: "Summarize the document.",
      includeDocuments: true,
    },
    {
      kind: "review-gate" as const,
      name: "Approve",
      instructions: "Check the summary.",
    },
    {
      kind: "create-document" as const,
      name: "File",
      documentTitle: "Approved summary",
    },
  ],
};

const buildRun = () =>
  buildFlowRunRows({
    runId: createSafeId<"flowRun">(),
    workspaceId: createSafeId<"workspace">(),
    definitionId: createSafeId<"flowDefinition">(),
    definition,
    triggerSource: { type: "schedule" },
    inputEntityIds: [createSafeId<"entity">()],
  });

test("flow run steps retain definition order and start pending", () => {
  const rows = buildRun();

  expect(
    rows.steps.map(({ index, kind, status }) => ({ index, kind, status })),
  ).toEqual([
    { index: 0, kind: "ai", status: "pending" },
    { index: 1, kind: "review-gate", status: "pending" },
    { index: 2, kind: "create-document", status: "pending" },
  ]);
  expect(rows.run.currentStepIndex).toBe(0);
  expect(rows.run.definitionSnapshot).toEqual(definition);
});

test("re-running a definition creates distinct step rows with the same order", () => {
  const first = buildRun();
  const second = buildRun();

  expect(second.steps.map(({ kind }) => kind)).toEqual(
    first.steps.map(({ kind }) => kind),
  );
  expect(second.steps.map(({ id }) => id)).not.toEqual(
    first.steps.map(({ id }) => id),
  );
});

test("run snapshots retain input record ids independently of later record lifetime", () => {
  const inputEntityId = createSafeId<"entity">();
  const rows = buildFlowRunRows({
    runId: createSafeId<"flowRun">(),
    workspaceId: createSafeId<"workspace">(),
    definitionId: createSafeId<"flowDefinition">(),
    definition,
    triggerSource: { type: "manual", userId: mintAuthProviderId<"user">() },
    inputEntityIds: [inputEntityId],
  });

  expect(rows.run.inputEntityIds).toEqual([inputEntityId]);
});
