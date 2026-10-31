import { Result } from "better-result";
import { deepEquals } from "bun";

import type {
  ChatPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { isRecord } from "@/api/lib/type-guards";

const emptyCounts = () => ({
  mapped: {
    "envelope-metadata": 0,
    "empty-parts": 0,
    "canonical-field": 0,
    "text-content": 0,
    "thinking-content": 0,
    "thinking-provider-metadata": 0,
    "text-provider-metadata": 0,
    "file-field": 0,
    "promoted-data": 0,
    "tool-id": 0,
    "tool-name": 0,
    "tool-input": 0,
    "tool-output": 0,
    "tool-metadata": 0,
    "tool-provider-metadata": 0,
    "tool-approval": 0,
    "tool-error": 0,
    "raw-tool-arguments": 0,
    "tool-result-content": 0,
  },
  implied: {
    "legacy-version": 0,
    "part-type": 0,
    "completed-text-state": 0,
    "completed-reasoning-state": 0,
    "file-type": 0,
    "promoted-data-type": 0,
    "named-tool-type": 0,
    "dynamic-tool-type": 0,
    "tool-state": 0,
    "parsed-tool-arguments": 0,
    "streaming-tool-input": 0,
    "raw-tool-input": 0,
    "paired-tool-result-content": 0,
    "empty-tool-metadata": 0,
  },
  dropped: { "bare-step-start": 0 },
});

type LegacyChatAccountingCounts = ReturnType<typeof emptyCounts>;
export type LegacyChatAccounting = {
  counts: LegacyChatAccountingCounts;
  unaccountedFields: string[];
};

export const emptyLegacyChatAccounting = (): LegacyChatAccounting => ({
  counts: emptyCounts(),
  unaccountedFields: [],
});

type Leaf = { path: string[]; value: unknown };

// Empty containers are leaves too: otherwise an unknown empty field could vanish.
const leaves = (value: unknown, path: string[] = []): Leaf[] => {
  let entries: [string, unknown][] = [];
  if (Array.isArray(value)) {
    entries = value.map((item: unknown, index) => [String(index), item]);
  } else if (isRecord(value)) {
    entries = Object.entries(value);
  }
  if (entries.length === 0) {
    return [{ path, value }];
  }
  return entries.flatMap(([key, item]) => leaves(item, [...path, key]));
};

const at = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      current = current.at(Number(key));
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
};

const pathKey = (path: readonly string[]) => JSON.stringify(path);
const displayPath = (path: readonly string[]) => {
  let result = "$";
  for (const key of path) {
    result += `[${JSON.stringify(key)}]`;
  }
  return result;
};

const CANONICAL_FIELDS = {
  activity: ["activityType", "content", "subagentRunId"],
  audio: ["source", "metadata"],
  document: ["source", "metadata"],
  image: ["source", "metadata"],
  "structured-output": [
    "data",
    "raw",
    "status",
    "errorMessage",
    "partial",
    "reasoning",
  ],
  subagent: [],
  text: ["content", "providerMetadata"],
  thinking: [
    "content",
    "signature",
    "stepId",
    "redacted",
    "provenance",
    "providerMetadata",
  ],
  "tool-call": [],
  "tool-result": ["state", "toolCallId", "error", "outcome"],
  "ui-resource": ["resource", "toolCallId", "toolName", "serverId", "meta"],
  video: ["source", "metadata"],
} as const satisfies {
  [Kind in ChatPart["type"]]: readonly (keyof Extract<
    ChatPart,
    { type: Kind }
  >)[];
};

type AccountLegacyChatContentOptions = {
  content: unknown;
  converted: PersistedChatMessageContentV3;
};

const createAccountingContext = ({
  content,
  converted,
}: AccountLegacyChatContentOptions) => {
  const counts = emptyCounts();
  const accounted = new Set<string>();
  const sourceLeaves = leaves(content);
  const sourceLeafKeys = new Set(sourceLeaves.map(({ path }) => pathKey(path)));

  const mark = (path: string[]) => {
    const covered = leaves(at(content, path), path).filter((leaf) =>
      sourceLeafKeys.has(pathKey(leaf.path)),
    );
    for (const leaf of covered) {
      accounted.add(pathKey(leaf.path));
    }
    return covered.length;
  };
  type MapOptions = {
    rule: keyof LegacyChatAccountingCounts["mapped"];
    source: string[];
    target: string[];
  };
  const mapped = ({ rule, source, target }: MapOptions) => {
    const value = at(content, source);
    if (value !== undefined && deepEquals(value, at(converted, target))) {
      counts.mapped[rule] += mark(source);
    }
  };
  type ImplyOptions = {
    rule: keyof LegacyChatAccountingCounts["implied"];
    source: string[];
    accepted: unknown;
    targetMatches: boolean;
  };
  const implied = ({ rule, source, accepted, targetMatches }: ImplyOptions) => {
    if (targetMatches && deepEquals(at(content, source), accepted)) {
      counts.implied[rule] += mark(source);
    }
  };

  return {
    counts,
    accounted,
    sourceLeaves,
    mapped,
    implied,
    mark,
    converted,
    content,
    targetIndex: 0,
    documentIndex: 0,
  };
};

