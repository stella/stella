import { expect, test } from "bun:test";

import { workflowActionsDisabled } from "./workspace.logic";

const readError = new Error("Read failed");
const retry = () => Promise.reject(readError);

test("disables workflow actions until the status is known", () => {
  expect(workflowActionsDisabled({ type: "pending" })).toBe(true);
  expect(
    workflowActionsDisabled({ type: "error", error: readError, retry }),
  ).toBe(true);
});

test("uses the known workflow status even after a failed refetch", () => {
  for (const running of [true, false]) {
    expect(
      workflowActionsDisabled({ type: "items", items: running, retry }),
    ).toBe(running);
    expect(
      workflowActionsDisabled({
        type: "items",
        items: running,
        retry,
        refetchError: readError,
      }),
    ).toBe(running);
  }
});
