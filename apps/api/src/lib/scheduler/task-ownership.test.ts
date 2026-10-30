import { expect, test } from "bun:test";

import { SCHEDULER_TASK_AUTHORITY } from "./task-authority";

test("every scheduler intent declares its row ownership", () => {
  const rows = Object.entries(SCHEDULER_TASK_AUTHORITY);
  expect(
    rows
      .filter(([, entry]) => entry.schedulerOwnership === "organization")
      .map(([task]) => task),
  ).toEqual(["flow.run"]);
  expect(new Set(rows.map(([, entry]) => entry.schedulerOwnership))).toEqual(
    new Set(["organization", "platform"]),
  );
});
