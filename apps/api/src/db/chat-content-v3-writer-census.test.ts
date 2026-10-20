import type { MessagePart } from "@tanstack/ai/client";
import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { accountLegacyChatContent } from "./chat-content-v3-accounting";
import {
  convertLegacyChatContent,
  LegacyChatContentError,
} from "./chat-content-v3-legacy";
import {
  LEGACY_V1_WRITER_CENSUS,
  LEGACY_V2_WRITER_CENSUS,
  type V1WriterFieldCensus,
  type V2WriterFieldCensus,
} from "./chat-content-v3-writer-census";
import type { LegacyV1WriterPart } from "./chat-content-v3-writer-types";

const providerMetadata = { fixture: { opaque: "synthetic-provider-token" } };
const v1Baselines = {
  text: { type: "text", text: "synthetic" },
  reasoning: { type: "reasoning", text: "synthetic" },
  "tool-*": {
    type: "tool-search",
    toolCallId: "call",
    state: "output-available",
    input: {},
    output: {},
  },
  "dynamic-tool": {
    type: "dynamic-tool",
    toolName: "mcp__fixture__search",
    toolCallId: "call",
    state: "approval-responded",
    input: {},
    approval: { id: "approval", approved: true },
  },
  "source-url": {
    type: "source-url",
    sourceId: "source",
    url: "https://example.invalid/source",
  },
  "source-document": {
    type: "source-document",
    sourceId: "source",
    mediaType: "application/pdf",
    title: "synthetic",
  },
  file: {
    type: "file",
    mediaType: "image/png",
    url: "https://example.invalid/image.png",
  },
  "data-*": {
    type: "data-stella-anon-restorations",
    data: { pairs: [{ placeholder: "[PERSON_1]", original: "synthetic" }] },
  },
  "step-start": { type: "step-start" },
} as const satisfies Record<
  keyof typeof LEGACY_V1_WRITER_CENSUS,
  LegacyV1WriterPart
>;

// Required key maps bind the census to every upstream optional field, including
// fields on tool states other than the baseline state. New fields break the build.
const v1AllFields = {
  text: { ...v1Baselines.text, state: "done", providerMetadata },
  reasoning: { ...v1Baselines.reasoning, state: "done", providerMetadata },
  "tool-*": {
    ...v1Baselines["tool-*"],
    title: "synthetic",
    toolMetadata: {},
    providerExecuted: true,
    errorText: "synthetic failure",
    callProviderMetadata: providerMetadata,
    resultProviderMetadata: providerMetadata,
    preliminary: true,
    rawInput: {},
    approval: {
      id: "approval",
      approved: true,
      reason: "synthetic",
      signature: "synthetic",
    },
  },
  "dynamic-tool": {
    ...v1Baselines["dynamic-tool"],
    title: "synthetic",
    toolMetadata: {},
    providerExecuted: true,
    output: {},
    errorText: "synthetic failure",
    callProviderMetadata: providerMetadata,
    resultProviderMetadata: providerMetadata,
    preliminary: true,
    approval: {
      id: "approval",
      approved: true,
      reason: "synthetic",
      signature: "synthetic",
    },
  },
  "source-url": {
    ...v1Baselines["source-url"],
    title: "synthetic",
    providerMetadata,
  },
  "source-document": {
    ...v1Baselines["source-document"],
    filename: "synthetic.pdf",
    providerMetadata,
  },
  file: { ...v1Baselines.file, filename: "synthetic.png", providerMetadata },
  "data-*": { ...v1Baselines["data-*"], id: "data-id" },
  "step-start": v1Baselines["step-start"],
} as const satisfies V1WriterFieldCensus;

