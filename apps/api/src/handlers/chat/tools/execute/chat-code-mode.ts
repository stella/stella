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

import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createStellaIsolateDriver } from "@/api/handlers/chat/tools/execute/sandbox/code-mode-driver";
import { DEFAULT_SANDBOX_LIMITS } from "@/api/handlers/chat/tools/execute/sandbox/limits";
import {
  buildMcpContextFromChat,
  type ChatRegistryContextDeps,
} from "@/api/handlers/chat/tools/registry-adapter/mcp-chat-context";
import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import { runRegistryReadTool } from "@/api/handlers/chat/tools/registry-adapter/run-registry-tool";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import type { JsonSchema } from "@/api/mcp/tool-types";

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
 * The only read tool documented eagerly (full type stub) in the system prompt;
 * every other chat-projectable read is held out of the eager catalog and reached
 * through `discover_tools`.
 *
 * Rationale: code-mode's eager catalog emits a full `interface` + JSDoc +
 * `declare function` per tool, so documenting all reads eagerly ballooned the
 * injected section to ~5.6x the hand-written `READONLY_API_HINT` it replaces.
 * Jan's hard rule is that system prompts stay brief. `list_matters` is the
 * entry-point read (the model almost always lists matters first to get the refs
 * later tools need), so it keeps its eager stub; every other read is advertised
 * by name + first sentence in the Discoverable APIs catalog and its exact schema
 * is fetched on demand via `discover_tools` — the same describe-on-demand
 * ergonomics the old `describe-stella-api` tool gave. This holds the eager
 * section in the same size class as `READONLY_API_HINT` while keeping the full
 * read surface reachable.
 */
const EAGER_CHAT_READ_TOOLS = new Set<RegistryReadToolName>(["list_matters"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The MCP registry stores each tool's input as a plain JSON Schema object
 * (`McpTool["inputSchema"]`). code-mode's `toolDefinition` types `inputSchema`
 * as `SchemaInput`, whose plain-JSON-Schema branch is a nominally distinct
 * interface, so the two JSON-Schema *types* do not unify structurally even
 * though the value is a valid JSON Schema. This projected input is only read by
 * code-mode's stub generator for the system prompt (the sole provider tool is
 * `execute_typescript`, with its own Zod schema); the registry handler still
 * validates its args with its own Valibot schema, so no validation is lost.
 */
const toToolInputSchema = (schema: JsonSchema): SchemaInput =>
  // SAFETY: JSON-Schema-to-SchemaInput boundary; see the note above.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- see note above
  schema as unknown as SchemaInput;

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
 * wall-clock deadline instead of code-mode's larger default.
 */
const CODE_MODE_RUNTIME_CONFIG = {
  transpile: (code: string) => code,
  timeout: DEFAULT_SANDBOX_LIMITS.maxDurationMs,
  lazyToolsConfig: { includeDescription: "first-sentence" },
} as const;

/**
 * Build the read-tool projections in registry order. The server binding is
 * supplied by the caller so the same definitions (names, descriptions, schemas,
 * lazy flags) back both the runtime tools (real registry runner) and the static
 * system-prompt constant (no-op runner, never invoked for prompt generation).
 */
const buildChatReadTools = (
  runReadTool: (
    toolName: RegistryReadToolName,
    args: unknown,
  ) => Promise<unknown>,
): CodeModeTool[] =>
  chatProjectableReadToolNames().map((toolName) => {
    const definition =
      getStaticMcpToolDefinition(toolName) ??
      panic(`Chat read tool ${toolName} is missing from the static registry`);

    return toolDefinition({
      name: toolName,
      description: definition.description,
      inputSchema: toToolInputSchema(definition.inputSchema),
      lazy: !EAGER_CHAT_READ_TOOLS.has(toolName),
    }).server(async (args: unknown) => await runReadTool(toolName, args));
  });

type BuildChatCodeModeProps = ChatRegistryContextDeps & {
  refRegistry: ChatRefRegistry;
};

export const buildChatCodeMode = (
  props: BuildChatCodeModeProps,
): CreateCodeModeResult => {
  const { refRegistry, ...contextDeps } = props;
  const context = buildMcpContextFromChat(contextDeps);

  const tools = buildChatReadTools(async (toolName, args) => {
    const result = await runRegistryReadTool({
      toolName,
      args: isRecord(args) ? args : {},
      context,
      refRegistry,
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  });

  return createCodeMode({
    driver: createStellaIsolateDriver({ concurrencyKey: contextDeps.userId }),
    tools,
    ...CODE_MODE_RUNTIME_CONFIG,
  });
};

/**
 * The keyed code-mode tool surface chat registers: the `execute_typescript`
 * runner and its `discover_tools` companion, keyed by their own names so the
 * map satisfies the `ChatToolMap` name-equals-key invariant and flows the two
 * tool names into `ChatUITools` for the frontend. `discover_tools` is always
 * present: every read but `list_matters` is lazy, so code-mode always emits the
 * discovery companion.
 */
export type ChatCodeModeToolMap = {
  execute_typescript: ServerTool<
    SchemaInput,
    SchemaInput,
    "execute_typescript"
  >;
  discover_tools: ServerTool<SchemaInput, SchemaInput, "discover_tools">;
};

export const buildChatCodeModeTools = (
  props: BuildChatCodeModeProps,
): ChatCodeModeToolMap => {
  const { tool, discoveryTool } = buildChatCodeMode(props);
  return {
    execute_typescript: tool,
    discover_tools:
      discoveryTool ??
      panic(
        "chat code mode always has lazy read tools, so discover_tools must exist",
      ),
  };
};

/**
 * The chat code-mode system-prompt section, injected in place of the
 * hand-written `READONLY_API_HINT`. Generated once from the static tool
 * definitions (names/descriptions/schemas/lazy flags), so it is request-
 * independent and cache-stable, exactly like the constant it replaces. Built
 * from the same `buildChatReadTools` definitions the runtime uses, so the prompt
 * and the registered tools never drift. The no-op runner is never invoked here;
 * `createCodeModeSystemPrompt` only reads the definitions.
 */
export const CHAT_CODE_MODE_SYSTEM_PROMPT: string = createCodeModeSystemPrompt({
  driver: createStellaIsolateDriver({
    concurrencyKey: "chat-code-mode-prompt",
  }),
  // eslint-disable-next-line require-await -- prompt generation never invokes the runner; an async no-op keeps the ServerTool execute contract
  tools: buildChatReadTools(async () => ({})),
  ...CODE_MODE_RUNTIME_CONFIG,
});
