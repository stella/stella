import { EventType } from "@tanstack/ai";
import type {
  ActivityPart,
  ToolCallPart,
  ToolResultPart,
  MessagePart,
  StreamChunk,
  StructuredOutputPart,
  SubagentPart,
  UIMessage,
} from "@tanstack/ai";
import { panic } from "better-result";
import { deepEquals } from "bun";

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

export const createSnapshotActivityReconciler = (
  parts: UIMessage["parts"],
  shouldReplace = (_canonical: ActivityPart, _snapshot: ActivityPart) => true,
) => {
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
    if (shouldReplace(match.part, snapshot)) {
      parts[match.index] = snapshot;
    }
  };
};

// Calls without a sibling result must also advance monotonically on replay.
const TOOL_CALL_FINALITY = {
  "awaiting-input": 0,
  "input-streaming": 1,
  "input-complete": 2,
  "approval-requested": 3,
  "approval-responded": 4,
  complete: 5,
  error: 5,
} as const satisfies Record<ToolCallPart["state"], number>;

const STRUCTURED_OUTPUT_FINALITY = {
  streaming: 0,
  complete: 1,
  error: 1,
} as const satisfies Record<StructuredOutputPart["status"], number>;

const SUBAGENT_FINALITY = {
  running: 0,
  suspended: 1,
  finished: 2,
  error: 2,
} as const satisfies Record<SubagentPart["subagent"]["status"], number>;

type PartProvenance = "delta-streamed" | "snapshot-derived";

// SDK additions must choose the same ownership boundary as every existing part.
const PART_SNAPSHOT_POLICY = {
  text: "extension",
  thinking: "extension",
  "tool-call": "finality",
  "tool-result": "finality",
  activity: "latest",
  "structured-output": "finality",
  subagent: "finality",
  "ui-resource": "latest",
  image: "latest",
  audio: "latest",
  video: "latest",
  document: "latest",
} as const satisfies Record<
  MessagePart["type"],
  "extension" | "finality" | "latest"
>;

type SnapshotOwnershipOptions = {
  canonical: MessagePart;
  snapshot: MessagePart;
  canonicalFinality?: number;
  snapshotFinality?: number;
};

type SnapshotTextOptions = {
  previousParts: UIMessage["parts"];
  snapshotParts: UIMessage["parts"];
  parts: UIMessage["parts"];
  part: Extract<MessagePart, { type: "text" | "thinking" }>;
  preservesPartLayout: boolean;
};

type DeltaPartsOptions = {
  before: UIMessage["parts"];
  after: UIMessage["parts"];
  chunk: StreamChunk;
};

type SnapshotCallPartsOptions = Omit<
  SnapshotPartsOptions,
  "preservesPartLayout"
> & {
  parts: UIMessage["parts"];
};

type SnapshotPartsOptions = {
  previous: UIMessage;
  snapshot: UIMessage;
  preservesPartLayout: boolean;
  parseResultOutput: (content: string) => unknown;
};

/** One turn owns provenance; snapshots and synthetic resume events cannot claim deltas. */
export class SnapshotPartReconciler {
  private readonly sources = new WeakMap<MessagePart, PartProvenance>();

  constructor(initial: UIMessage["parts"]) {
    // Completed history is canonical transcript content on a continuation.
    for (const part of initial) {
      this.record(part, "delta-streamed");
    }
  }

  private record(part: MessagePart, provenance: PartProvenance) {
    this.sources.set(part, provenance);
  }

  provenanceOf(part: MessagePart) {
    return this.sources.get(part) ?? panic("Reconciled part has no provenance");
  }

  reconcileDelta({ before, after, chunk }: DeltaPartsOptions) {
    if (
      chunk.type !== EventType.TEXT_MESSAGE_CONTENT &&
      chunk.type !== EventType.REASONING_MESSAGE_CONTENT
    ) {
      return after;
    }
    const kind =
      chunk.type === EventType.TEXT_MESSAGE_CONTENT ? "text" : "thinking";
    const content = (parts: UIMessage["parts"]) =>
      parts
        .filter((part) => part.type === "text" || part.type === "thinking")
        .filter((part) => part.type === kind)
        .map((part) => part.content)
        .join("");
    if (content(after) === content(before) + chunk.delta) {
      return after;
    }
    // The SDK's transient segment buffer may have survived a different
    // part's update or been cleared by a snapshot. The source delta owns
    // exactly its new bytes; reconstruct placement from the retained parts.
    const parts = [...before];
    const updated = after.findLast(
      (part) => part.type === kind && !before.includes(part),
    );
    if (
      updated === undefined ||
      (updated.type !== "text" && updated.type !== "thinking")
    ) {
      panic("Textual delta produced no textual part");
    }
    let existingIndex = -1;
    if (kind === "text") {
      if (before.at(-1)?.type === "text") {
        existingIndex = before.length - 1;
      }
    } else {
      existingIndex = before.findLastIndex(
        (part) =>
          part.type === "thinking" &&
          updated.type === "thinking" &&
          part.stepId === updated.stepId,
      );
    }
    const existing = before.at(existingIndex);
    if (
      existingIndex !== -1 &&
      existing !== undefined &&
      (existing.type === "text" || existing.type === "thinking")
    ) {
      parts[existingIndex] = {
        ...existing,
        content: existing.content + chunk.delta,
      };
    } else {
      parts.push({ ...updated, content: chunk.delta });
    }
    return parts;
  }

