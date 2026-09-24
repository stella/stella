import {
  toolDefinition,
  type SchemaInput,
  type ServerTool,
} from "@tanstack/ai";
import {
  createCodeMode,
  createCodeModeSystemPrompt,
  type CodeModeTool,
  type CreateCodeModeResult,
} from "@tanstack/ai-code-mode";
import { panic, Result } from "better-result";

import { EAGER_CHAT_READ_TOOLS } from "@/api/handlers/chat/tools/execute/documented-chat-reads";
import { createStellaIsolateDriver } from "@/api/handlers/chat/tools/execute/sandbox/code-mode-driver";
import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import {
  buildMcpContextFromChat,
  type ChatRegistryContextDeps,
} from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { toToolInputSchema } from "@/api/handlers/chat/tools/registry-adapter/tool-input-schema";
import { renderProjectionShape } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import { knownDefectRefusalMessage } from "@/api/lib/chat/tool-defect-memo";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  hasToolSchemaInputs,
  type WithToolSchemaInputs,
} from "@/api/lib/tanstack-ai-schema";
import { isRecord } from "@/api/lib/type-guards";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";

/**
 * Chat's code-mode surface, projected from the MCP registry.
 *
 * This composes `@tanstack/ai-code-mode`'s layer (generated type stubs, system
 * prompt, `execute_typescript` tool, and lazy-tool discovery) over Stella's
 * hardened sandbox: the driver is `createStellaIsolateDriver`, so every
 * hardening layer survives (see that file), and each read tool is a projection
 * of an `access: "read"` MCP registry handler run through the #1011 registry
 * adapter (`runRegistryReadTool`), so the ref-registry invariant holds — the
 * model and the sandbox only ever see chat refs, never tenant UUIDs. The
 * hand-written org/workspace manifests are not consulted here.
 */

/**
 * The chat-projectable read tools, in registry order. Derived from the
 * `as const` registry array so each `access: "read"` element's `name` narrows
 * to the `RegistryReadToolName` union (no cast); the ref-field map then decides
 * chat projectability per tool.
 */
const chatProjectableReadToolNames = (): readonly RegistryReadToolName[] => {
  const names: RegistryReadToolName[] = [];
  for (const definition of DEFAULT_MCP_TOOL_DEFINITIONS) {
    if (definition.access !== "read") {
      continue;
    }
    if (READ_TOOL_REF_FIELD_MAP[definition.name].chatProjectable) {
      names.push(definition.name);
    }
  }
  return names;
};

/**
 * The `execute_typescript` runner that Stella's sandbox owns unchanged. Passed to
 * `createCodeMode`/`createCodeModeSystemPrompt`: identity transpile (Stella's
 * sandbox owns transpilation and forbidden-syntax rejection, so its taxonomy
 * survives; the driver wraps the source in an async IIFE downstream, which
 * tolerates the top-level `return`/`await` code-mode emits) and the sandbox's own
 * script deadline instead of code-mode's larger default.
 */
const CODE_MODE_RUNTIME_CONFIG = {
  transpile: (code: string) => code,
  timeout: DEFAULT_SANDBOX_LIMITS.maxDurationMs,
  lazyToolsConfig: { includeDescription: "first-sentence" },
} as const;

/**
 * The registry description, plus a compact `Returns:` shape derived from the
 * tool's projection schema. Every chat-projectable tool carries a schema, so
 * every advertised read tool gets the line. The runtime strict-parses
 * payloads against the same schema, so the shape the model plans against
 * here is exactly the shape it will receive: this closes the "model guesses
 * output keys and iterates a field that isn't there" failure class.
 */
