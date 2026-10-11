import type {
  ActivityPart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";
import { expect, test } from "bun:test";

import {
  createSnapshotActivityReconciler,
  reconcileSnapshotCall,
  reconcileSnapshotResult,
} from "@/api/handlers/chat/snapshot-reconciliation";

test("duplicate activity keys match ordinal slots and preserve unmatched parts", () => {
  const activity = (content: string, subagentRunId?: string): ActivityPart => ({
    type: "activity",
    activityType: "review",
    content: { value: content },
    ...(subagentRunId === undefined ? {} : { subagentRunId }),
  });
  const kept = activity("kept", "child");
  const first = activity("first");
  const second = activity("second");
  const parts: UIMessage["parts"] = [
    first,
    kept,
    second,
    activity("unmatched", "other"),
  ];
  const nextFirst = activity("next-first");
  const nextSecond = activity("next-second");
  const appended = activity("appended");
  const child = activity("child-next", "new-child");
  const reconcile = createSnapshotActivityReconciler(parts);
  for (const part of [nextFirst, nextSecond, appended, child]) {
    reconcile(part);
  }
  expect(parts).toEqual([
    nextFirst,
    kept,
    nextSecond,
    activity("unmatched", "other"),
    appended,
    child,
  ]);
  const shorter = createSnapshotActivityReconciler(parts);
  shorter(first);
  expect(parts).toEqual([
    first,
    kept,
    nextSecond,
    activity("unmatched", "other"),
    appended,
    child,
  ]);
});

const selected = {
  type: "tool-call",
  id: "selected",
  name: "lookup",
  arguments: '{"query":"complete"}',
  input: { query: "complete" },
  metadata: { provider: "selected" },
  approval: { id: "selected-approval", needsApproval: true, approved: true },
  state: "complete",
  output: { answer: "selected" },
} as const satisfies ToolCallPart;
const other = {
  type: "tool-call",
  id: "other",
  name: "older",
  arguments: '{"query":',
  input: { query: "older" },
  metadata: { provider: "older" },
  approval: { id: "other-approval", needsApproval: true },
  state: "input-streaming",
  output: { answer: "older" },
} as const satisfies ToolCallPart;

const fields = {
  type: true,
  id: true,
  name: true,
  arguments: true,
  input: true,
  metadata: true,
  approval: true,
  state: true,
  output: true,
} satisfies Record<keyof ToolCallPart, true>;

for (const field of Object.keys(fields)) {
  test(`the selected call owns its ${field} field`, () => {
    const actual = reconcileSnapshotCall({
      selected,
      other,
      resultSelected: false,
    });
    expect(Object.getOwnPropertyDescriptor(actual, field)?.value).toEqual(
      Object.getOwnPropertyDescriptor(selected, field)?.value,
    );
  });
}

test("absent selected fields stay absent and decisions survive requested-only replay", () => {
  const absentFields = {
    type: "tool-call",
    id: "call",
    name: "lookup",
    arguments: "{}",
    state: "input-complete",
  } as const satisfies ToolCallPart;
  expect(
    reconcileSnapshotCall({
      selected: absentFields,
      other,
      resultSelected: false,
    }),
  ).toEqual({ ...absentFields, approval: other.approval });
  expect(
    reconcileSnapshotCall({
      selected: other,
      other: { ...other, approval: { ...other.approval, approved: false } },
      resultSelected: false,
    }).approval?.approved,
  ).toBe(false);
});

test("the selected result owns call state and output", () => {
  expect(
    reconcileSnapshotCall({
      selected,
      other,
      result: {
        type: "tool-result",
        toolCallId: selected.id,
        content: "denied",
        state: "error",
        outcome: "denied",
      },
      resultSelected: true,
      resultOutput: "denied",
    }),
  ).toMatchObject({ state: "error", output: "denied" });
});

const resultCases = [
  { canonical: "streaming", snapshot: "streaming", owner: "snapshot" },
  { canonical: "streaming", snapshot: "complete", owner: "snapshot" },
  { canonical: "complete", snapshot: "streaming", owner: "canonical" },
  { canonical: "error", snapshot: "complete", owner: "canonical" },
] as const;

for (const { canonical, snapshot, owner } of resultCases) {
  test(`result ${canonical} to ${snapshot} retains the ${owner} payload`, () => {
    const previous = {
      type: "tool-result",
      toolCallId: "call",
      state: canonical,
      content: "previous",
      ...(canonical === "error" ? { outcome: "denied" as const } : {}),
    } as const satisfies ToolResultPart;
    const updated = {
      type: "tool-result",
      toolCallId: "call",
      state: snapshot,
      content: "updated",
    } as const satisfies ToolResultPart;
    expect(
      reconcileSnapshotResult({ canonical: previous, snapshot: updated }),
    ).toBe(owner === "snapshot" ? updated : previous);
  });
}

test("streaming result progress keeps an output-bearing call reloadable", () => {
  const result = {
    type: "tool-result",
    toolCallId: selected.id,
    state: "streaming",
    content: "latest progress",
  } as const satisfies ToolResultPart;
  expect(
    reconcileSnapshotCall({
      selected,
      other,
      result,
      resultSelected: true,
      resultOutput: "latest progress",
    }),
  ).toMatchObject({ state: "complete", output: "latest progress" });
});
