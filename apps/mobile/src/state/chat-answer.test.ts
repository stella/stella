import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { answerBlocks } from "./chat-answer";
import type { AnswerBlock, AnswerStep } from "./chat-answer";

type CallState = "approval-requested" | "complete" | "error" | "input-complete";

const COMPLETED = { status: "completed" };

/** A stored call; one that ended keeps the result it is given, if any. */
const call = ({
  id,
  input,
  name,
  state = "complete",
  ...result
}: {
  id: string;
  input: unknown;
  name: string;
  output?: unknown;
  state?: CallState;
}) => ({
  type: "tool-call",
  id,
  name,
  input,
  state,
  ...(state === "complete" || state === "error"
    ? { output: "output" in result ? result.output : COMPLETED }
    : {}),
});

const subagent = (
  id: string,
  options: { state?: CallState; output?: unknown; parentCallId?: string } = {},
) =>
  call({
    id,
    name: "harness_native_tool",
    input: {
      tool: "Agent",
      detail: {
        kind: "subagent",
        description: `Task of ${id}`,
        agentType: "Explore",
      },
      ...(options.parentCallId === undefined
        ? {}
        : { parentCallId: options.parentCallId }),
    },
    ...options,
  });

const command = (
  id: string,
  parentCallId?: string,
  options: { state?: CallState; output?: unknown } = {},
) =>
  call({
    id,
    name: "command_execution",
    input: {
      command: `run ${id}`,
      ...(parentCallId === undefined ? {} : { parentCallId }),
    },
    ...options,
  });

const commandStep = (
  id: string,
  status: "done" | "failed" | "running" = "done",
): AnswerStep => ({
  type: "local",
  label: "command_execution",
  detailKind: null,
  subtitle: { type: "text", text: `run ${id}` },
  status,
});

