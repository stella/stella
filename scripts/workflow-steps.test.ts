import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  flattenWorkflowSteps,
  isWorkflowBarrier,
  workflowWaitTargets,
} from "./workflow-steps";

test("parallel grouping preserves every leaf in execution order", () => {
  assertProperty(
    "parallel grouping preserves every leaf in execution order",
    fc.property(
      fc.array(fc.record({ name: fc.string(), run: fc.string() })),
      fc.integer({ min: 1, max: 5 }),
      (leaves, depth) => {
        let grouped: unknown = leaves;
        for (let level = 0; level < depth; level++) {
          grouped = [{ parallel: grouped }];
        }
        expect(flattenWorkflowSteps(grouped)).toEqual(leaves);
      },
    ),
  );
});

test("background commands and synchronization barriers remain visible", () => {
  const command = { id: "guard", background: true, run: "exit 1" };
  const barriers = [
    { wait: "guard" },
    { "wait-all": null },
    { cancel: "guard" },
  ];
  const leaves = flattenWorkflowSteps([{ parallel: [command, ...barriers] }]);
  expect(leaves).toEqual([command, ...barriers]);
  expect(leaves.filter(isWorkflowBarrier)).toEqual(barriers);
});

test("wait barriers release only their requested pending steps", () => {
  const pending = ["first", "second"];
  expect(workflowWaitTargets({ wait: "second" }, pending)).toEqual(["second"]);
  expect(workflowWaitTargets({ wait: ["first", 2] }, pending)).toEqual([
    "first",
  ]);
  expect(workflowWaitTargets({ "wait-all": null }, pending)).toEqual(pending);
  expect(workflowWaitTargets({ run: "true" }, pending)).toBeUndefined();
});

test("malformed parallel steps fail instead of hiding workflow commands", () => {
  expect(() => flattenWorkflowSteps([{ parallel: "checks" }])).toThrow(
    "Workflow steps must be an array",
  );
  expect(() => flattenWorkflowSteps([{ parallel: [null] }])).toThrow(
    "Workflow step must be an object",
  );
  expect(() =>
    flattenWorkflowSteps([{ parallel: [], run: "hidden command" }]),
  ).toThrow("Parallel groups cannot declare leaf step fields");
});
