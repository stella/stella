import { expect, test } from "bun:test";

import {
  accountDeletionLeavesTasksUnassigned,
  validAccountDeletionReassignments,
} from "./deletion-reassignments.logic";

const tasks = [
  { entityId: "task", workspaceId: "matter" },
  { entityId: "second", workspaceId: "matter" },
];
const members = [
  { workspaceId: "matter", userId: "member" },
  { workspaceId: "other", userId: "outsider" },
];
test("account erasure permits default and partial handoff", () => {
  expect(
    validAccountDeletionReassignments({ tasks, members, reassignments: {} }),
  ).toBe(true);
  expect(
    validAccountDeletionReassignments({
      tasks,
      members,
      reassignments: { task: "" },
    }),
  ).toBe(true);
  expect(
    validAccountDeletionReassignments({
      tasks,
      members,
      reassignments: { task: "member" },
    }),
  ).toBe(true);
});
test("an explicit handoff must name a current member of that matter", () => {
  expect(
    validAccountDeletionReassignments({
      tasks,
      members,
      reassignments: { task: "outsider" },
    }),
  ).toBe(false);
  expect(
    validAccountDeletionReassignments({
      tasks,
      members,
      reassignments: { task: "departed" },
    }),
  ).toBe(false);
});
test("the unassigned notice shows while any active task has no handoff", () => {
  expect(
    accountDeletionLeavesTasksUnassigned({ tasks, reassignments: {} }),
  ).toBe(true);
  expect(
    accountDeletionLeavesTasksUnassigned({
      tasks,
      reassignments: { task: "member", second: "" },
    }),
  ).toBe(true);
  expect(
    accountDeletionLeavesTasksUnassigned({
      tasks,
      reassignments: { task: "member", second: "member" },
    }),
  ).toBe(false);
  expect(
    accountDeletionLeavesTasksUnassigned({ tasks: [], reassignments: {} }),
  ).toBe(false);
});