describe("a coding agent's steps in an answer on the phone", () => {
  test("a subagent is a row of its own holding the steps it took, with a count and one status", () => {
    expect(
      answerBlocks([
        command("before"),
        subagent("agent"),
        command("first", "agent"),
        command("second", "agent"),
        command("after"),
        { type: "text", content: "Done." },
      ]),
    ).toEqual([
      {
        type: "steps",
        key: "0",
        steps: [commandStep("before")],
        work: new Map([["computation", 1]]),
      },
      {
        type: "subagent",
        key: "subagent:agent",
        description: "Task of agent",
        agentType: "Explore",
        status: "done",
        stepCount: 2,
        steps: [commandStep("first"), commandStep("second")],
      },
      {
        type: "steps",
        key: "4",
        steps: [commandStep("after")],
        work: new Map([["computation", 1]]),
      },
      { type: "text", key: "5", markdown: "Done." },
    ]);
  });

  test("a step that waits on an approval stays in the answer's own steps and marks its subagent", () => {
    const blocks = answerBlocks([
      subagent("agent", { state: "input-complete" }),
      command("ran", "agent"),
      command("asks", "agent", { state: "approval-requested" }),
    ]);
    expect(blocks).toEqual([
      {
        type: "subagent",
        key: "subagent:agent",
        description: "Task of agent",
        agentType: "Explore",
        status: "needs_approval",
        // The waiting step is counted, and shown outside the row.
        stepCount: 2,
        steps: [commandStep("ran")],
      },
      {
        type: "steps",
        key: "2",
        steps: [commandStep("asks", "running")],
        work: new Map(),
      },
    ]);
  });

  test("a subagent reads as running, failed or stopped by how it and its steps stand", () => {
    const statusOf = (parts: Parameters<typeof answerBlocks>[0]) =>
      answerBlocks(parts).flatMap((block) =>
        block.type === "subagent" ? [block.status] : [],
      );
    // A step still under way keeps a subagent whose own call ended running.
    expect(
      statusOf([
        subagent("agent"),
        command("step", "agent", { state: "input-complete" }),
      ]),
    ).toEqual(["running"]);
    // A step of it that failed is the subagent's to work around.
    expect(
      statusOf([
        subagent("agent"),
        command("step", "agent", { output: { status: "failed" } }),
      ]),
    ).toEqual(["done"]);
    expect(
      statusOf([subagent("agent", { output: { status: "failed" } })]),
    ).toEqual(["failed"]);
    // Cut off by its turn: the run's cancellation result, or none at all.
    expect(
      statusOf([
        subagent("agent", {
          state: "error",
          output: { status: "interrupted" },
        }),
      ]),
    ).toEqual(["interrupted"]);
    expect(
      statusOf([subagent("agent", { state: "error", output: undefined })]),
    ).toEqual(["interrupted"]);
  });

  test("an image step names its file, and a read or a search what it was about", () => {
    const steps = answerBlocks([
      call({
        id: "image",
        name: "harness_native_tool",
        input: {
          tool: "Read",
          detail: { kind: "image", path: "exhibits/scan-12.png" },
        },
      }),
      call({
        id: "search",
        name: "harness_native_tool",
        input: {
          tool: "Grep",
          detail: { kind: "search", pattern: "indemnity", path: "drafts" },
        },
      }),
      call({
        id: "unnamed",
        name: "harness_native_tool",
        input: { tool: "Skill" },
      }),
    ]).flatMap((block) => (block.type === "steps" ? block.steps : []));
    expect(steps).toEqual([
      {
        type: "local",
        label: "unknown",
        detailKind: "image",
        subtitle: { type: "text", text: "exhibits/scan-12.png" },
        status: "done",
      },
      {
        type: "local",
        label: "unknown",
        detailKind: "search",
        subtitle: { type: "search", pattern: "indemnity", path: "drafts" },
        status: "done",
      },
      {
        type: "local",
        label: "unknown",
        detailKind: null,
        subtitle: { type: "text", text: "Skill" },
        status: "done",
      },
    ]);
  });

  test("a subagent with no steps, or whose own call waits on an approval, hides nothing", () => {
    expect(
      answerBlocks([
        subagent("idle"),
        subagent("asks", { state: "approval-requested" }),
        command("child", "asks"),
      ]),
    ).toMatchObject([
      { type: "subagent", key: "subagent:idle", stepCount: 0, steps: [] },
      {
        type: "steps",
        // The subagent's approval is asked under the thread; its step and
        // the step naming it stay in the answer's own steps.
        steps: [
          { type: "local", detailKind: "subagent" },
          commandStep("child"),
        ],
      },
    ]);
  });

  test("every step shows exactly once, and one waiting on an approval never inside a subagent's row", () => {
    const ids = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"] as const;
    const parent = fc.option(fc.constantFrom(...ids, "missing"), {
      nil: undefined,
    });
    const callState = fc.constantFrom<CallState>(
      "approval-requested",
      "complete",
      "error",
      "input-complete",
    );
    const part = (id: string) =>
      fc
        .record({
          kind: fc.constantFrom("subagent", "command"),
          parent,
          callState,
        })
        .map(({ kind, parent: parentCallId, callState: state }) => ({
          marker: kind === "subagent" ? `Task of ${id}` : `run ${id}`,
          waits: state === "approval-requested",
          part:
            kind === "subagent"
              ? subagent(id, {
                  state,
                  ...(parentCallId === undefined ? {} : { parentCallId }),
                })
              : command(id, parentCallId, { state }),
        }));
    const markerOf = (step: AnswerStep): string[] =>
      step.type === "local" && step.subtitle?.type === "text"
        ? [step.subtitle.text]
        : [];
    const shown = (blocks: readonly AnswerBlock[]) => ({
      onAnswer: blocks.flatMap((block) => {
        switch (block.type) {
          case "text":
            return [];
          case "steps":
            return block.steps.flatMap(markerOf);
          case "subagent":
            return block.description === null ? [] : [block.description];
          default:
            block satisfies never;
            return [];
        }
      }),
      inRows: blocks.flatMap((block) =>
        block.type === "subagent" ? block.steps.flatMap(markerOf) : [],
      ),
    });
    assertProperty(
      "every step shows exactly once, and one waiting on an approval never inside a subagent's row",
      fc.property(
        fc
          .uniqueArray(fc.constantFrom(...ids), { minLength: 1 })
          .chain((chosen) => fc.tuple(...chosen.map(part))),
        (calls) => {
          const blocks = answerBlocks(calls.map((entry) => entry.part));
          const { onAnswer, inRows } = shown(blocks);
          expect([...onAnswer, ...inRows].toSorted()).toEqual(
            calls.map(({ marker }) => marker).toSorted(),
          );
          const waiting = calls.flatMap(({ marker, waits }) =>
            waits ? [marker] : [],
          );
          expect(inRows.filter((marker) => waiting.includes(marker))).toEqual(
            [],
          );
          for (const block of blocks) {
            if (block.type === "subagent") {
              expect(block.stepCount).toBeGreaterThanOrEqual(
                block.steps.length,
              );
            }
          }
        },
      ),
    );
  });
});
