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

import { BUILT_IN_CHAT_TOOL_POLICY_KINDS } from "@stll/api-contract";
import { listSkillMetadata, readDocumentedChatReads } from "@stll/skills";

import { isChatScriptRead } from "@/api/handlers/chat/tools/execute/chat-read-script-policy";
import { runChatScriptRead } from "@/api/handlers/chat/tools/execute/chat-script-read-boundary";
import {
  EAGER_CHAT_READ_TOOLS,
  toDocumentedChatReads,
} from "@/api/handlers/chat/tools/execute/documented-chat-reads";
import {
  createStellaIsolateDriver,
  type CreateStellaIsolateDriverProps,
} from "@/api/handlers/chat/tools/execute/sandbox/code-mode-driver";
import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import {
  buildScriptCallGuide,
  type ScriptCallCatalog,
} from "@/api/handlers/chat/tools/execute/script-call-guide";
import {
  buildMcpContextFromChat,
  type ChatRegistryContextDeps,
} from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import { toToolInputSchema } from "@/api/handlers/chat/tools/registry-adapter/tool-input-schema";
import { raiseChatToolError } from "@/api/handlers/chat/tools/tool-failure";
import { renderProjectionShape } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolDefectMemo } from "@/api/lib/chat/tool-defect-memo";
import type { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  hasToolSchemaInputs,
  type WithToolSchemaInputs,
} from "@/api/lib/tanstack-ai-schema";
import { isRecord } from "@/api/lib/type-guards";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import type { McpFeatureAccessContext } from "@/api/mcp/feature-access";
import {
  hiddenMcpDescriptorIds,
  scopeMcpDescriptorProse,
} from "@/api/mcp/feature-access-prose";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import { isMcpToolVisibleTo } from "@/api/mcp/tool-visibility";

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
 * The reads a chat script may call, in registry order. Derived from the
 * `as const` registry array so each `access: "read"` element's `name` narrows
 * to the `RegistryReadToolName` union (no cast); the ref-field map decides chat
 * projectability and the read script policy which of those are script
 * functions.
 */
const scriptEligibleReadToolNames = (): readonly RegistryReadToolName[] => {
  const names: RegistryReadToolName[] = [];
  for (const definition of DEFAULT_MCP_TOOL_DEFINITIONS) {
    if (
      definition.access !== "read" ||
      !isMcpToolVisibleTo(definition, "model")
    ) {
      continue;
    }
    if (
      READ_TOOL_REF_FIELD_MAP[definition.name].chatProjectable &&
      isChatScriptRead(definition.name)
    ) {
      names.push(definition.name);
    }
  }
  return names;
};

export const chatScriptReadToolNames = (
  featureAccessContext?: McpFeatureAccessContext,
): readonly RegistryReadToolName[] =>
  scriptEligibleReadToolNames().filter((name) =>
    isMcpDescriptorFeatureEnabled({
      context: featureAccessContext,
      kind: "tools",
      id: name,
      featureId: getStaticMcpToolDefinition(name)?.featureId,
    }),
  );

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
    // (`chatScriptReadToolNames` filters them out); the plain
    // description satisfies the type without inventing a shape.
    return definition.description;
  }
  return `${definition.description}\nReturns: ${renderProjectionShape(entry.projection)}`;
};

