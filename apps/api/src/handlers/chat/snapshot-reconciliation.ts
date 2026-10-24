import { EventType } from "@tanstack/ai";
import type {
  ActivityPart,
  MessagePart,
  StreamChunk,
  StructuredOutputPart,
  SubagentPart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";
import { panic, TaggedError } from "better-result";
import { deepEquals } from "bun";

import { TANSTACK_TOOL_RESULT_STATE_LIFECYCLE } from "@/api/handlers/chat/tanstack-chat-lifecycle";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

export class SnapshotReconciliationError extends TaggedError(
  "SnapshotReconciliationError",
)<{
  message: string;
  phase: "provenance" | "normalization" | "textual-delta";
}> {}

const SNAPSHOT_FAILURE_SINK = failureSink({
  event: "chat.snapshot_reconciliation.failed",
  expected: [],
});

const reportSnapshotFailure = (error: SnapshotReconciliationError) => {
  observeFailure(error, {
    sink: SNAPSHOT_FAILURE_SINK,
    ctx: { phase: error.phase },
  });
};

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

const snapshotPartIdentity = (part: MessagePart) => {
  switch (part.type) {
    case "text":
    case "thinking":
    case "structured-output":
      return { type: part.type } as const;
    case "tool-call":
      return { type: part.type, id: part.id } as const;
    case "tool-result":
      return { type: part.type, id: part.toolCallId } as const;
    case "activity":
      return {
        type: part.type,
        activityType: part.activityType,
        subagentRunId: part.subagentRunId ?? null,
      } as const;
    case "subagent":
      return { type: part.type, id: part.subagent.id } as const;
    case "ui-resource":
      return {
        type: part.type,
        toolCallId: part.toolCallId,
        uri: part.resource.uri,
      } as const;
    case "image":
    case "audio":
    case "video":
    case "document":
      return { type: part.type, source: part.source } as const;
    default:
      part satisfies never;
      return panic("Unhandled snapshot part identity");
  }
};

// Capture occurrences before mutation. Newly appended snapshot parts cannot
// consume a later duplicate, and even repeated object references own slots.
const createSnapshotPartMatcher = (parts: UIMessage["parts"]) => {
  const candidates = [...parts];
  const consumed = new Set<number>();
  return (identity: ReturnType<typeof snapshotPartIdentity>) => {
    const index = candidates.findIndex(
      (part, candidateIndex) =>
        !consumed.has(candidateIndex) &&
        deepEquals(snapshotPartIdentity(part), identity),
    );
    if (index === -1) {
      return undefined;
    }
    const part =
      candidates.at(index) ?? panic("Matched occurrence has no part");
    consumed.add(index);
    return { part, index };
  };
};

export const createSnapshotActivityReconciler = (
  parts: UIMessage["parts"],
  shouldReplace = (_canonical: ActivityPart, _snapshot: ActivityPart) => true,
) => {
  const matchPart = createSnapshotPartMatcher(parts);
  return (snapshot: ActivityPart) => {
    const match = matchPart(snapshotPartIdentity(snapshot));
    const canonical = match?.part;
    if (canonical?.type !== "activity") {
      parts.push(snapshot);
      return;
    }
    const index = match?.index ?? -1;
    if (index !== -1 && shouldReplace(canonical, snapshot)) {
      parts[index] = snapshot;
    }
  };
};

// Calls without a sibling result must also advance monotonically on replay.
// A complete call paired with streaming output is SDK progress, not a
// terminal call. Error and independently completed calls own their payload.
const TOOL_CALL_COMPLETION = {
  "awaiting-input": "active",
  "input-streaming": "active",
  "input-complete": "active",
  "approval-requested": "active",
  "approval-responded": "active",
  complete: "result-dependent",
  error: "terminal",
} as const satisfies Record<
  ToolCallPart["state"],
  "active" | "result-dependent" | "terminal"
>;

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
  // Suspension is resumable; either active state can carry newer child messages.
  suspended: 0,
  finished: 2,
  error: 2,
} as const satisfies Record<SubagentPart["subagent"]["status"], number>;

