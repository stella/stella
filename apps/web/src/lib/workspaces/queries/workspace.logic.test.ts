import { expect, test } from "bun:test";

import { workflowActionsDisabled } from "./workspace.logic";

const readError = new Error("Read failed");
const retry = async () => {
  throw readError;
};

test("disables workflow actions until the status is known", () => {
  expect(workflowActionsDisabled({ type: "pending" })).toBe(true);
  expect(
    workflowActionsDisabled({ type: "error", error: readError, retry }),
  ).toBe(true);
});

test("uses a successfully read workflow status", () => {
  for (const running of [true, false]) {
    expect(
      workflowActionsDisabled({ type: "items", items: running, retry }),
    ).toBe(running);
  }
});

test("disables workflow actions after any failed status refetch", () => {
  for (const running of [true, false]) {
    expect(
      workflowActionsDisabled({
        type: "items",
        items: running,
        retry,
        refetchError: readError,
      }),
    ).toBe(true);
  }
});
