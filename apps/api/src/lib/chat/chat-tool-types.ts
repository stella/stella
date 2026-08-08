import type {
  AnyTool,
  ClientTool,
  InferSchemaType,
  InputSchemaOf,
  OutputSchemaOf,
  SchemaInput,
} from "@tanstack/ai";
import { panic } from "better-result";

/**
 * Heterogeneous chat-tool boundary. Keep each concrete tool's literal schemas
 * at its definition site; use TanStack's broad union only when tools enter a
 * dynamic registry, provider projection, or MCP collection.
 */
export type ChatTool = AnyTool;

export type ChatToolMap = Record<string, ChatTool | undefined>;

// Registry values are already constrained by `ChatToolMap`; only remove the
// optional slot here. Re-extracting against broad `AnyTool` erases concrete
// schema inference because its collection boundary intentionally uses `any`.
type DefinedChatTool<TTool> = Exclude<TTool, undefined>;

export type ChatUIToolsFor<TTools extends ChatToolMap> = {
  [TName in keyof TTools & string as DefinedChatTool<
    TTools[TName]
  > extends never
    ? never
    : TName]: {
    input: InferSchemaType<InputSchemaOf<DefinedChatTool<TTools[TName]>>>;
    output: InferSchemaType<OutputSchemaOf<DefinedChatTool<TTools[TName]>>>;
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
  TTool extends { inputSchema?: infer TInput extends SchemaInput }
    ? TInput
    : SchemaInput,
  TTool extends { outputSchema?: infer TOutput extends SchemaInput }
    ? TOutput
    : SchemaInput,
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