type AccountingContext = ReturnType<typeof createAccountingContext>;

type PromotedDataOptions = {
  context: AccountingContext;
  part: Record<string, unknown>;
  source: string[];
  type: string;
};
const accountPromotedData = ({
  context,
  part,
  source,
  type,
}: PromotedDataOptions) => {
  const { mapped, implied, converted, documentIndex } = context;
  const promotion = {
    "data-stella-anon-restorations": "anonRestorations",
    "data-stella-mentions": "mentions",
    "data-stella-source-document": "sourceDocuments",
  };
  if (!Object.hasOwn(promotion, type)) {
    return;
  }
  let metadataKey: string;
  switch (type) {
    case "data-stella-anon-restorations":
      metadataKey = "anonRestorations";
      break;
    case "data-stella-mentions":
      metadataKey = "mentions";
      break;
    case "data-stella-source-document":
      metadataKey = "sourceDocuments";
      break;
    default:
      return;
  }
  const promotedTarget = ["metadata", metadataKey];
  if (type === "data-stella-source-document") {
    promotedTarget.push(String(documentIndex));
    context.documentIndex += 1;
  }
  implied({
    rule: "promoted-data-type",
    source: [...source, "type"],
    accepted: type,
    targetMatches: at(converted, promotedTarget) !== undefined,
  });
  if (
    type === "data-stella-anon-restorations" &&
    isRecord(part["data"]) &&
    Array.isArray(part["data"]["pairs"])
  ) {
    const pairs = part["data"]["pairs"];
    const promotedPairs = at(converted, [...promotedTarget, "pairs"]);
    if (pairs.length === 0) {
      mapped({
        rule: "promoted-data",
        source: [...source, "data", "pairs"],
        target: [...promotedTarget, "pairs"],
      });
    }
    if (Array.isArray(promotedPairs)) {
      for (const [pairIndex, pair] of pairs.entries()) {
        const matchIndex = promotedPairs.findIndex((candidate: unknown) =>
          deepEquals(candidate, pair),
        );
        if (matchIndex !== -1) {
          mapped({
            rule: "promoted-data",
            source: [...source, "data", "pairs", String(pairIndex)],
            target: [...promotedTarget, "pairs", String(matchIndex)],
          });
        }
      }
    }
  } else {
    mapped({
      rule: "promoted-data",
      source: [...source, "data"],
      target: promotedTarget,
    });
  }
};