const source = {
  type: "url" as const,
  value: "https://example.invalid/media",
  mimeType: "image/png",
};
const v2Baselines = {
  activity: { type: "activity", activityType: "synthetic", content: {} },
  audio: { type: "audio", source: { ...source, mimeType: "audio/wav" } },
  document: {
    type: "document",
    source: { ...source, mimeType: "application/pdf" },
  },
  image: { type: "image", source },
  "structured-output": {
    type: "structured-output",
    status: "complete",
    raw: "{}",
    data: {},
  },
  subagent: {
    type: "subagent",
    subagent: {
      id: "synthetic",
      name: "synthetic",
      status: "finished",
      messages: [],
    },
  },
  text: { type: "text", content: "synthetic" },
  thinking: { type: "thinking", content: "synthetic" },
  "tool-call": {
    type: "tool-call",
    id: "call",
    name: "search",
    arguments: "{}",
    state: "complete",
    input: {},
  },
  "tool-result": {
    type: "tool-result",
    toolCallId: "call",
    content: "synthetic",
    state: "complete",
  },
  "ui-resource": {
    type: "ui-resource",
    toolCallId: "call",
    toolName: "search",
    resource: {
      uri: "ui://fixture/view",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>synthetic</p>",
    },
  },
  video: { type: "video", source: { ...source, mimeType: "video/mp4" } },
} as const satisfies Record<keyof typeof LEGACY_V2_WRITER_CENSUS, MessagePart>;