  reconcileText({
    previousParts,
    snapshotParts,
    parts,
    part,
    preservesPartLayout,
  }: SnapshotTextOptions) {
    const sameKind = previousParts
      .filter(
        (existing) => existing.type === "text" || existing.type === "thinking",
      )
      .filter((existing) => existing.type === part.type);
    if (sameKind.length === 0) {
      parts.push(this.snapshot(part));
      return;
    }
    const incoming = snapshotParts
      .filter(
        (candidate) =>
          candidate.type === "text" || candidate.type === "thinking",
      )
      .filter((candidate) => candidate.type === part.type);
    if (incoming.at(0) !== part) {
      return;
    }
    const content = sameKind.map((candidate) => candidate.content).join("");
    const snapshotContent = incoming
      .map((candidate) => candidate.content)
      .join("");
    const hasDeltas = sameKind.some(
      (candidate) => this.provenanceOf(candidate) === "delta-streamed",
    );
    if (!hasDeltas) {
      // A snapshot owns the whole textual sequence, including its segmentation.
      // Replacing ordinal slots would retain obsolete segments after a merge.
      const first = sameKind.at(0);
      if (first === undefined) {
        panic("Snapshot text sequence has no canonical slot");
      }
      const insertionIndex = parts.indexOf(first);
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts.at(index)?.type === part.type) {
          parts.splice(index, 1);
        }
      }
      parts.splice(
        insertionIndex,
        0,
        ...incoming.map((candidate) => this.snapshot(candidate)),
      );
      return;
    }
    // Explicit UI snapshots may complete a streamed sequence even when their
    // segments split or merge. Compare whole content and retain delta placement.
    if (
      !preservesPartLayout ||
      snapshotContent.length <= content.length ||
      !snapshotContent.startsWith(content)
    ) {
      return;
    }
    const last = sameKind.at(-1);
    if (last === undefined) {
      panic("Streamed text sequence has no final slot");
    }
    parts[parts.indexOf(last)] = this.inherit(
      {
        ...last,
        content: last.content + snapshotContent.slice(content.length),
      },
      last,
    );
  }

  reconcile({
    previous,
    snapshot,
    preservesPartLayout,
    parseResultOutput,
  }: SnapshotPartsOptions): UIMessage["parts"] {
    const parts = [...previous.parts];
    const reconcileActivity = createSnapshotActivityReconciler(
      parts,
      (canonical, updatedActivity) =>
        this.shouldReplace({
          canonical,
          snapshot: updatedActivity,
        }),
    );
    for (const part of snapshot.parts) {
      this.snapshot(part);
      switch (part.type) {
        case "text":
        case "thinking":
          this.reconcileText({
            previousParts: previous.parts,
            snapshotParts: snapshot.parts,
            parts,
            part,
            preservesPartLayout,
          });
          break;
        case "tool-call":
          if (
            !parts.some(
              (existing) =>
                existing.type === "tool-call" && existing.id === part.id,
            )
          ) {
            parts.push(part);
          }
          break;
        case "tool-result": {
          const existingIndex = parts.findIndex(
            (existing) =>
              existing.type === "tool-result" &&
              existing.toolCallId === part.toolCallId,
          );
          if (existingIndex === -1) {
            parts.push(part);
            break;
          }
          const existing = parts.at(existingIndex);
          if (existing?.type !== "tool-result") {
            panic("A matching snapshot result has no streamed tool result");
          }
          parts[existingIndex] = reconcileSnapshotResult({
            canonical: existing,
            snapshot: part,
          });
          break;
        }
        case "activity":
          reconcileActivity(part);
          break;
        case "structured-output": {
          const existingIndex = parts.findIndex(
            (existing) => existing.type === "structured-output",
          );
          const existing = parts.at(existingIndex);
          if (existingIndex === -1) {
            parts.push(part);
          } else if (
            existing?.type === "structured-output" &&
            this.shouldReplace({
              canonical: existing,
              snapshot: part,
              canonicalFinality: STRUCTURED_OUTPUT_FINALITY[existing.status],
              snapshotFinality: STRUCTURED_OUTPUT_FINALITY[part.status],
            })
          ) {
            parts[existingIndex] = part;
          }
          break;
        }
        case "subagent": {
          const existingIndex = parts.findIndex(
            (existing) =>
              existing.type === "subagent" &&
              existing.subagent.id === part.subagent.id,
          );
          const existing = parts.at(existingIndex);
          if (existingIndex === -1) {
            parts.push(part);
          } else if (
            existing?.type === "subagent" &&
            this.shouldReplace({
              canonical: existing,
              snapshot: part,
              canonicalFinality: SUBAGENT_FINALITY[existing.subagent.status],
              snapshotFinality: SUBAGENT_FINALITY[part.subagent.status],
            })
          ) {
            parts[existingIndex] = part;
          }
          break;
        }
        case "ui-resource": {
          const existingIndex = parts.findIndex(
            (existing) =>
              existing.type === "ui-resource" &&
              existing.toolCallId === part.toolCallId &&
              existing.resource.uri === part.resource.uri,
          );
          if (existingIndex === -1) {
            parts.push(part);
          } else {
            const existing = parts.at(existingIndex);
            if (existing === undefined) {
              panic("Matching snapshot part has no canonical slot");
            }
            if (
              this.shouldReplace({
                canonical: existing,
                snapshot: part,
              })
            ) {
              parts[existingIndex] = part;
            }
          }
          break;
        }
        case "image":
        case "audio":
        case "video":
        case "document": {
          const existingIndex = parts.findIndex((existing) => {
            switch (existing.type) {
              case "image":
              case "audio":
              case "video":
              case "document":
                return (
                  existing.type === part.type &&
                  deepEquals(existing.source, part.source)
                );
              case "activity":
              case "structured-output":
              case "subagent":
              case "text":
              case "thinking":
              case "tool-call":
              case "tool-result":
              case "ui-resource":
                return false;
              default:
                existing satisfies never;
                return panic("Unhandled snapshot media candidate");
            }
          });
          if (existingIndex === -1) {
            parts.push(part);
          } else {
            const existing = parts.at(existingIndex);
            if (existing === undefined) {
              panic("Matching snapshot part has no canonical slot");
            }
            if (
              this.shouldReplace({
                canonical: existing,
                snapshot: part,
              })
            ) {
              parts[existingIndex] = part;
            }
          }
          break;
        }
        default:
          part satisfies never;
          panic("Unhandled snapshot message part");
      }
    }
    return this.reconcileCalls({
      parts,
      previous,
      snapshot,
      parseResultOutput,
    });
  }

  shouldReplace({
    canonical,
    snapshot,
    canonicalFinality = 0,
    snapshotFinality = 0,
  }: SnapshotOwnershipOptions) {
    if (canonical.type !== snapshot.type) {
      panic("Snapshot ownership compared different part types");
    }
    const policy = PART_SNAPSHOT_POLICY[snapshot.type];
    if (snapshotFinality < canonicalFinality) {
      return false;
    }
    if (snapshotFinality > canonicalFinality) {
      return true;
    }
    return (
      policy !== "extension" &&
      this.provenanceOf(canonical) === "snapshot-derived"
    );
  }

  snapshot(part: MessagePart) {
    if (!this.sources.has(part)) {
      this.record(part, "snapshot-derived");
    }
    return part;
  }

  inherit(part: MessagePart, previous: MessagePart) {
    this.record(part, this.provenanceOf(previous));
    return part;
  }

  observe(before: UIMessage["parts"], after: UIMessage["parts"]) {
    for (const [index, part] of after.entries()) {
      if (this.sources.has(part)) {
        continue;
      }
      const previous = before.at(index);
      this.record(
        part,
        previous !== undefined && deepEquals(previous, part)
          ? this.provenanceOf(previous)
          : "delta-streamed",
      );
    }
  }

  adoptSnapshot(selected: UIMessage["parts"], normalized: UIMessage["parts"]) {
    for (const [index, part] of normalized.entries()) {
      const previous = selected.at(index);
      if (previous === undefined || previous.type !== part.type) {
        panic("SDK snapshot normalization changed reconciled part slots");
      }
      this.record(part, this.provenanceOf(previous));
    }
  }

  private reconcileCalls({
    parts,
    previous,
    snapshot,
    parseResultOutput,
  }: SnapshotCallPartsOptions) {
    return parts.map((part) => {
      if (part.type !== "tool-call") {
        return part;
      }
      const result = parts.find(
        (candidate) =>
          candidate.type === "tool-result" && candidate.toolCallId === part.id,
      );
      const canonicalResult = previous.parts.find(
        (candidate) =>
          candidate.type === "tool-result" && candidate.toolCallId === part.id,
      );
      const updated = snapshot.parts.find(
        (candidate) =>
          candidate.type === "tool-call" && candidate.id === part.id,
      );
      const snapshotCall = updated?.type === "tool-call" ? updated : part;
      // The selected result owns finality; without a result, only advance
      // the call. Equal-finality conflicts retain the streamed version.
      let selected = part;
      if (result?.type === "tool-result") {
        if (result !== canonicalResult) {
          selected = snapshotCall;
        }
      } else if (
        this.shouldReplace({
          canonical: part,
          snapshot: snapshotCall,
          canonicalFinality: TOOL_CALL_FINALITY[part.state],
          snapshotFinality: TOOL_CALL_FINALITY[snapshotCall.state],
        })
      ) {
        selected = snapshotCall;
      }
      const other = selected === part ? snapshotCall : part;
      return this.inherit(
        reconcileSnapshotCall({
          selected,
          other,
          ...(result?.type === "tool-result"
            ? {
                result,
                resultOutput:
                  typeof result.content === "string"
                    ? parseResultOutput(result.content)
                    : result.content,
              }
            : {}),
          resultSelected: result !== canonicalResult,
        }),
        selected,
      );
    });
  }
}