const chatReadToolDescription = (toolName: RegistryReadToolName): string => {
  const definition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Chat read tool ${toolName} is missing from the static registry`);
  const entry = READ_TOOL_REF_FIELD_MAP[toolName];
  if (!entry.chatProjectable) {
    // Non-projectable tools never enter the chat catalog
    // (`chatProjectableReadToolNames` filters them out); the plain
    // description satisfies the type without inventing a shape.
    return definition.description;
  }
  return `${definition.description}\nReturns: ${renderProjectionShape(entry.projection)}`;
};

type BuildChatReadToolsProps = {
  /** Reads the active skill documents up front, beside the always-eager set. */
  documentedReads: readonly RegistryReadToolName[];
  runReadTool: (toolName: RegistryReadToolName, args: unknown) => unknown;
};

/**
 * Build the read-tool projections in registry order. The server binding is
 * supplied by the caller so the same definitions (names, descriptions, schemas,
 * lazy flags) back both the runtime tools (real registry runner) and the
 * system-prompt variants (no-op runner, never invoked for prompt generation).
 * A read is eager when the base set or the active skill documents it; the
 * two are disjoint by construction (`documented-chat-reads.ts`).
 */
const buildChatReadTools = ({
  documentedReads,
  runReadTool,
}: BuildChatReadToolsProps): CodeModeTool[] => {
  const eager = new Set<RegistryReadToolName>([
    ...EAGER_CHAT_READ_TOOLS,
    ...documentedReads,
  ]);
  return chatProjectableReadToolNames().map((toolName) => {
    const definition =
      getStaticMcpToolDefinition(toolName) ??
      panic(`Chat read tool ${toolName} is missing from the static registry`);
    const entry = READ_TOOL_REF_FIELD_MAP[toolName];
    if (!entry.chatProjectable) {
      return panic(`Chat read tool ${toolName} is not projectable`);
    }

    return toolDefinition({
      name: toolName,
      description: chatReadToolDescription(toolName),
      inputSchema: toToolInputSchema(definition.inputSchema),
      // Code Mode's latest tool type requires an output schema. The concrete
      // projection is rendered in the description above; exposing the raw
      // Valibot schema here would reintroduce fields that projection strips.
      outputSchema: {},
      lazy: !eager.has(toolName),
    }).server(async (args: unknown) => await runReadTool(toolName, args));
  });
};

/**
 * Runs one projected read for the sandbox: `args` is whatever the script
 * passed, already reduced to a record. Chat binds this to the registry runner
 * behind its defect memo; the playbook-authoring eval binds fixtures behind
 * the same runner so a model meets the chat surface (eager `list_matters`,
 * `discover_tools` for every other read, the sandbox, the error envelopes)
 * without a database.
 */
export type ChatCodeModeReadRunner = (
  toolName: RegistryReadToolName,
  args: Record<string, unknown>,
) => Promise<unknown>;

type CreateChatCodeModeSurfaceProps = {
  concurrencyKey: string;
  documentedReads: readonly RegistryReadToolName[];
  runReadTool: ChatCodeModeReadRunner;
};

/**
 * The code-mode surface over Stella's sandbox and the chat-projectable read
 * catalog. `buildChatCodeMode` is this with the registry runner bound.
 */
export const createChatCodeModeSurface = ({
  concurrencyKey,
  documentedReads,
  runReadTool,
}: CreateChatCodeModeSurfaceProps): CreateCodeModeResult =>
  createCodeMode({
    driver: createStellaIsolateDriver({ concurrencyKey }),
    tools: buildChatReadTools({
      documentedReads,
      runReadTool: async (toolName, args) =>
        await runReadTool(toolName, isRecord(args) ? args : {}),
    }),
    ...CODE_MODE_RUNTIME_CONFIG,
  });

type BuildChatCodeModeProps = Omit<
  ChatRegistryContextDeps,
  "pinServerValidatedWorkspaceId"
> & {
  /** The active skill's documented reads (`ActiveChatSkillContext`). */
  documentedReads: readonly RegistryReadToolName[];
  refRegistry: ChatRefRegistry;
  toolDefectMemo: ChatToolDefectMemo;
};

export const buildChatCodeMode = (
  props: BuildChatCodeModeProps,
): CreateCodeModeResult => {
  const { documentedReads, refRegistry, toolDefectMemo, ...contextDeps } =
    props;
  const context = buildMcpContextFromChat(contextDeps);

  return createChatCodeModeSurface({
    concurrencyKey: contextDeps.userId,
    documentedReads,
    runReadTool: async (toolName, toolArgs) => {
      // Mechanical retry policy: an identical call that already failed with a
      // server defect this turn is refused before dispatch. "Do not retry this
      // call" is enforced here, not left to the model's reading of error prose.
      if (toolDefectMemo.isKnownDefect(toolName, toolArgs)) {
        throw new ChatToolError({
          kind: "server-defect",
          message: knownDefectRefusalMessage(toolName),
        });
      }
      const result = await runRegistryReadTool({
        toolName,
        args: toolArgs,
        context,
        refRegistry,
      });
      if (Result.isError(result)) {
        if (result.error.kind === "server-defect") {
          toolDefectMemo.recordDefect(toolName, toolArgs);
        }
        throw result.error;
      }
      return result.value;
    },
  });
};

/**
 * The keyed code-mode tool surface chat registers: the `execute_typescript`
 * runner and its `discover_tools` companion, keyed by their own names so the
 * map satisfies the `ChatToolMap` name-equals-key invariant and flows the two
 * tool names into `ChatUITools` for the frontend. `discover_tools` is always
 * present: a skill documents at most `MAX_DOCUMENTED_CHAT_READS` of the reads,
 * so some read is always lazy and code-mode always emits the discovery
 * companion.
 */
export type ChatCodeModeToolMap = {
  execute_typescript: WithToolSchemaInputs<
    ServerTool<SchemaInput, SchemaInput, "execute_typescript">
  >;
  discover_tools: WithToolSchemaInputs<
    ServerTool<SchemaInput, SchemaInput, "discover_tools">
  >;
};

export const CODE_MODE_EXECUTE_TOOL_NAME =
  "execute_typescript" as const satisfies keyof ChatCodeModeToolMap;

export const buildChatCodeModeTools = (
  props: BuildChatCodeModeProps,
): ChatCodeModeToolMap => {
  const { tool, discoveryTool } = buildChatCodeMode(props);
  const discovery =
    discoveryTool ??
    panic(
      "chat code mode always has lazy read tools, so discover_tools must exist",
    );
  // Code Mode types its schemas as TanStack's broad `SchemaInput`; at runtime
  // they are zod validators, which the chat tool boundary accepts.
  if (!hasToolSchemaInputs(tool) || !hasToolSchemaInputs(discovery)) {
    return panic("code mode tool schemas are not chat tool schemas");
  }
  return { execute_typescript: tool, discover_tools: discovery };
};

const codeModePromptVariants = new Map<string, string>();

/**
 * The chat code-mode system-prompt section for a turn whose active skill
 * documents `documentedReads` up front, injected in place of the hand-written
 * `READONLY_API_HINT`. A pure function of the set, memoized on its sorted,
 * deduplicated key, so it is request-independent within a skill and
 * cache-stable: two threads with the same active skill share one string and
 * one prompt-cache key. Built from the same `buildChatReadTools` definitions
 * the runtime uses, so the prompt and the registered tools never drift. The
 * no-op runner is never invoked here; `createCodeModeSystemPrompt` only reads
 * the definitions. The cache holds one entry per distinct set a skill in use
 * declares.
 */
export const chatCodeModeSystemPrompt = (
  documentedReads: readonly RegistryReadToolName[],
): string => {
  const reads = [...new Set(documentedReads)].toSorted();
  const key = reads.join(" ");
  const cached = codeModePromptVariants.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const prompt = createCodeModeSystemPrompt({
    driver: createStellaIsolateDriver({
      concurrencyKey: "chat-code-mode-prompt",
    }),
    tools: buildChatReadTools({
      documentedReads: reads,
      runReadTool: () => ({}),
    }),
    ...CODE_MODE_RUNTIME_CONFIG,
  });
  codeModePromptVariants.set(key, prompt);
  return prompt;
};

/** The base variant: no active skill, so only `list_matters` is documented. */
export const CHAT_CODE_MODE_SYSTEM_PROMPT: string = chatCodeModeSystemPrompt(
  [],
);