type BuildChatReadToolsProps = {
  featureAccessContext?: McpFeatureAccessContext | undefined;
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
  featureAccessContext,
  documentedReads,
  runReadTool,
}: BuildChatReadToolsProps): CodeModeTool[] => {
  const hiddenIds = hiddenMcpDescriptorIds(
    featureAccessContext,
    DEFAULT_MCP_TOOL_DEFINITIONS,
  );
  const eager = new Set<RegistryReadToolName>([
    ...EAGER_CHAT_READ_TOOLS,
    ...documentedReads,
  ]);
  return chatScriptReadToolNames(featureAccessContext).map((toolName) => {
    const definition =
      getStaticMcpToolDefinition(toolName) ??
      panic(`Chat read tool ${toolName} is missing from the static registry`);
    const entry = READ_TOOL_REF_FIELD_MAP[toolName];
    if (!entry.chatProjectable) {
      return panic(`Chat read tool ${toolName} is not projectable`);
    }

    return toolDefinition({
      name: toolName,
      description: scopeMcpDescriptorProse(
        chatReadToolDescription(toolName),
        hiddenIds,
      ),
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
) => Promise<Result<unknown, ChatToolError>>;

type CreateChatCodeModeSurfaceProps = {
  featureAccessContext?: McpFeatureAccessContext | undefined;
  concurrencyKey: string;
  documentedReads: readonly RegistryReadToolName[];
  /** Tells a script that called a name it cannot the call to make instead. */
  nameGuide?: CreateStellaIsolateDriverProps["nameGuide"];
  runReadTool: ChatCodeModeReadRunner;
};

/**
 * The code-mode surface over Stella's sandbox and the chat-projectable read
 * catalog. `buildChatCodeMode` is this with the registry runner bound.
 */
export const createChatCodeModeSurface = ({
  featureAccessContext,
  concurrencyKey,
  documentedReads,
  nameGuide,
  runReadTool,
}: CreateChatCodeModeSurfaceProps): CreateCodeModeResult =>
  createCodeMode({
    driver: createStellaIsolateDriver({
      concurrencyKey,
      ...(nameGuide === undefined ? {} : { nameGuide }),
    }),
    tools: buildChatReadTools({
      featureAccessContext,
      documentedReads,
      runReadTool: async (toolName, args) => {
        const result = await runReadTool(toolName, isRecord(args) ? args : {});
        return Result.isError(result)
          ? raiseChatToolError(result.error)
          : result.value;
      },
    }),
    ...CODE_MODE_RUNTIME_CONFIG,
  });

/** The prefix code mode gives every tool it exposes to a script. */
const SCRIPT_FUNCTION_PREFIX = "external_";

/**
 * Every chat read by its script name: registry `access: "read"` handlers,
 * which run without an approval. Only these may ever run in place of a call
 * a script misspelled.
 */
const CHAT_SCRIPT_READ_FUNCTIONS: ReadonlySet<string> = new Set(
  scriptEligibleReadToolNames().map(
    (toolName) => `${SCRIPT_FUNCTION_PREFIX}${toolName}`,
  ),
);

/** Every tool Stella has, to tell "not offered here" from "not a tool". */
const KNOWN_TOOL_NAMES: readonly string[] = [
  ...new Set([
    ...DEFAULT_MCP_TOOL_DEFINITIONS.map(({ name }) => name),
    ...Object.keys(BUILT_IN_CHAT_TOOL_POLICY_KINDS),
  ]),
];

/** What a turn offers besides scripts, known once its tool set is built. */
export type ChatScriptCallTools = {
  /** Every tool the turn offers as a direct tool call. */
  directTools: readonly string[];
  /** Why a tool is off in this turn, where the turn knows. */
  unavailableReasons: ReadonlyMap<string, string>;
};

type ChatScriptCallCatalogProps = {
  bindingNames: readonly string[];
  turnTools: ChatScriptCallTools;
};

/** The script-call catalog of one `execute_typescript` run in a chat turn. */
export const chatScriptCallCatalog = ({
  bindingNames,
  turnTools,
}: ChatScriptCallCatalogProps): ScriptCallCatalog => {
  const readFunctions = bindingNames.filter((name) =>
    CHAT_SCRIPT_READ_FUNCTIONS.has(name),
  );
  const offered = new Set([
    ...turnTools.directTools,
    ...readFunctions.map((name) => name.slice(SCRIPT_FUNCTION_PREFIX.length)),
  ]);
  return {
    readFunctions,
    directTools: turnTools.directTools,
    unavailableTools: new Map(
      KNOWN_TOOL_NAMES.filter((name) => !offered.has(name)).map((name) => [
        name,
        turnTools.unavailableReasons.get(name),
      ]),
    ),
  };
};

type BuildChatCodeModeProps = Omit<
  ChatRegistryContextDeps,
  "pinServerValidatedWorkspaceId"
> & {
  /** Documented reads of the active skill (`ActiveChatSkillContext`). */
  documentedReads: readonly RegistryReadToolName[];
  refRegistry: ChatRefRegistry;
  toolDefectMemo: ChatToolDefectMemo;
  /** Read when a script runs, after the turn's tool set is complete. */
  scriptCallTools: () => ChatScriptCallTools;
};

export const buildChatCodeMode = (
  props: BuildChatCodeModeProps,
): CreateCodeModeResult => {
  const {
    documentedReads,
    refRegistry,
    scriptCallTools,
    toolDefectMemo,
    ...contextDeps
  } = props;
  const context = buildMcpContextFromChat(contextDeps);

  return createChatCodeModeSurface({
    featureAccessContext: context,
    concurrencyKey: contextDeps.userId,
    documentedReads,
    runReadTool: async (toolName, toolArgs) =>
      await runChatScriptRead({
        toolName,
        args: toolArgs,
        toolDefectMemo,
        read: async () =>
          await runRegistryReadTool({
            toolName,
            args: toolArgs,
            context,
            refRegistry,
          }),
      }),
    // A script that calls a direct tool, an unprefixed read or a tool this
    // chat does not offer is told the call to make instead.
    nameGuide: (bindingNames) =>
      buildScriptCallGuide(
        chatScriptCallCatalog({ bindingNames, turnTools: scriptCallTools() }),
      ),
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

/** One key per distinct read set: sorted and deduplicated. */
export const codeModePromptVariantKey = (
  documentedReads: readonly RegistryReadToolName[],
): string => [...new Set(documentedReads)].toSorted().join(" ");

const renderChatCodeModeSystemPrompt = (
  documentedReads: readonly RegistryReadToolName[],
  featureAccessContext?: McpFeatureAccessContext,
): string =>
  createCodeModeSystemPrompt({
    driver: createStellaIsolateDriver({
      concurrencyKey: "chat-code-mode-prompt",
    }),
    tools: buildChatReadTools({
      featureAccessContext,
      documentedReads: [...new Set(documentedReads)].toSorted(),
      runReadTool: () => ({}),
    }),
    ...CODE_MODE_RUNTIME_CONFIG,
  });

let builtInVariants: ReadonlyMap<string, string> | undefined;

/**
 * The variants shipped code declares, rendered once on first use: the base
 * (no skill) and each built-in skill's documented reads, keyed by
 * `codeModePromptVariantKey`. Built-in skills are code, so this set is finite
 * and known; an installed skill's declaration is org data, so its variant is
 * rendered per turn and never retained, and a tenant's skills cannot grow a
 * process-wide table.
 */
export const builtInCodeModePromptVariants = (): ReadonlyMap<
  string,
  string
> => {
  builtInVariants ??= new Map(
    [
      [],
      ...listSkillMetadata().map(
        ({ metadata }) =>
          toDocumentedChatReads(readDocumentedChatReads(metadata)).reads,
      ),
    ].map((reads) => [
      codeModePromptVariantKey(reads),
      renderChatCodeModeSystemPrompt(reads),
    ]),
  );
  return builtInVariants;
};

/**
 * The chat code-mode system-prompt section for a turn whose active skill
 * documents `documentedReads` up front, injected in place of the hand-written
 * `READONLY_API_HINT`. A pure function of the set, so two threads with the
 * same active skill share one string and one prompt-cache key whether or not
 * the variant was rendered before; the built-in table only saves the render.
 * Built from the same `buildChatReadTools` definitions the runtime uses, so
 * the prompt and the registered tools never drift. The no-op runner is never
 * invoked here; `createCodeModeSystemPrompt` only reads the definitions.
 */
export const chatCodeModeSystemPrompt = (
  documentedReads: readonly RegistryReadToolName[],
  featureAccessContext?: McpFeatureAccessContext,
): string => {
  const baseline = chatScriptReadToolNames();
  const offered = chatScriptReadToolNames(featureAccessContext);
  if (
    baseline.length !== offered.length ||
    baseline.some((name, index) => offered[index] !== name)
  ) {
    return renderChatCodeModeSystemPrompt(
      documentedReads,
      featureAccessContext,
    );
  }
  return (
    builtInCodeModePromptVariants().get(
      codeModePromptVariantKey(documentedReads),
    ) ?? renderChatCodeModeSystemPrompt(documentedReads)
  );
};

/** The base variant: no active skill, so only `list_matters` is documented. */
export const CHAT_CODE_MODE_SYSTEM_PROMPT: string = chatCodeModeSystemPrompt(
  [],
);