type ToolAccountingOptions = {
  context: AccountingContext;
  part: Record<string, unknown>;
  source: string[];
  target: string[];
  next: Extract<
    PersistedChatMessageContentV3["data"][number],
    { type: "tool-call" }
  >;
  sdkTool: boolean;
  type: unknown;
};
const accountTool = ({
  context,
  part,
  source,
  target,
  next,
  sdkTool,
  type,
}: ToolAccountingOptions) => {
  const { mapped, implied, converted, targetIndex } = context;
  if (sdkTool) {
    implied({
      rule: type === "dynamic-tool" ? "dynamic-tool-type" : "named-tool-type",
      source: [...source, "type"],
      accepted: type,
      targetMatches:
        type === "dynamic-tool"
          ? next.name === part["toolName"]
          : next.name === String(type).slice("tool-".length),
    });
    mapped({
      rule: "tool-name",
      source: [...source, "toolName"],
      target: [...target, "name"],
    });
    mapped({
      rule: "tool-id",
      source: [...source, "toolCallId"],
      target: [...target, "id"],
    });
  } else {
    mapped({
      rule: "canonical-field",
      source: [...source, "type"],
      target: [...target, "type"],
    });
    mapped({
      rule: "tool-name",
      source: [...source, "name"],
      target: [...target, "name"],
    });
  }
  mapped({
    rule: "tool-id",
    source: [...source, "id"],
    target: [...target, "id"],
  });
  mapped({
    rule: "tool-input",
    source: [...source, "input"],
    target: [...target, "input", "value"],
  });
  if (next.input.status === "raw" && part["input"] !== undefined) {
    const rawArguments = next.input.rawArguments;
    const parsed = Result.try((): unknown => JSON.parse(rawArguments));
    implied({
      rule: "streaming-tool-input",
      source: [...source, "input"],
      accepted: part["input"],
      targetMatches: parsed.isOk() && deepEquals(parsed.value, part["input"]),
    });
  }
  if (
    part["rawInput"] !== undefined &&
    part["input"] === undefined &&
    next.input.status === "raw"
  ) {
    const rawArguments = next.input.rawArguments;
    const parsed = Result.try((): unknown => JSON.parse(rawArguments));
    implied({
      rule: "raw-tool-input",
      source: [...source, "rawInput"],
      accepted: part["rawInput"],
      targetMatches:
        parsed.isOk() && deepEquals(parsed.value, part["rawInput"]),
    });
  }
  mapped({
    rule: "tool-output",
    source: [...source, "output"],
    target: [...target, "output", "value"],
  });
  const states = {
    "input-streaming": "input-streaming",
    "input-available": "input-complete",
    "input-complete": "input-complete",
    "approval-requested": "approval-requested",
    "approval-responded": "approval-responded",
    "output-available": "complete",
    "output-error": "error",
    complete: "complete",
    "awaiting-input": "input-complete",
  };
  if (sdkTool) {
    for (const [accepted, translated] of Object.entries(states)) {
      implied({
        rule: "tool-state",
        source: [...source, "state"],
        accepted,
        targetMatches: next.state === translated,
      });
    }
  } else {
    mapped({
      rule: "canonical-field",
      source: [...source, "state"],
      target: [...target, "state"],
    });
  }
  for (const [field, targetField] of [
    ["callProviderMetadata", ["providerMetadata", "call"]],
    ["resultProviderMetadata", ["providerMetadata", "result"]],
    ["providerMetadata", ["providerMetadata"]],
  ] as const) {
    mapped({
      rule: "tool-provider-metadata",
      source: [...source, field],
      target: [...target, ...targetField],
    });
  }
  if (isRecord(part["metadata"])) {
    const metadata = part["metadata"];
    if (Object.keys(metadata).length === 0) {
      implied({
        rule: "empty-tool-metadata",
        source: [...source, "metadata"],
        accepted: {},
        targetMatches: Object.keys(next.metadata).length === 1,
      });
    }
    for (const key of Object.keys(metadata)) {
      mapped({
        rule: "tool-metadata",
        source: [...source, "metadata", key],
        target: [...target, "metadata", key],
      });
    }
  }
  for (const field of ["id", "approved", "needsApproval"]) {
    mapped({
      rule: "tool-approval",
      source: [...source, "approval", field],
      target: [...target, "approval", field],
    });
  }
  mapped({
    rule: "raw-tool-arguments",
    source: [...source, "arguments"],
    target: [...target, "input", "rawArguments"],
  });
  if (typeof part["arguments"] === "string" && next.input.status === "parsed") {
    const argumentsText = part["arguments"];
    const parsed = Result.try((): unknown => JSON.parse(argumentsText));
    implied({
      rule: "parsed-tool-arguments",
      source: [...source, "arguments"],
      accepted: part["arguments"],
      targetMatches:
        parsed.isOk() && deepEquals(parsed.value, next.input.value),
    });
  }
  if (sdkTool && part["state"] === "output-error") {
    const result = converted.data.at(targetIndex);
    if (
      result?.type === "tool-result" &&
      result.toolCallId === next.id &&
      result.state === "error"
    ) {
      mapped({
        rule: "tool-error",
        source: [...source, "errorText"],
        target: ["data", String(targetIndex), "error"],
      });
      context.targetIndex += 1;
    }
  }
};

const isAiSdkToolPartType = (type: unknown) =>
  typeof type === "string" &&
  (type === "dynamic-tool" ||
    (type.startsWith("tool-") &&
      type !== "tool-call" &&
      type !== "tool-result"));

