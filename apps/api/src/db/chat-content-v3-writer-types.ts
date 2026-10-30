// Frozen from ai@6.0.208 package/dist/index.d.ts, the v1 writer dependency
// immediately before cb6df9e0b1. Migration inputs must not follow future SDK types.
type ProviderMetadata = Record<string, Record<string, unknown>>;
export type LegacyV1WriterPart =
  | TextUIPart
  | ReasoningUIPart
  | ToolUIPart
  | DynamicToolUIPart
  | SourceUrlUIPart
  | SourceDocumentUIPart
  | FileUIPart
  | DataUIPart
  | StepStartUIPart;

type TextUIPart = {
  type: "text";

  text: string;

  state?: "streaming" | "done";

  providerMetadata?: ProviderMetadata;
};

type ReasoningUIPart = {
  type: "reasoning";

  text: string;

  state?: "streaming" | "done";

  providerMetadata?: ProviderMetadata;
};

type SourceUrlUIPart = {
  type: "source-url";
  sourceId: string;
  url: string;
  title?: string;
  providerMetadata?: ProviderMetadata;
};

type SourceDocumentUIPart = {
  type: "source-document";
  sourceId: string;
  mediaType: string;
  title: string;
  filename?: string;
  providerMetadata?: ProviderMetadata;
};

type FileUIPart = {
  type: "file";

  mediaType: string;

  filename?: string;

  url: string;

  providerMetadata?: ProviderMetadata;
};

type StepStartUIPart = {
  type: "step-start";
};
type DataUIPart = { type: `data-${string}`; id?: string; data: unknown };
type DynamicToolUIPart = {
  type: "dynamic-tool";

  toolName: string;

  toolCallId: string;
  title?: string;
  toolMetadata?: Record<string, unknown>;

  providerExecuted?: boolean;
} & (
  | {
      state: "input-streaming";
      input?: unknown;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval?: never;
    }
  | {
      state: "input-available";
      input: unknown;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval?: never;
    }
  | {
      state: "approval-requested";
      input: unknown;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved?: never;
        reason?: never;
        signature?: string;
      };
    }
  | {
      state: "approval-responded";
      input: unknown;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved: boolean;
        reason?: string;
        signature?: string;
      };
    }
  | {
      state: "output-available";
      input: unknown;
      output: unknown;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      preliminary?: boolean;
      approval?: {
        id: string;
        approved: true;
        reason?: string;
        signature?: string;
      };
    }
  | {
      state: "output-error";
      input: unknown;
      output?: never;
      errorText: string;
      callProviderMetadata?: ProviderMetadata;
      resultProviderMetadata?: ProviderMetadata;
      approval?: {
        id: string;
        approved: true;
        reason?: string;
        signature?: string;
      };
    }
  | {
      state: "output-denied";
      input: unknown;
      output?: never;
      errorText?: never;
      callProviderMetadata?: ProviderMetadata;
      approval: {
        id: string;
        approved: false;
        reason?: string;
        signature?: string;
      };
    }
);
type StaticToolPart<T> = T extends DynamicToolUIPart
  ? Omit<T, "type" | "toolName"> & { type: `tool-${string}` } & (T extends {
        state: "output-error";
      }
        ? { rawInput?: unknown }
        : object)
  : never;
type ToolUIPart = StaticToolPart<DynamicToolUIPart>;