type PartProvenance = "delta-streamed" | "snapshot-derived";
type PartSource = { provenance: PartProvenance; anchor: MessagePart };

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
  textSelections: Map<MessagePart, MessagePart[]>;
};

type CanonicalTextRange = {
  canonical: Extract<MessagePart, { type: "text" | "thinking" }>;
  start: number;
  end: number;
};
type IncomingTextRange = {
  incoming: Extract<MessagePart, { type: "text" | "thinking" }>;
  start: number;
  end: number;
};
type EmptyTextOptions = {
  canonicalRanges: CanonicalTextRange[];
  incomingRanges: IncomingTextRange[];
};
type SignedTextBoundariesOptions = {
  canonicalRanges: CanonicalTextRange[];
  incomingRanges: IncomingTextRange[];
  boundaries: Set<number>;
};
const preserveSignedTextBoundaries = ({
  canonicalRanges,
  incomingRanges,
  boundaries,
}: SignedTextBoundariesOptions) => {
  // A signature authenticates the entire provider block, never a slice.
  // Signed snapshots own their boundaries; unsigned snapshots cannot split
  // an already signed canonical block or copy its signature onto new bytes.
  const incomingSignedRanges = incomingRanges.filter(
    ({ incoming }) =>
      incoming.type === "thinking" && incoming.signature !== undefined,
  );
  const signedRanges = [
    ...incomingSignedRanges,
    ...canonicalRanges.filter(
      ({ canonical, start, end }) =>
        canonical.type === "thinking" &&
        canonical.signature !== undefined &&
        !incomingSignedRanges.some(
          (incoming) => incoming.start < end && incoming.end > start,
        ),
    ),
  ];
  for (const range of signedRanges) {
    boundaries.add(range.start);
    boundaries.add(range.end);
  }
  for (const boundary of boundaries) {
    if (
      signedRanges.some(
        (range) => range.start < boundary && boundary < range.end,
      )
    ) {
      boundaries.delete(boundary);
    }
  }
};

type TextualSnapshotMetadataOptions = {
  canonical: Extract<MessagePart, { type: "text" | "thinking" }> | undefined;
  incoming: Extract<MessagePart, { type: "text" | "thinking" }>;
  content: string;
  canonicalStart?: number | undefined;
  contentStart?: number | undefined;
};

// Empty reasoning blocks carry opaque data: offsets alone cannot identify them.
const textualMetadataIdentityMatches = ({
  canonical,
  incoming,
  content,
  canonicalStart,
  contentStart,
}: TextualSnapshotMetadataOptions) => {
  if (canonical === undefined) {
    return false;
  }
  if (canonical.type !== incoming.type) {
    return false;
  }
  if (canonical.type !== "thinking" || incoming.type !== "thinking") {
    return true;
  }
  const sameStep =
    canonical.stepId !== undefined && canonical.stepId === incoming.stepId;
  const sameRedactedIdentity =
    canonical.redacted === true &&
    incoming.redacted === true &&
    canonical.signature !== undefined &&
    canonical.signature === incoming.signature;
  if (content === "" && !sameStep && !sameRedactedIdentity) {
    return false;
  }
  if (
    content !== "" &&
    canonical.stepId !== undefined &&
    incoming.stepId !== undefined &&
    !sameStep
  ) {
    return false;
  }
  return (
    canonical.signature === undefined ||
    (canonical.content === content && canonicalStart === contentStart)
  );
};