type PartAccountingOptions = {
  context: AccountingContext;
  part: unknown;
  sourceIndex: number;
};
const accountPart = ({ context, part, sourceIndex }: PartAccountingOptions) => {
  const { mapped, implied, mark, counts, converted, content, targetIndex } =
    context;
  const version = isRecord(content) ? content["version"] : undefined;
  const source = ["data", String(sourceIndex)];
  const target = ["data", String(targetIndex)];
  const next = converted.data.at(targetIndex);
  if (!isRecord(part)) {
    return;
  }
  const type = part["type"];
  if (
    version === 1 &&
    type === "step-start" &&
    Object.keys(part).length === 1
  ) {
    counts.dropped["bare-step-start"] += mark(source);
    return;
  }
  if (
    version === 1 &&
    typeof type === "string" &&
    type.startsWith("data-stella-")
  ) {
    accountPromotedData({ context, part, source, type });
    return;
  }

  context.targetIndex += 1;
  if (next === undefined) {
    return;
  }
  if (
    version === 1 &&
    (type === "text" || type === "reasoning") &&
    "text" in part
  ) {
    const thinking = type === "reasoning";
    implied({
      rule: "part-type",
      source: [...source, "type"],
      accepted: type,
      targetMatches: next.type === (thinking ? "thinking" : "text"),
    });
    mapped({
      rule: thinking ? "thinking-content" : "text-content",
      source: [...source, "text"],
      target: [...target, "content"],
    });
    implied({
      rule: thinking ? "completed-reasoning-state" : "completed-text-state",
      source: [...source, "state"],
      accepted: "done",
      targetMatches: next.type === (thinking ? "thinking" : "text"),
    });
    mapped({
      rule: thinking ? "thinking-provider-metadata" : "text-provider-metadata",
      source: [...source, "providerMetadata"],
      target: [...target, "providerMetadata"],
    });
    return;
  }
  if (version === 1 && type === "file") {
    implied({
      rule: "file-type",
      source: [...source, "type"],
      accepted: "file",
      targetMatches:
        typeof part["mediaType"] === "string" &&
        next.type ===
          (part["mediaType"].startsWith("image/") ? "image" : "document") &&
        at(converted, [...target, "source", "type"]) === "url",
    });
    for (const [field, targetField] of [
      ["url", ["source", "value"]],
      ["mediaType", ["source", "mimeType"]],
      ["filename", ["metadata", "filename"]],
      ["placeholder", ["metadata", "placeholder"]],
    ] as const) {
      mapped({
        rule: "file-field",
        source: [...source, field],
        target: [...target, ...targetField],
      });
    }
    return;
  }

  const sdkTool = version === 1 && isAiSdkToolPartType(type);
  if ((sdkTool || type === "tool-call") && next.type === "tool-call") {
    accountTool({ context, part, source, target, next, sdkTool, type });
    return;
  }

  accountCanonicalPart({ context, part, source, target, next, type });
};

type CanonicalPartOptions = {
  context: AccountingContext;
  part: Record<string, unknown>;
  source: string[];
  target: string[];
  next: PersistedChatMessageContentV3["data"][number];
  type: unknown;
};
const accountCanonicalPart = ({
  context,
  part,
  source,
  target,
  next,
  type,
}: CanonicalPartOptions) => {
  const { mapped, implied, converted } = context;
  if (typeof type !== "string" || !Object.hasOwn(CANONICAL_FIELDS, type)) {
    return;
  }
  mapped({
    rule: "canonical-field",
    source: [...source, "type"],
    target: [...target, "type"],
  });
  for (const [kind, fields] of Object.entries(CANONICAL_FIELDS)) {
    if (kind !== type) {
      continue;
    }
    for (const field of fields) {
      mapped({
        rule: "canonical-field",
        source: [...source, field],
        target: [...target, field],
      });
    }
  }
  if (type === "tool-result" && next.type === "tool-result") {
    mapped({
      rule: "tool-result-content",
      source: [...source, "content"],
      target: [...target, "content", "value"],
    });
    const call = converted.data.find(
      (candidate) =>
        candidate.type === "tool-call" && candidate.id === next.toolCallId,
    );
    if (call?.type === "tool-call" && call.output !== undefined) {
      implied({
        rule: "paired-tool-result-content",
        source: [...source, "content"],
        accepted: part["content"],
        targetMatches:
          (next.content === undefined &&
            part["content"] === JSON.stringify(call.output.value)) ||
          (next.content?.type === "paired-output-parts" &&
            deepEquals(part["content"], call.output.value)),
      });
    }
  }
};

export const accountLegacyChatContent = (
  content: unknown,
  converted: PersistedChatMessageContentV3,
): LegacyChatAccounting => {
  const context = createAccountingContext({ content, converted });
  const { counts, sourceLeaves, accounted, mapped, implied } = context;
  if (!isRecord(content) || !Array.isArray(content["data"])) {
    return {
      counts,
      unaccountedFields: sourceLeaves.map(({ path }) => displayPath(path)),
    };
  }
  // `converted` is v3 by type, so a retired version always maps to it.
  for (const accepted of [1, 2]) {
    implied({
      rule: "legacy-version",
      source: ["version"],
      accepted,
      targetMatches: true,
    });
  }
  mapped({
    rule: "envelope-metadata",
    source: ["metadata"],
    target: ["metadata"],
  });
  if (content["data"].length === 0) {
    mapped({ rule: "empty-parts", source: ["data"], target: ["data"] });
  }

  for (const [sourceIndex, part] of content["data"].entries()) {
    accountPart({ context, sourceIndex, part });
  }

  return {
    counts,
    unaccountedFields: sourceLeaves
      .filter(({ path }) => !accounted.has(pathKey(path)))
      .map(({ path }) => displayPath(path)),
  };
};
