import { toolDefinition, type SchemaInput } from "@tanstack/ai";
import {
  createCodeMode,
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
 * Read tools kept out of the eager system-prompt catalog and reached through
 * `discover_tools` instead. These are the low-frequency domains the brief calls
 * out (billing, research-admin, case-law); keeping them lazy holds the eager
 * catalog near today's budget while still making the full read surface
 * reachable. Everything else chat-projects eagerly.
 */
const LAZY_CHAT_READ_TOOLS = new Set<RegistryReadToolName>([
  // billing
  "list_time_entries",
  "resolve_rate",
  "list_invoices",
  "get_usage",
  // research-admin
  "search_legislation",
  // case-law
  "search_case_law",
  "read_case_law_decision",
]);

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

type BuildChatCodeModeProps = ChatRegistryContextDeps & {
  refRegistry: ChatRefRegistry;
};

export const buildChatCodeMode = (
  props: BuildChatCodeModeProps,
): CreateCodeModeResult => {
  const { refRegistry, ...contextDeps } = props;
  const context = buildMcpContextFromChat(contextDeps);

  const tools = chatProjectableReadToolNames().map((toolName) => {
    const definition =
      getStaticMcpToolDefinition(toolName) ??
      panic(`Chat read tool ${toolName} is missing from the static registry`);

    return toolDefinition({
      name: toolName,
      description: definition.description,
      inputSchema: toToolInputSchema(definition.inputSchema),
      lazy: LAZY_CHAT_READ_TOOLS.has(toolName),
    }).server(async (args: unknown) => {
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
  });

  return createCodeMode({
    driver: createStellaIsolateDriver({ concurrencyKey: contextDeps.userId }),
    tools,
    // Stella's sandbox owns transpilation and forbidden-syntax rejection (so its
    // taxonomy survives), so skip code-mode's sucrase step with an identity
    // transpile; the driver wraps the source in an async IIFE downstream, which
    // tolerates the top-level `return`/`await` code-mode emits.
    transpile: (code) => code,
    timeout: DEFAULT_SANDBOX_LIMITS.maxDurationMs,
    lazyToolsConfig: { includeDescription: "first-sentence" },
  });
};