const v2AllFields = {
  activity: { ...v2Baselines.activity, subagentRunId: "synthetic" },
  audio: { ...v2Baselines.audio, id: "media", metadata: {} },
  document: { ...v2Baselines.document, id: "media", metadata: {} },
  image: { ...v2Baselines.image, id: "media", metadata: {} },
  "structured-output": {
    ...v2Baselines["structured-output"],
    partial: {},
    reasoning: "synthetic",
    errorMessage: "synthetic",
  },
  subagent: v2Baselines.subagent,
  text: { ...v2Baselines.text, providerMetadata },
  thinking: {
    ...v2Baselines.thinking,
    stepId: "step",
    signature: "synthetic",
    providerMetadata,
    redacted: false,
    provenance: {
      provider: "openai",
      model: "synthetic",
      format: "openai-item-id",
    },
  },
  "tool-call": {
    ...v2Baselines["tool-call"],
    approval: { id: "approval", needsApproval: true, approved: true },
    output: {},
    metadata: {},
    providerMetadata: { call: providerMetadata, result: providerMetadata },
  },
  "tool-result": {
    ...v2Baselines["tool-result"],
    id: "result",
    name: "search",
    outcome: "cancelled",
    error: "synthetic",
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  "ui-resource": {
    ...v2Baselines["ui-resource"],
    serverId: "fixture",
    meta: {},
  },
  video: { ...v2Baselines.video, id: "media", metadata: {} },
} as const satisfies V2WriterFieldCensus;

type FieldDisposition = "mapped" | "implied" | "refuse";
type FieldDispositions<T> = {
  [K in keyof T]: { [F in keyof T[K]]: FieldDisposition };
};
const v1FieldDispositions = {
  text: {
    type: "implied",
    text: "mapped",
    state: "implied",
    providerMetadata: "mapped",
  },
  reasoning: {
    type: "implied",
    text: "mapped",
    state: "implied",
    providerMetadata: "mapped",
  },
  "tool-*": {
    type: "implied",
    toolCallId: "mapped",
    state: "implied",
    input: "mapped",
    output: "mapped",
    title: "refuse",
    toolMetadata: "refuse",
    providerExecuted: "refuse",
    errorText: "refuse",
    callProviderMetadata: "mapped",
    resultProviderMetadata: "mapped",
    preliminary: "refuse",
    rawInput: "refuse",
    approval: "refuse",
  },
  "dynamic-tool": {
    type: "implied",
    toolName: "mapped",
    toolCallId: "mapped",
    state: "implied",
    input: "mapped",
    output: "mapped",
    title: "refuse",
    toolMetadata: "refuse",
    providerExecuted: "refuse",
    errorText: "refuse",
    callProviderMetadata: "mapped",
    resultProviderMetadata: "mapped",
    preliminary: "refuse",
    approval: "refuse",
  },
  "source-url": {
    type: "refuse",
    sourceId: "refuse",
    url: "refuse",
    title: "refuse",
    providerMetadata: "refuse",
  },
  "source-document": {
    type: "refuse",
    sourceId: "refuse",
    mediaType: "refuse",
    title: "refuse",
    filename: "refuse",
    providerMetadata: "refuse",
  },
  file: {
    type: "implied",
    mediaType: "mapped",
    url: "mapped",
    filename: "mapped",
    providerMetadata: "refuse",
  },
  "data-*": { type: "implied", data: "mapped", id: "refuse" },
  "step-start": { type: "implied" },
} as const satisfies FieldDispositions<V1WriterFieldCensus>;
const v2FieldDispositions = {
  activity: {
    type: "implied",
    activityType: "mapped",
    content: "mapped",
    subagentRunId: "mapped",
  },
  audio: {
    type: "implied",
    source: "mapped",
    id: "refuse",
    metadata: "refuse",
  },
  document: {
    type: "implied",
    source: "mapped",
    id: "refuse",
    metadata: "mapped",
  },
  image: {
    type: "implied",
    source: "mapped",
    id: "refuse",
    metadata: "mapped",
  },
  "structured-output": {
    type: "implied",
    status: "mapped",
    raw: "mapped",
    data: "mapped",
    partial: "mapped",
    reasoning: "mapped",
    errorMessage: "mapped",
  },
  subagent: { type: "refuse", subagent: "refuse" },
  text: { type: "implied", content: "mapped", providerMetadata: "mapped" },
  thinking: {
    type: "implied",
    content: "mapped",
    stepId: "mapped",
    signature: "mapped",
    redacted: "mapped",
    providerMetadata: "mapped",
    provenance: "mapped",
  },
  "tool-call": {
    type: "implied",
    id: "mapped",
    name: "mapped",
    arguments: "mapped",
    state: "mapped",
    input: "mapped",
    output: "mapped",
    approval: "mapped",
    metadata: "implied",
    providerMetadata: "mapped",
  },
  "tool-result": {
    type: "implied",
    toolCallId: "mapped",
    content: "mapped",
    state: "mapped",
    outcome: "mapped",
    error: "mapped",
    id: "refuse",
    name: "refuse",
    metadata: "refuse",
    createdAt: "refuse",
  },
  "ui-resource": {
    type: "implied",
    toolCallId: "mapped",
    toolName: "mapped",
    resource: "mapped",
    serverId: "mapped",
    meta: "mapped",
  },
  video: {
    type: "implied",
    source: "mapped",
    id: "refuse",
    metadata: "refuse",
  },
} as const satisfies FieldDispositions<V2WriterFieldCensus>;

type CheckCensusOptions = { version: 1 | 2; part: object };
const checkCensus = ({ version, part }: CheckCensusOptions) => {
  const content = { version, data: [part] };
  const result = Result.try({
    try: () => convertLegacyChatContent(content),
    catch: (error) => error,
  });
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(LegacyChatContentError);
    return "refuse";
  }
  expect(
    accountLegacyChatContent(content, result.value).unaccountedFields,
  ).toEqual([]);
  return result.value.data.length === 0 && result.value.metadata === undefined
    ? "drop"
    : "convert";
};

type WriterCasesOptions = {
  version: 1 | 2;
  baselines: Record<string, object>;
  allFields: Record<string, object>;
  dispositions: Record<string, "convert" | "refuse" | "drop">;
  fields: Record<string, Record<string, FieldDisposition>>;
};
const makeWriterCases = ({
  version,
  baselines,
  allFields,
  dispositions,
  fields,
}: WriterCasesOptions) =>
  Object.entries(baselines).map(([kind, baseline]) => {
    const full = allFields[kind];
    const disposition = dispositions[kind];
    const fieldDispositions = fields[kind];
    if (
      full === undefined ||
      disposition === undefined ||
      fieldDispositions === undefined
    ) {
      return panic(`Writer census omitted ${kind}`);
    }
    return { kind, version, baseline, full, disposition, fieldDispositions };
  });
