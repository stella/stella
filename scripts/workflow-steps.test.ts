import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  flattenWorkflowSteps,
  isWorkflowBarrier,
  synchronizeWorkflowBackgroundSteps,
  workflowJobSteps,
  workflowStepByName,
} from "./workflow-steps";

test("named command selection survives intervening and nested workflow steps", () => {
  assertProperty(
    "named command selection survives intervening and nested workflow steps",
    fc.property(
      fc.array(fc.record({ name: fc.uuid(), run: fc.string() })),
      fc.string(),
      fc.integer({ min: 1, max: 5 }),
      (neighbors, command, depth) => {
        const selected = { name: "Selected command", run: command };
        let grouped: unknown = [selected];
        for (let level = 0; level < depth; level++) {
          grouped = [{ parallel: grouped }];
        }
        const workflow = Bun.YAML.parse(
          Bun.YAML.stringify({
            jobs: {
              fixture: {
                steps: [...neighbors, { parallel: grouped }, ...neighbors],
              },
            },
          }),
        );
        expect(
          workflowStepByName(
            workflowJobSteps(workflow, "fixture"),
            selected.name,
          ),
        ).toEqual(selected);
      },
    ),
  );
});

test("named command selection rejects missing or ambiguous workflow structure", () => {
  expect(() => workflowJobSteps({}, "missing")).toThrow("Missing workflow job");
  expect(() => workflowJobSteps({ jobs: { missing: {} } }, "missing")).toThrow(
    "Missing workflow steps",
  );
  expect(() => workflowStepByName([], "missing")).toThrow("found 0");
  expect(() =>
    workflowStepByName(
      [{ name: "duplicate" }, { parallel: [{ name: "duplicate" }] }],
      "duplicate",
    ),
  ).toThrow("found 2");
});

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
  for (const wait of ["second", ["second"]]) {
    const pending = new Map([
      ["first", ["first"]],
      ["second", ["second"]],
    ]);
    expect(synchronizeWorkflowBackgroundSteps({ wait }, pending)).toEqual([
      "second",
    ]);
    expect([...pending.keys()]).toEqual(["first"]);
    expect(
      synchronizeWorkflowBackgroundSteps({ run: "true" }, pending),
    ).toBeUndefined();
    expect(
      synchronizeWorkflowBackgroundSteps({ "wait-all": null }, pending),
    ).toEqual(["first"]);
    expect(pending.size).toBe(0);
  }
});

test("synchronization promotes every completed proof and no canceled proof", () => {
  assertProperty(
    "synchronization promotes every completed proof and no canceled proof",
    fc.property(
      fc.dictionary(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/u),
        fc.constantFrom("cancel", "complete"),
        { minKeys: 1, maxKeys: 10 },
      ),
      (dispositions) => {
        for (const wait of [
          { "wait-all": null },
          { wait: Object.keys(dispositions) },
        ]) {
          const pending = new Map(
            Object.keys(dispositions).map((id) => [id, [id]]),
          );
          for (const [id, disposition] of Object.entries(dispositions)) {
            if (disposition === "cancel") {
              expect(
                synchronizeWorkflowBackgroundSteps({ cancel: id }, pending),
              ).toEqual([]);
            }
          }
          const expected = Object.keys(dispositions).filter(
            (id) => dispositions[id] === "complete",
          );
          expect(synchronizeWorkflowBackgroundSteps(wait, pending)).toEqual(
            expected,
          );
          expect(pending.size).toBe(0);
        }
      },
    ),
  );
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
