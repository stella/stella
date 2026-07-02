import type {
  ClientTool,
  InferToolInput,
  InferToolOutput,
  SchemaInput,
  Tool,
} from "@tanstack/ai";
import { panic } from "better-result";

export type ChatTool = Tool;

export type ChatToolMap = Record<string, ChatTool | undefined>;

type DefinedChatTool<TTool> = Extract<TTool, ChatTool>;

export type ChatUIToolsFor<TTools extends ChatToolMap> = {
  [TName in keyof TTools & string as DefinedChatTool<
    TTools[TName]
  > extends never
    ? never
    : TName]: {
    input: InferToolInput<DefinedChatTool<TTools[TName]>>;
    output: InferToolOutput<DefinedChatTool<TTools[TName]>>;
  };
};

type ChatClientToolFor<
  TName extends string,
  TTool extends ChatTool,
> = ClientTool<
  TTool extends { inputSchema?: infer TInput extends SchemaInput }
    ? TInput
    : SchemaInput,
  TTool extends { outputSchema?: infer TOutput extends SchemaInput }
    ? TOutput
    : SchemaInput,
  TName
>;

type ChatClientToolUnionFor<TTools extends ChatToolMap> = {
  [TName in keyof TTools & string]: DefinedChatTool<TTools[TName]> extends never
    ? never
    : ChatClientToolFor<TName, DefinedChatTool<TTools[TName]>>;
}[keyof TTools & string];

type ExternalMcpClientTool = ClientTool<
  SchemaInput,
  SchemaInput,
  `mcp__${string}`
>;

export type ChatClientToolsFor<TTools extends ChatToolMap> = readonly (
  | ChatClientToolUnionFor<TTools>
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