const writerCases = [
  ...makeWriterCases({
    version: 1,
    baselines: v1Baselines,
    allFields: v1AllFields,
    dispositions: LEGACY_V1_WRITER_CENSUS,
    fields: v1FieldDispositions,
  }),
  ...makeWriterCases({
    version: 2,
    baselines: v2Baselines,
    allFields: v2AllFields,
    dispositions: LEGACY_V2_WRITER_CENSUS,
    fields: v2FieldDispositions,
  }),
];

test("writer census includes every kind and accounts for every accepted field", () => {
  for (const {
    kind,
    version,
    baseline,
    full,
    disposition,
    fieldDispositions,
  } of writerCases) {
    expect(checkCensus({ version, part: baseline })).toBe(disposition);
    expect(checkCensus({ version, part: full })).toBe(
      disposition === "refuse" ||
        Object.values(fieldDispositions).includes("refuse")
        ? "refuse"
        : disposition,
    );
    for (const [field, value] of Object.entries(full)) {
      expect({
        version,
        kind,
        field,
        disposition: checkCensus({
          version,
          part: { ...baseline, [field]: value },
        }),
      }).toEqual({
        version,
        kind,
        field,
        disposition:
          disposition === "refuse" || fieldDispositions[field] === "refuse"
            ? "refuse"
            : disposition,
      });
    }
  }
});

const writerPart = fc
  .constantFrom(...writerCases)
  .chain(({ version, baseline, full, disposition, fieldDispositions }) =>
    fc.subarray(Object.entries(full)).map((fields) => ({
      version,
      part: { ...baseline, ...Object.fromEntries(fields) },
      disposition:
        disposition === "refuse" ||
        fields.some(([field]) => fieldDispositions[field] === "refuse")
          ? "refuse"
          : disposition,
    })),
  );

test("writer optional fields are preserved or cause typed whole-message refusal", () => {
  assertProperty(
    "writer optional fields are preserved or cause typed whole-message refusal",
    fc.property(writerPart, (input) => {
      expect(checkCensus(input)).toBe(input.disposition);
    }),
  );
});

test("unknown fields on every writer kind cause whole-message refusal", () => {
  assertProperty(
    "unknown fields on every writer kind cause whole-message refusal",
    fc.property(writerPart, fc.jsonValue(), ({ version, part }, value) => {
      expect(
        checkCensus({ version, part: { ...part, unknownWriterField: value } }),
      ).toBe("refuse");
    }),
  );
});

type V1DynamicTool = Extract<LegacyV1WriterPart, { type: "dynamic-tool" }>;
const v1ToolStateCensus = {
  "input-streaming": {
    state: "input-streaming",
    input: {},
    callProviderMetadata: providerMetadata,
  },
  "input-available": {
    state: "input-available",
    input: {},
    callProviderMetadata: providerMetadata,
  },
  "approval-requested": {
    state: "approval-requested",
    input: {},
    callProviderMetadata: providerMetadata,
    approval: { id: "approval" },
  },
  "approval-responded": {
    state: "approval-responded",
    input: {},
    callProviderMetadata: providerMetadata,
    approval: { id: "approval", approved: true },
  },
  "output-available": {
    state: "output-available",
    input: {},
    output: {},
    callProviderMetadata: providerMetadata,
    resultProviderMetadata: providerMetadata,
  },
  "output-error": {
    state: "output-error",
    input: {},
    errorText: "synthetic failure",
    callProviderMetadata: providerMetadata,
    resultProviderMetadata: providerMetadata,
  },
  "output-denied": {
    state: "output-denied",
    input: {},
    callProviderMetadata: providerMetadata,
    approval: { id: "approval", approved: false },
  },
} as const satisfies {
  [S in V1DynamicTool["state"]]: Omit<
    Extract<V1DynamicTool, { state: S }>,
    "type" | "toolName" | "toolCallId"
  >;
};

const v1ToolStateDispositions = {
  "input-streaming": "convert",
  "input-available": "convert",
  "approval-requested": "convert",
  "approval-responded": "convert",
  "output-available": "convert",
  "output-error": "convert",
  "output-denied": "refuse",
} as const satisfies Record<V1DynamicTool["state"], "convert" | "refuse">;

