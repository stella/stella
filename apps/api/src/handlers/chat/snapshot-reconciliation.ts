import type {
  ActivityPart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";

import { TANSTACK_TOOL_RESULT_STATE_LIFECYCLE } from "@/api/handlers/chat/tanstack-chat-lifecycle";

type ToolResultFinality =
  (typeof TANSTACK_TOOL_RESULT_STATE_LIFECYCLE)[ToolResultPart["state"]];

// Snapshot progress advances active results; settled content stays canonical.
const RESULT_OWNER = {
  active: { active: "snapshot", settled: "snapshot" },
  settled: { active: "canonical", settled: "canonical" },
} as const satisfies Record<
  ToolResultFinality,
  Record<ToolResultFinality, "snapshot" | "canonical">
>;

type SnapshotResultOptions = {
  canonical: ToolResultPart;
  snapshot: ToolResultPart;
};

export const reconcileSnapshotResult = ({
  canonical,
  snapshot,
}: SnapshotResultOptions): ToolResultPart =>
  RESULT_OWNER[TANSTACK_TOOL_RESULT_STATE_LIFECYCLE[canonical.state]][
    TANSTACK_TOOL_RESULT_STATE_LIFECYCLE[snapshot.state]
  ] === "snapshot"
    ? snapshot
    : canonical;

type CallFieldOptions = {
  selected: ToolCallPart;
  other: ToolCallPart;
  result?: ToolResultPart;
  resultSelected: boolean;
  resultOutput?: unknown;
};

type CallFieldPolicy = {
  [Field in keyof ToolCallPart]-?: (
    options: CallFieldOptions,
  ) => ToolCallPart[Field];
};

// Each SDK field must choose its owner; SDK additions cannot silently disappear.
const CALL_FIELDS = {
  type: ({ selected }) => selected.type,
  id: ({ selected }) => selected.id,
  name: ({ selected }) => selected.name,
  arguments: ({ selected }) => selected.arguments,
  input: ({ selected }) => selected.input,
  metadata: ({ selected }) => selected.metadata,
  approval: ({ selected, other }) =>
    selected.approval?.approved === undefined &&
    other.approval?.approved !== undefined
      ? other.approval
      : (selected.approval ?? other.approval),
  state: ({ selected, result }) => {
    if (result === undefined) {
      return selected.state;
    }
    // SDK snapshots and hydration classify a call with output as complete;
    // progress is represented by the sibling result's streaming state.
    return result.state === "streaming" ? "complete" : result.state;
  },
  output: ({ selected, result, resultSelected, resultOutput }) => {
    if (
      result !== undefined &&
      (resultSelected || selected.output === undefined)
    ) {
      return resultOutput;
    }
    const output: unknown = selected.output;
    return output;
  },
} satisfies CallFieldPolicy;

export const reconcileSnapshotCall = (
  options: CallFieldOptions,
): ToolCallPart => {
  const input = CALL_FIELDS.input(options);
  const metadata = CALL_FIELDS.metadata(options);
  const approval = CALL_FIELDS.approval(options);
  const output = CALL_FIELDS.output(options);
  return {
    type: CALL_FIELDS.type(options),
    id: CALL_FIELDS.id(options),
    name: CALL_FIELDS.name(options),
    arguments: CALL_FIELDS.arguments(options),
    ...(input === undefined ? {} : { input }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(approval === undefined ? {} : { approval }),
    state: CALL_FIELDS.state(options),
    ...(output === undefined ? {} : { output }),
  };
};

export const createSnapshotActivityReconciler = (parts: UIMessage["parts"]) => {
  // Capture prior slots once: newly appended parts must not consume later
  // snapshot duplicates. Consuming a slot implements first-to-first matching.
  const candidates = parts.flatMap((part, index) =>
    part.type === "activity" ? [{ part, index }] : [],
  );
  const consumed = new Set<number>();
  return (snapshot: ActivityPart) => {
    const match = candidates.find(
      ({ part, index }) =>
        !consumed.has(index) &&
        part.activityType === snapshot.activityType &&
        (part.subagentRunId ?? undefined) ===
          (snapshot.subagentRunId ?? undefined),
    );
    if (match === undefined) {
      parts.push(snapshot);
      return;
    }
    consumed.add(match.index);
    parts[match.index] = snapshot;
  };
};
