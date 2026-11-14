import { EventType } from "@tanstack/ai";
import type {
  ActivityPart,
  MessagePart,
  SubagentPart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";
import { deepEquals } from "bun";
import { expect, test } from "bun:test";

import {
  createSnapshotActivityReconciler,
  reconcileSnapshotCall,
  reconcileSnapshotResult,
  SnapshotPartReconciler,
  SnapshotReconciliationError,
} from "@/api/handlers/chat/snapshot-reconciliation";

test("a suspended subagent resumes with updated messages and stays terminal once settled", () => {
  const child = (
    status: SubagentPart["subagent"]["status"],
    content: string,
  ): SubagentPart => ({
    type: "subagent",
    subagent: {
      id: "child",
      name: "Review",
      status,
      messages: [
        {
          id: "child-answer",
          role: "assistant",
          parts: [{ type: "text", content }],
        },
      ],
    },
  });
  for (const terminal of ["finished", "error"] as const) {
    const owner = new SnapshotPartReconciler([]);
    let parts: UIMessage["parts"] = [];
    const reconcile = (part: SubagentPart) => {
      parts = owner.reconcile({
        previous: { id: "parent", role: "assistant", parts },
        snapshot: { id: "parent", role: "assistant", parts: [part] },
        preservesPartLayout: true,
        parseResultOutput: (content) => content,
      });
      return parts;
    };
    reconcile(child("running", "Before suspension"));
    reconcile(child("suspended", "Awaiting approval"));
    const resumed = child("running", "After approval");
    expect(reconcile(resumed)).toEqual([resumed]);
    const settled = child(terminal, "Final child transcript");
    expect(reconcile(settled)).toEqual([settled]);
    for (const status of ["running", "suspended"] as const) {
      expect(reconcile(child(status, "Stale active transcript"))).toEqual([
        settled,
      ]);
    }
  }
});

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

const sdkPartExamples = {
  text: { type: "text", content: "Answer" },
  thinking: { type: "thinking", content: "Reason", stepId: "step" },
  "tool-call": {
    type: "tool-call",
    id: "call",
    name: "lookup",
    arguments: "{}",
    state: "input-complete",
  },
  "tool-result": {
    type: "tool-result",
    toolCallId: "call",
    content: "Result",
    state: "complete",
  },
  activity: {
    type: "activity",
    activityType: "review",
    content: { value: "Activity" },
  },
  "structured-output": {
    type: "structured-output",
    status: "complete",
    raw: "{}",
    data: {},
  },
  subagent: {
    type: "subagent",
    subagent: { id: "child", name: "Review", status: "finished", messages: [] },
  },
  "ui-resource": {
    type: "ui-resource",
    toolCallId: "call",
    toolName: "lookup",
    resource: { uri: "ui://view", mimeType: "text/html", text: "View" },
  },
  image: {
    type: "image",
    source: {
      type: "url",
      value: "https://example.test/image.png",
      mimeType: "image/png",
    },
  },
  audio: {
    type: "audio",
    source: {
      type: "url",
      value: "https://example.test/audio.mp3",
      mimeType: "audio/mpeg",
    },
  },
  video: {
    type: "video",
    source: {
      type: "url",
      value: "https://example.test/video.mp4",
      mimeType: "video/mp4",
    },
  },
  document: {
    type: "document",
    source: {
      type: "url",
      value: "https://example.test/document.pdf",
      mimeType: "application/pdf",
    },
  },
} as const satisfies {
  [Kind in MessagePart["type"]]: Extract<MessagePart, { type: Kind }>;
};

for (const example of Object.values(sdkPartExamples)) {
  test(`every ${example.type} carries its owner through SDK clones and snapshots`, () => {
    const owner = new SnapshotPartReconciler([]);
    owner.snapshot(example);
    expect(owner.provenanceOf(example)).toBe("snapshot-derived");
    const normalized = structuredClone(example);
    owner.adoptSnapshot([example], [normalized]);
    expect(owner.provenanceOf(normalized)).toBe("snapshot-derived");
    const synthetic = structuredClone(normalized);
    owner.observe([normalized], [synthetic]);
    expect(owner.provenanceOf(synthetic)).toBe("snapshot-derived");
    const delta = structuredClone(example);
    owner.observe([], [delta]);
    expect(owner.provenanceOf(delta)).toBe("delta-streamed");
    owner.snapshot(delta);
    expect(owner.provenanceOf(delta)).toBe("delta-streamed");
  });
}

test("SDK contract drift is observed once and retains the SDK projection for the message", () => {
  for (const phase of [
    "provenance",
    "normalization",
    "textual-delta",
  ] as const) {
    const observed: SnapshotReconciliationError[] = [];
    const original = { type: "text", content: "before" } as const;
    const incoming = { type: "thinking", content: "SDK projection" } as const;
    const owner = new SnapshotPartReconciler([original], (error) => {
      observed.push(error);
    });
    switch (phase) {
      case "provenance":
        owner.observe([incoming], [{ ...incoming }]);
        break;
      case "normalization":
        owner.adoptSnapshot([original], [incoming]);
        break;
      case "textual-delta":
        expect(
          owner.reconcileDelta({
            before: [original],
            after: [incoming],
            chunk: {
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: "answer",
              delta: "next",
            },
          }),
        ).toEqual([incoming]);
        break;
      default:
        phase satisfies never;
    }
    expect(observed).toHaveLength(1);
    expect(observed.at(0)).toBeInstanceOf(SnapshotReconciliationError);
    expect(observed.at(0)?.phase).toBe(phase);
    expect(owner.failure).toBe(observed.at(0));
    expect(
      owner.reconcile({
        previous: { id: "answer", role: "assistant", parts: [original] },
        snapshot: { id: "answer", role: "assistant", parts: [incoming] },
        preservesPartLayout: true,
        parseResultOutput: (content) => content,
      }),
    ).toEqual([incoming]);
    const normalized = [
      { type: "text", content: "later SDK projection" },
    ] satisfies UIMessage["parts"];
    owner.adoptSnapshot([incoming], normalized);
    expect(
      owner.reconcileDelta({
        before: [incoming],
        after: normalized,
        chunk: {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "answer",
          delta: "unreconciled",
        },
      }),
    ).toBe(normalized);
    expect(observed).toHaveLength(1);
  }
});

test("SDK snapshot normalization detects removed slots and empty projections", () => {
  const original = [
    { type: "text", content: "before" },
  ] satisfies UIMessage["parts"];
  const failures: SnapshotReconciliationError[] = [];
  const owner = new SnapshotPartReconciler(original, (error) => {
    failures.push(error);
  });
  owner.adoptSnapshot(original, []);
  expect(failures.at(0)?.phase).toBe("normalization");
  expect(
    owner.reconcile({
      previous: { id: "answer", role: "assistant", parts: original },
      snapshot: { id: "answer", role: "assistant", parts: [] },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    }),
  ).toEqual([]);
});

const textualMetadataCases = [
  {
    name: "snapshot-only signed thinking survives an unsigned snapshot with identical content",
    initial: [],
    incoming: [
      {
        type: "thinking",
        content: "AB",
        signature: "opaque",
        stepId: "step",
        redacted: false,
      },
    ],
    replay: [{ type: "thinking", content: "AB" }],
    expected: [
      {
        type: "thinking",
        content: "AB",
        signature: "opaque",
        stepId: "step",
        redacted: false,
      },
    ],
  },
  {
    name: "absent replay fields stay absent after textual normalization",
    initial: [],
    incoming: [
      {
        type: "thinking",
        content: "AB",
      },
    ],
    replay: [{ type: "thinking", content: "AB" }],
    expected: [{ type: "thinking", content: "AB" }],
  },

  {
    name: "a signed snapshot merges unsigned thinking segments into one provider block",
    initial: [
      { type: "thinking", content: "A", stepId: "streamed-step" },
      { type: "thinking", content: "B", stepId: "streamed-step" },
    ],
    incoming: [
      { type: "thinking", content: "AB", signature: "opaque-signature" },
    ],
    replay: [
      { type: "thinking", content: "A" },
      { type: "thinking", content: "B" },
    ],
    expected: [
      {
        type: "thinking",
        content: "AB",
        stepId: "streamed-step",
        signature: "opaque-signature",
      },
    ],
  },
  {
    name: "unsigned snapshot segments cannot split a canonical signed thinking block",
    initial: [
      {
        type: "thinking",
        content: "AB",
        stepId: "streamed-step",
        signature: "opaque-signature",
      },
    ],
    incoming: [
      { type: "thinking", content: "A" },
      { type: "thinking", content: "B" },
    ],
    replay: [{ type: "thinking", content: "AB" }],
    expected: [
      {
        type: "thinking",
        content: "AB",
        stepId: "streamed-step",
        signature: "opaque-signature",
      },
    ],
  },
  {
    name: "an empty redacted thinking snapshot retains its provider artefact",
    initial: [{ type: "thinking", content: "", stepId: "streamed-step" }],
    incoming: [
      {
        type: "thinking",
        content: "",
        signature: "opaque-redacted-data",
        stepId: "streamed-step",
        redacted: true,
      },
    ],
    replay: [{ type: "thinking", content: "", stepId: "streamed-step" }],
    expected: [
      {
        type: "thinking",
        content: "",
        stepId: "streamed-step",
        signature: "opaque-redacted-data",
        redacted: true,
      },
    ],
  },
  {
    name: "supplied null text metadata replaces canonical metadata and survives an absent replay field",
    initial: [{ type: "text", content: "AB", metadata: { provider: "old" } }],
    incoming: [{ type: "text", content: "AB", metadata: null }],
    replay: [{ type: "text", content: "AB" }],
    expected: [{ type: "text", content: "AB", metadata: null }],
  },
] satisfies {
  name: string;
  initial: UIMessage["parts"];
  incoming: UIMessage["parts"];
  replay: UIMessage["parts"];
  expected: UIMessage["parts"];
}[];

for (const scenario of textualMetadataCases) {
  test(scenario.name, () => {
    const failures: SnapshotReconciliationError[] = [];
    const owner = new SnapshotPartReconciler(scenario.initial, (error) => {
      failures.push(error);
    });
    let parts: UIMessage["parts"] = scenario.initial;
    for (const incoming of [scenario.incoming, scenario.replay]) {
      parts = owner.reconcile({
        previous: { id: "answer", role: "assistant", parts },
        snapshot: { id: "answer", role: "assistant", parts: incoming },
        preservesPartLayout: true,
        parseResultOutput: (content) => content,
      });
      expect(parts).toEqual(scenario.expected);
      expect(deepEquals(parts, scenario.expected)).toBe(true);
    }
    expect(failures).toEqual([]);
    expect(owner.failure).toBeUndefined();
  });
}

test("unsigned snapshots own segmentation while signed blocks retain authenticated boundaries", () => {
  for (const signed of [false, true]) {
    const initial = ["A", "B"].map((content) => ({
      type: "thinking" as const,
      content,
      ...(signed ? { signature: `signature-${content}` } : {}),
    }));
    const incoming = [{ type: "thinking", content: "AB" }] as const;
    const owner = new SnapshotPartReconciler([]);
    const canonical = owner.reconcile({
      previous: { id: "answer", role: "assistant", parts: [] },
      snapshot: { id: "answer", role: "assistant", parts: initial },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    });
    const parts = owner.reconcile({
      previous: { id: "answer", role: "assistant", parts: canonical },
      snapshot: { id: "answer", role: "assistant", parts: [...incoming] },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    });
    expect(parts).toEqual(signed ? initial : [...incoming]);
    expect(owner.failure).toBeUndefined();
  }
});

test("empty placeholders from another step cannot inherit opaque reasoning metadata", () => {
  const initial = [
    {
      type: "thinking",
      content: "",
      stepId: "signed-step",
      signature: "opaque",
      redacted: true,
    },
  ] satisfies UIMessage["parts"];
  const incoming = [
    { type: "thinking", content: "", stepId: "other-step" },
  ] satisfies UIMessage["parts"];
  const owner = new SnapshotPartReconciler(initial);
  const parts = owner.reconcile({
    previous: { id: "answer", role: "assistant", parts: initial },
    snapshot: { id: "answer", role: "assistant", parts: incoming },
    preservesPartLayout: true,
    parseResultOutput: (content) => content,
  });
  expect(
    parts.find(
      (part) => part.type === "thinking" && part.stepId === "other-step",
    ),
  ).toEqual(incoming.at(0));
  expect(
    parts.find(
      (part) => part.type === "thinking" && part.stepId === "signed-step",
    ),
  ).toEqual(initial.at(0));
});

test("textual range drift reports once and adopts the SDK projection", () => {
  const initial = [
    { type: "text", content: "AB" },
  ] satisfies UIMessage["parts"];
  const failures: SnapshotReconciliationError[] = [];
  const owner = new SnapshotPartReconciler(initial, (error) => {
    failures.push(error);
  });
  let reads = 0;
  const incoming = {
    type: "text",
    get content() {
      reads += 1;
      // Simulate SDK range data changing after the content consistency check.
      return reads === 1 ? "AB" : "";
    },
  } satisfies MessagePart;
  owner.reconcileText({
    previousParts: initial,
    snapshotParts: [incoming],
    parts: [...initial],
    part: incoming,
    preservesPartLayout: true,
    textSelections: new Map(),
  });
  expect(failures.map((error) => error.message)).toEqual([
    "Textual snapshot fragment has no incoming range",
  ]);
  const snapshot = [
    { type: "text", content: "SDK" },
  ] satisfies UIMessage["parts"];
  expect(
    owner.reconcile({
      previous: { id: "answer", role: "assistant", parts: initial },
      snapshot: { id: "answer", role: "assistant", parts: snapshot },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    }),
  ).toEqual(snapshot);
  expect(failures).toHaveLength(1);
});

test("stepId-less empty placeholders cannot inherit a redacted provider block", () => {
  const signed = {
    type: "thinking",
    content: "",
    signature: "opaque",
    redacted: true,
    provenance: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      format: "anthropic-redacted-thinking",
    },
  } as const;
  const placeholder = { type: "thinking", content: "" } as const;
  for (const initial of [[], [signed]]) {
    const owner = new SnapshotPartReconciler(initial);
    const previous =
      initial.length === 0
        ? owner.reconcile({
            previous: { id: "answer", role: "assistant", parts: [] },
            snapshot: { id: "answer", role: "assistant", parts: [signed] },
            preservesPartLayout: true,
            parseResultOutput: (content) => content,
          })
        : initial;
    const parts = owner.reconcile({
      previous: { id: "answer", role: "assistant", parts: previous },
      snapshot: { id: "answer", role: "assistant", parts: [placeholder] },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    });
    expect(parts.some((part) => deepEquals(part, placeholder))).toBe(true);
    expect(
      parts.filter(
        (part) => part.type === "thinking" && part.signature !== undefined,
      ),
    ).toHaveLength(initial.length);
  }
});