// Completion snapshots own newly supplied replay metadata; an unsigned replay
// cannot erase the provider artefact already attached to compatible content.
const mergeTextualSnapshotMetadata = ({
  canonical: previous,
  incoming,
  content,
  canonicalStart,
  contentStart,
}: TextualSnapshotMetadataOptions) => {
  const canonical =
    previous !== undefined &&
    textualMetadataIdentityMatches({
      canonical: previous,
      incoming,
      content,
      canonicalStart,
      contentStart,
    })
      ? previous
      : undefined;
  // Preserve every SDK/provider field, including extensions not named by the
  // upstream types. Defined incoming fields replace compatible canonical fields;
  // omitted fields neither erase metadata nor introduce undefined keys.
  const fields = Object.fromEntries(
    [canonical, incoming].flatMap((part) =>
      part === undefined
        ? []
        : Object.entries(part).filter(([, value]) => value !== undefined),
    ),
  );
  switch (incoming.type) {
    case "text":
      return { ...fields, type: incoming.type, content };
    case "thinking":
      return { ...fields, type: incoming.type, content };
    default:
      incoming satisfies never;
      return panic("Unhandled textual snapshot metadata");
  }
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

type SnapshotLayoutOptions = {
  previous: UIMessage;
  snapshot: UIMessage;
  parts: UIMessage["parts"];
  textSelections: Map<MessagePart, MessagePart[]>;
  selectedParts: Map<MessagePart, MessagePart>;
};

type SnapshotPartsOptions = {
  previous: UIMessage;
  snapshot: UIMessage;
  preservesPartLayout: boolean;
  parseResultOutput: (content: string) => unknown;
};

type SnapshotOnlyTextOptions = Pick<
  SnapshotTextOptions,
  "snapshotParts" | "parts" | "part"
> & {
  sameKind: Extract<MessagePart, { type: "text" | "thinking" }>[];
  firstIncoming: MessagePart | undefined;
};

/** One turn owns provenance; snapshots and synthetic resume events cannot claim deltas. */
export class SnapshotPartReconciler {
  private readonly sources = new WeakMap<MessagePart, PartSource>();
  private readonly terminalCalls = new WeakMap<MessagePart, ToolCallPart>();

  private projection:
    | { type: "reconciled" }
    | { type: "sdk"; error: SnapshotReconciliationError } = {
    type: "reconciled",
  };

  private readonly reportFailure: typeof reportSnapshotFailure;

  constructor(
    initial: UIMessage["parts"],
    reportFailure = reportSnapshotFailure,
  ) {
    this.reportFailure = reportFailure;
    // Completed history is canonical transcript content on a continuation.
    for (const part of initial) {
      this.record(part, { provenance: "delta-streamed", anchor: part });
    }
  }

  get failure() {
    return this.projection.type === "sdk" ? this.projection.error : undefined;
  }

  private fallBack(error: SnapshotReconciliationError) {
    if (this.projection.type === "sdk") {
      return;
    }
    // One message permanently uses the SDK projection after contract drift;
    // mixing ownership rules again would compound the original mismatch.
    this.projection = { type: "sdk", error };
    this.reportFailure(error);
  }

  private record(part: MessagePart, source: PartSource) {
    this.sources.set(part, source);
  }

  private sourceOf(part: MessagePart) {
    const source = this.sources.get(part);
    if (source !== undefined) {
      return source;
    }
    this.fallBack(
      new SnapshotReconciliationError({
        message: "Reconciled part has no provenance",
        phase: "provenance",
      }),
    );
    const adopted = {
      provenance: "snapshot-derived",
      anchor: part,
    } satisfies PartSource;
    this.record(part, adopted);
    return adopted;
  }

  provenanceOf(part: MessagePart) {
    return this.sourceOf(part).provenance;
  }

  reconcileDelta({ before, after, chunk }: DeltaPartsOptions) {
    if (this.projection.type === "sdk") {
      return after;
    }
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
      this.fallBack(
        new SnapshotReconciliationError({
          message: "Textual delta produced no textual part",
          phase: "textual-delta",
        }),
      );
      return after;
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
      parts[existingIndex] = mergeTextualSnapshotMetadata({
        canonical: existing,
        incoming: updated,
        content: existing.content + chunk.delta,
      });
    } else {
      parts.push(
        mergeTextualSnapshotMetadata({
          canonical: undefined,
          incoming: updated,
          content: chunk.delta,
        }),
      );
    }
    return parts;
  }

  reconcileEmptyText({ canonicalRanges, incomingRanges }: EmptyTextOptions) {
    const fragments = [];
    const emptySelections = new Map<MessagePart, MessagePart[]>();
    const consumedEmpty = new Set<MessagePart>();
    for (const range of incomingRanges) {
      if (range.start !== range.end) {
        continue;
      }
      const canonical = canonicalRanges.find(
        (candidate) =>
          candidate.start === range.start &&
          candidate.start === candidate.end &&
          !consumedEmpty.has(candidate.canonical) &&
          textualMetadataIdentityMatches({
            canonical: candidate.canonical,
            incoming: range.incoming,
            content: "",
          }),
      )?.canonical;
      const selected =
        canonical === undefined
          ? this.snapshot(
              mergeTextualSnapshotMetadata({
                canonical: undefined,
                incoming: range.incoming,
                content: "",
              }),
            )
          : this.inherit(
              mergeTextualSnapshotMetadata({
                canonical,
                incoming: range.incoming,
                content: "",
              }),
              canonical,
            );
      if (canonical !== undefined) {
        consumedEmpty.add(canonical);
      }
      fragments.push({
        canonical: canonical ?? range.incoming,
        selected,
        start: range.start,
        end: range.end,
      });
      emptySelections.set(range.incoming, [selected]);
    }
    for (const range of canonicalRanges) {
      if (range.start === range.end && !consumedEmpty.has(range.canonical)) {
        fragments.push({
          canonical: range.canonical,
          selected: range.canonical,
          start: range.start,
          end: range.end,
        });
      }
    }
    return { fragments, emptySelections };
  }

  private reconcileSnapshotOnlyText({
    sameKind,
    snapshotParts,
    parts,
    part,
    firstIncoming,
  }: SnapshotOnlyTextOptions) {
    if (firstIncoming === part) {
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts.at(index)?.type === part.type) {
          parts.splice(index, 1);
        }
      }
    }
    // Content selection is separate from placement: the ordered snapshot
    // projection places each segment beside its actual neighboring parts.
    let offset = 0;
    for (const incoming of snapshotParts) {
      if (incoming === part) {
        break;
      }
      if (
        (incoming.type === "text" || incoming.type === "thinking") &&
        incoming.type === part.type
      ) {
        offset += incoming.content.length;
      }
    }
    let canonicalOffset = 0;
    const canonical = sameKind.find((candidate) => {
      const start = canonicalOffset;
      canonicalOffset += candidate.content.length;
      return (
        start === offset &&
        candidate.content === part.content &&
        textualMetadataIdentityMatches({
          canonical: candidate,
          incoming: part,
          content: part.content,
        })
      );
    });
    parts.push(
      this.snapshot(
        mergeTextualSnapshotMetadata({
          canonical,
          incoming: part,
          content: part.content,
        }),
      ),
    );
  }

  reconcileText({
    previousParts,
    snapshotParts,
    parts,
    part,
    preservesPartLayout,
    textSelections,
  }: SnapshotTextOptions) {
    const sameKind = previousParts
      .filter(
        (existing) => existing.type === "text" || existing.type === "thinking",
      )
      .filter((existing) => existing.type === part.type);
    const hasDeltas = sameKind.some(
      (candidate) => this.provenanceOf(candidate) === "delta-streamed",
    );
    const firstIncoming = snapshotParts.find(
      (candidate) => candidate.type === part.type,
    );
    const content = sameKind.map((candidate) => candidate.content).join("");
    const snapshotContent = snapshotParts
      .flatMap((candidate) =>
        (candidate.type === "text" || candidate.type === "thinking") &&
        candidate.type === part.type
          ? [candidate.content]
          : [],
      )
      .join("");
    // Signed blocks retain their authenticated boundaries; unsigned snapshots
    // own segmentation and may replace obsolete slots.
    const canReconcileRanges =
      sameKind.some(
        (candidate) =>
          candidate.type === "thinking" && candidate.signature !== undefined,
      ) &&
      content.length > 0 &&
      preservesPartLayout &&
      snapshotContent.length >= content.length &&
      snapshotContent.startsWith(content);
    if (!hasDeltas && !canReconcileRanges) {
      this.reconcileSnapshotOnlyText({
        sameKind,
        snapshotParts,
        parts,
        part,
        firstIncoming,
      });
      return;
    }
    if (firstIncoming !== part) {
      return;
    }
    // Explicit UI snapshots may complete a streamed sequence even when their
    // segments split or merge. Compare whole content and retain delta placement.
    if (
      !preservesPartLayout ||
      snapshotContent.length < content.length ||
      !snapshotContent.startsWith(content)
    ) {
      return;
    }
    const last = sameKind.at(-1);
    if (last === undefined) {
      panic("Streamed text sequence has no final slot");
    }
    // Preserve canonical boundaries and add snapshot boundaries only where
    // another part interrupts the textual sequence. Completion bytes belong
    // beside the snapshot anchor, even when it was absent from the stream.
    const boundaries = new Set<number>();
    let offset = 0;
    const canonicalRanges = sameKind.map((canonical) => {
      const start = offset;
      offset += canonical.content.length;
      if (canonical !== last) {
        boundaries.add(offset);
      }
      return { canonical, start, end: offset };
    });
    offset = 0;
    let previousIndex = -1;
    const incomingRanges = [];
    for (const [index, incoming] of snapshotParts.entries()) {
      if (
        (incoming.type !== "text" && incoming.type !== "thinking") ||
        incoming.type !== part.type
      ) {
        continue;
      }
      if (previousIndex !== -1) {
        boundaries.add(offset);
      }
      const start = offset;
      offset += incoming.content.length;
      incomingRanges.push({ incoming, start, end: offset });
      previousIndex = index;
    }
    boundaries.add(snapshotContent.length);
    preserveSignedTextBoundaries({
      canonicalRanges,
      incomingRanges,
      boundaries,
    });
    let start = 0;
    const { fragments, emptySelections } = this.reconcileEmptyText({
      canonicalRanges,
      incomingRanges,
    });
    for (const end of [...boundaries].toSorted((left, right) => left - right)) {
      if (end <= start) {
        continue;
      }
      const fragmentStart = start;
      const canonicalRange = canonicalRanges.find(
        (range) => fragmentStart < range.end,
      );
      const canonical = canonicalRange?.canonical ?? last;
      const incoming = incomingRanges.find(
        (range) => fragmentStart < range.end,
      )?.incoming;
      if (incoming === undefined) {
        this.fallBack(
          new SnapshotReconciliationError({
            message: "Textual snapshot fragment has no incoming range",
            phase: "normalization",
          }),
        );
        return;
      }
      const selected = this.inherit(
        mergeTextualSnapshotMetadata({
          canonical,
          incoming,
          content: snapshotContent.slice(start, end),
          canonicalStart: canonicalRange?.start,
          contentStart: fragmentStart,
        }),
        canonical,
      );
      fragments.push({ canonical, selected, start, end });
      start = end;
    }
    fragments.sort(
      (left, right) => left.start - right.start || left.end - right.end,
    );
    for (const canonical of sameKind) {
      const index = parts.indexOf(canonical);
      if (index === -1) {
        panic("Streamed text lost its canonical slot");
      }
      parts.splice(
        index,
        1,
        ...fragments
          .filter((fragment) => fragment.canonical === canonical)
          .map((fragment) => fragment.selected),
      );
    }
    for (const range of incomingRanges) {
      textSelections.set(
        range.incoming,
        emptySelections.get(range.incoming) ??
          fragments
            .filter(
              (fragment) =>
                fragment.start < range.end && fragment.end > range.start,
            )
            .map((fragment) => fragment.selected),
      );
    }
  }

  reconcile({
    previous: previousMessage,
    snapshot: snapshotMessage,
    preservesPartLayout,
    parseResultOutput,
  }: SnapshotPartsOptions): UIMessage["parts"] {
    for (const part of previousMessage.parts) {
      this.sourceOf(part);
    }
    if (this.projection.type === "sdk") {
      return snapshotMessage.parts.map((part) => this.snapshot(part));
    }
    const seen = new Set<MessagePart>();
    const previous = {
      ...previousMessage,
      parts: previousMessage.parts.map((part) => {
        const retained = this.inherit({ ...part }, part);
        if (seen.has(part)) {
          this.record(retained, {
            provenance: this.provenanceOf(part),
            anchor: retained,
          });
        }
        seen.add(part);
        return retained;
      }),
    };
    const snapshot = {
      ...snapshotMessage,
      parts: snapshotMessage.parts.map((part) => this.snapshot({ ...part })),
    };
    const parts = [...previous.parts];
    const textSelections = new Map<MessagePart, MessagePart[]>();
    const selectedParts = new Map<MessagePart, MessagePart>();
    const matchPart = createSnapshotPartMatcher(parts);
    for (const part of snapshot.parts) {
      const canonical = matchPart(snapshotPartIdentity(part))?.part;
      if (part.type === "text" || part.type === "thinking") {
        this.reconcileText({
          previousParts: previous.parts,
          snapshotParts: snapshot.parts,
          parts,
          part,
          preservesPartLayout,
          textSelections,
        });
        continue;
      }
      let selected = canonical ?? part;
      switch (part.type) {
        case "tool-call":
          break;
        case "tool-result":
          if (canonical?.type === "tool-result") {
            selected = reconcileSnapshotResult({ canonical, snapshot: part });
          }
          break;
        case "structured-output":
          if (
            canonical?.type !== "structured-output" ||
            this.shouldReplace({
              canonical,
              snapshot: part,
              canonicalFinality: STRUCTURED_OUTPUT_FINALITY[canonical.status],
              snapshotFinality: STRUCTURED_OUTPUT_FINALITY[part.status],
            })
          ) {
            selected = part;
          }
          break;
        case "subagent":
          if (
            canonical?.type !== "subagent" ||
            this.shouldReplace({
              canonical,
              snapshot: part,
              canonicalFinality: SUBAGENT_FINALITY[canonical.subagent.status],
              snapshotFinality: SUBAGENT_FINALITY[part.subagent.status],
            })
          ) {
            selected = part;
          }
          break;
        case "activity":
        case "ui-resource":
        case "image":
        case "audio":
        case "video":
        case "document":
          if (
            canonical === undefined ||
            this.shouldReplace({ canonical, snapshot: part })
          ) {
            selected = part;
          }
          break;
        default:
          part satisfies never;
          panic("Unhandled snapshot message part");
      }
      const index = canonical === undefined ? -1 : parts.indexOf(canonical);
      if (index === -1) {
        parts.push(selected);
      } else {
        parts[index] = selected;
      }
      selectedParts.set(part, selected);
    }
    if (this.failure !== undefined) {
      return snapshotMessage.parts.map((part) => this.snapshot(part));
    }
    const reconciled = this.reconcileCalls({
      parts,
      previous,
      snapshot,
      parseResultOutput,
    });
    for (const [incoming, selected] of selectedParts) {
      const updated = reconciled.at(parts.indexOf(selected));
      if (updated !== undefined) {
        selectedParts.set(incoming, updated);
      }
    }
    return this.reconcileLayout({
      previous,
      snapshot,
      textSelections,
      selectedParts,
      parts: reconciled,
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
      this.record(part, { provenance: "snapshot-derived", anchor: part });
    }
    return part;
  }

  inherit(part: MessagePart, previous: MessagePart) {
    this.record(part, this.sourceOf(previous));
    return part;
  }

  observe(before: UIMessage["parts"], after: UIMessage["parts"]) {
    for (const [index, part] of after.entries()) {
      if (this.sources.has(part)) {
        continue;
      }
      const previous = before.at(index);
      this.record(part, {
        provenance:
          previous !== undefined && deepEquals(previous, part)
            ? this.provenanceOf(previous)
            : "delta-streamed",
        anchor:
          previous !== undefined && previous.type === part.type
            ? this.sourceOf(previous).anchor
            : part,
      });
    }
  }

  adoptSnapshot(selected: UIMessage["parts"], normalized: UIMessage["parts"]) {
    if (
      selected.length !== normalized.length ||
      normalized.some((part, index) => selected.at(index)?.type !== part.type)
    ) {
      this.fallBack(
        new SnapshotReconciliationError({
          message: "SDK snapshot normalization changed reconciled part slots",
          phase: "normalization",
        }),
      );
    }
    if (this.projection.type === "sdk") {
      for (const part of normalized) {
        this.snapshot(part);
      }
      return;
    }
    for (const [index, part] of normalized.entries()) {
      const previous = selected.at(index);
      if (previous === undefined || previous.type !== part.type) {
        return;
      }
      this.record(part, this.sourceOf(previous));
    }
  }

  private sameSnapshotSlot(candidate: MessagePart, incoming: MessagePart) {
    return deepEquals(
      snapshotPartIdentity(candidate),
      snapshotPartIdentity(incoming),
    );
  }

  private reconcileLayout({
    previous,
    snapshot,
    parts,
    textSelections,
    selectedParts,
  }: SnapshotLayoutOptions) {
    const used = new Set<MessagePart>();
    const layout: { incoming: MessagePart; selected: MessagePart }[] = [];
    const matchPart = createSnapshotPartMatcher(parts);
    for (const incoming of snapshot.parts) {
      const retainedText =
        (incoming.type === "text" || incoming.type === "thinking") &&
        previous.parts.some(
          (part) =>
            part.type === incoming.type &&
            this.provenanceOf(part) === "delta-streamed",
        )
          ? parts.findLast((part) => part.type === incoming.type)
          : undefined;
      const selections = textSelections.get(incoming) ?? [
        selectedParts.get(incoming) ??
          matchPart(snapshotPartIdentity(incoming))?.part ??
          retainedText ??
          incoming,
      ];
      for (const selected of selections) {
        if (!parts.includes(selected)) {
          parts.push(selected);
        }
        if (!used.has(selected)) {
          used.add(selected);
          layout.push({ incoming, selected });
        }
      }
    }
    const ordered = parts.filter(
      (part) => !used.has(part) || this.provenanceOf(part) === "delta-streamed",
    );
    const previousPositions = new Map(
      previous.parts.map((part, index) => [this.sourceOf(part).anchor, index]),
    );
    let cursor = ordered.length;
    for (const { incoming, selected } of layout) {
      const previousIndex = previous.parts.findIndex(
        (part) =>
          this.sourceOf(part).anchor === this.sourceOf(selected).anchor ||
          (incoming.type === "text" || incoming.type === "thinking"
            ? part.type === incoming.type
            : this.sameSnapshotSlot(part, incoming)),
      );
      if (previousIndex === -1) {
        continue;
      }
      cursor = ordered.filter((part) => {
        const position = previousPositions.get(this.sourceOf(part).anchor);
        return position !== undefined && position < previousIndex;
      }).length;
      break;
    }
    for (const { selected } of layout) {
      const retainedIndex = ordered.indexOf(selected);
      if (retainedIndex !== -1) {
        cursor = Math.max(cursor, retainedIndex + 1);
      } else {
        ordered.splice(cursor, 0, selected);
        cursor += 1;
      }
    }
    return ordered;
  }

  private reconcileCalls({
    parts,
    previous,
    snapshot,
    parseResultOutput,
  }: SnapshotCallPartsOptions) {
    const matchCanonical = createSnapshotPartMatcher(previous.parts);
    const matchSnapshot = createSnapshotPartMatcher(snapshot.parts);
    const matchResult = createSnapshotPartMatcher(parts);
    return parts.map((part) => {
      if (part.type !== "tool-call") {
        return part;
      }
      const resultIdentity = { type: "tool-result", id: part.id } as const;
      const result = matchResult(resultIdentity)?.part;
      const canonicalResult = matchCanonical(resultIdentity)?.part;
      const canonicalCall = matchCanonical(snapshotPartIdentity(part))?.part;
      const updated = matchSnapshot(snapshotPartIdentity(part))?.part;
      if (canonicalCall?.type === "tool-call") {
        const completion = TOOL_CALL_COMPLETION[canonicalCall.state];
        // A later streaming sibling cannot turn an independently terminal
        // call into SDK progress on the next snapshot.
        if (
          !this.terminalCalls.has(this.sourceOf(canonicalCall).anchor) &&
          (completion === "terminal" ||
            (completion === "result-dependent" &&
              (canonicalResult?.type !== "tool-result" ||
                canonicalResult.state !== "streaming")))
        ) {
          this.terminalCalls.set(
            this.sourceOf(canonicalCall).anchor,
            canonicalCall,
          );
        }
      }
      const terminalCall = this.terminalCalls.get(this.sourceOf(part).anchor);
      if (terminalCall !== undefined) {
        return this.inherit(
          reconcileSnapshotCall({
            selected: terminalCall,
            other: terminalCall,
            resultSelected: false,
          }),
          terminalCall,
        );
      }
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