test("every v1 tool state preserves provider metadata or explicitly refuses", () => {
  for (const state of Object.values(v1ToolStateCensus)) {
    for (const identity of [
      {
        type: "dynamic-tool",
        toolName: "mcp__fixture__search",
        toolCallId: "call",
      },
      { type: "tool-search", toolCallId: "call" },
    ]) {
      expect(checkCensus({ version: 1, part: { ...identity, ...state } })).toBe(
        v1ToolStateDispositions[state.state],
      );
    }
  }
});

const v1ApprovalFieldDispositions = {
  id: "mapped",
  approved: "mapped",
  reason: "refuse",
  signature: "refuse",
} as const satisfies Record<
  keyof NonNullable<V1DynamicTool["approval"]>,
  FieldDisposition
>;

const v1ApprovalFields = {
  id: "approval",
  approved: true,
  reason: "synthetic reason",
  signature: "synthetic signature",
} as const satisfies Required<
  NonNullable<
    Extract<V1DynamicTool, { state: "approval-responded" }>["approval"]
  >
>;

test("every upstream approval field has a checked disposition", () => {
  for (const [field, value] of Object.entries(v1ApprovalFields)) {
    const disposition = Object.entries(v1ApprovalFieldDispositions).find(
      ([key]) => key === field,
    )?.[1];
    expect(
      checkCensus({
        version: 1,
        part: {
          ...v1Baselines["dynamic-tool"],
          approval: { ...v1Baselines["dynamic-tool"].approval, [field]: value },
        },
      }),
    ).toBe(disposition === "refuse" ? "refuse" : "convert");
  }
});

const v1StatePart = fc
  .record({
    identity: fc.constantFrom(
      v1Baselines["tool-*"],
      v1Baselines["dynamic-tool"],
    ),
    state: fc.constantFrom(...Object.values(v1ToolStateCensus)),
    optionalFields: fc.subarray([
      "title",
      "toolMetadata",
      "providerExecuted",
      "reason",
      "signature",
    ]),
    includeCallMetadata: fc.boolean(),
    includeResultMetadata: fc.boolean(),
  })
  .map(
    ({
      identity,
      state,
      optionalFields,
      includeCallMetadata,
      includeResultMetadata,
    }) => {
      const stateFields = Object.fromEntries(
        Object.entries(state).filter(
          ([key]) =>
            (key !== "callProviderMetadata" || includeCallMetadata) &&
            (key !== "resultProviderMetadata" || includeResultMetadata),
        ),
      );
      const optionalValues = {
        title: "synthetic",
        toolMetadata: {},
        providerExecuted: true,
      };
      const extraFields = Object.fromEntries(
        Object.entries(optionalValues).filter(([key]) =>
          optionalFields.includes(key),
        ),
      );
      const approval =
        "approval" in state
          ? {
              approval: {
                ...state.approval,
                ...Object.fromEntries(
                  Object.entries(v1ApprovalFields).filter(
                    ([key]) =>
                      (key === "reason" || key === "signature") &&
                      optionalFields.includes(key),
                  ),
                ),
              },
            }
          : {};
      return {
        part: {
          type: identity.type,
          toolCallId: identity.toolCallId,
          ...(identity.type === "dynamic-tool"
            ? { toolName: identity.toolName }
            : {}),
          ...stateFields,
          ...extraFields,
          ...approval,
        },
        disposition:
          v1ToolStateDispositions[state.state] === "refuse" ||
          Object.keys(extraFields).length > 0 ||
          ("approval" in state &&
            optionalFields.some(
              (key) => key === "reason" || key === "signature",
            ))
            ? "refuse"
            : "convert",
      };
    },
  );

test("writer tool states and nested optional fields follow their dispositions", () => {
  assertProperty(
    "writer tool states and nested optional fields follow their dispositions",
    fc.property(v1StatePart, ({ part, disposition }) => {
      expect(checkCensus({ version: 1, part })).toBe(disposition);
    }),
  );
});
