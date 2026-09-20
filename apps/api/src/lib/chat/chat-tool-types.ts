import type { StandardTypedV1 } from "@standard-schema/spec";
import type {
  AnyTool,
  ApprovalSchemaConfig,
  ClientTool,
  InputSchemaOf,
  OutputSchemaOf,
  SchemaInput,
} from "@tanstack/ai";
import { panic } from "better-result";

import type { ToolSchemaInput } from "@/api/lib/tanstack-ai-schema";

/**
 * Heterogeneous chat-tool boundary. Keep each concrete tool's literal schemas
 * at its definition site; use TanStack's broad union only when tools enter a
 * dynamic registry, provider projection, or MCP collection.
 */
export type ChatTool = Omit<
  AnyTool,
  "inputSchema" | "name" | "outputSchema"
> & {
  approvalSchema?: ApprovalSchemaConfig | undefined;
  inputSchema?: ToolSchemaInput | undefined;
  name: string;
  outputSchema?: ToolSchemaInput | undefined;
};

export type ChatToolMap = Record<string, ChatTool | undefined>;

/**
 * Why a tool set is being built. A `run` set is what the model may call this
 * turn. A `validation` set only checks the tool calls of an incoming message
 * and never executes, so it must admit every call an earlier run on the thread
 * could have produced: tools that a catalog, feature flag, or composer mode
 * gates out of the current run stay registered, with schemas no stricter than
 * the run's.
 */
export const CHAT_TOOL_SET_PURPOSE = {
  run: "run",
  validation: "validation",
} as const;
export type ChatToolSetPurpose =
  (typeof CHAT_TOOL_SET_PURPOSE)[keyof typeof CHAT_TOOL_SET_PURPOSE];

// Registry values are already constrained by `ChatToolMap`; only remove the
// optional slot here. Re-extracting against broad `AnyTool` erases concrete
// schema inference because its collection boundary intentionally uses `any`.
type DefinedChatTool<TTool> = Exclude<TTool, undefined>;

type InferSchemaInput<TSchema> = TSchema extends StandardTypedV1
  ? StandardTypedV1.InferInput<TSchema>
  : unknown;

type InferSchemaOutput<TSchema> = TSchema extends StandardTypedV1
  ? StandardTypedV1.InferOutput<TSchema>
  : unknown;

export type ChatUIToolsFor<TTools extends ChatToolMap> = {
  [
    TName in keyof TTools & string as DefinedChatTool<
      TTools[TName]
    > extends never
      ? never
      : TName
  ]: {
    input: InferSchemaInput<InputSchemaOf<DefinedChatTool<TTools[TName]>>>;
    output: InferSchemaOutput<OutputSchemaOf<DefinedChatTool<TTools[TName]>>>;
  };
};

type InferToolNeedsApproval<TTool> = TTool extends {
  needsApproval?: infer TNeedsApproval;
}
  ? TNeedsApproval extends true
    ? true
    : false
  : false;

type ChatClientToolFor<
  TName extends string,
  TTool extends ChatTool,
  TApprovalNames extends string,
> = ClientTool<
  InputSchemaOf<TTool> extends SchemaInput ? InputSchemaOf<TTool> : undefined,
  OutputSchemaOf<TTool> extends SchemaInput ? OutputSchemaOf<TTool> : undefined,
  TName,
  unknown,
  TName extends TApprovalNames ? true : InferToolNeedsApproval<TTool>
>;

type ChatClientToolUnionFor<
  TTools extends ChatToolMap,
  TApprovalNames extends string,
> = {
  [TName in keyof TTools & string]: DefinedChatTool<TTools[TName]> extends never
    ? never
    : ChatClientToolFor<
        TName,
        Extract<DefinedChatTool<TTools[TName]>, ChatTool>,
        TApprovalNames
      >;
}[keyof TTools & string];

type ExternalMcpClientTool = ClientTool<
  SchemaInput,
  SchemaInput,
  `mcp__${string}`,
  unknown,
  true
>;

export type ChatClientToolsFor<
  TTools extends ChatToolMap,
  TApprovalNames extends string = never,
> = readonly (
  | ChatClientToolUnionFor<TTools, TApprovalNames>
  | ExternalMcpClientTool
)[];

export const assertChatToolMapInvariants = (tools: ChatToolMap): void => {
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool) {
      continue;
    }

    if (tool.name !== name) {
      panic(
        `Chat tool map key "${name}" does not match TanStack tool name "${tool.name}".`,
      );
    }
  }
};

export const chatToolMapToArray = (tools: ChatToolMap): ChatTool[] => {
  assertChatToolMapInvariants(tools);

  const values: ChatTool[] = [];
  for (const tool of Object.values(tools)) {
    if (tool) {
      values.push(tool);
    }
  }
  return values;
};
