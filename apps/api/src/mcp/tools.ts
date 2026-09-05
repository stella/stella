import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/server";
import { Result } from "better-result";

import { DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS } from "@stll/api-contract";

import { captureError } from "@/api/lib/analytics/capture";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import type { McpMode } from "@/api/mcp/constants";
import {
  bindApprovedMcpAuditContext,
  type McpRequestContext,
} from "@/api/mcp/context";
import { finalizeToolEgress } from "@/api/mcp/egress";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import {
  getGatewayMcpToolDefinition,
  isMcpToolFeatureEnabled,
  listGatewayMcpToolDefinitions,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import {
  DEFAULT_MCP_TOOL_SETS,
  getStaticMcpToolDefinition,
} from "@/api/mcp/static-tool-definitions";
import type {
  McpToolDefinition,
  McpToolHandler,
  McpToolInputSchema,
  ToolScope,
} from "@/api/mcp/tool-types";
import {
  MCP_INTERNAL_ERROR_HINT,
  serializeToolResult,
  structuredErrorResult,
  FEATURE_DISABLED_MESSAGE,
  featureDisabledHint,
} from "@/api/mcp/tool-utils";

const MCP_TOOL_HANDLERS = new Map<string, McpToolHandler>(
  DEFAULT_MCP_TOOL_SETS.flatMap((toolSet) => Object.entries(toolSet.handlers)),
);

const DOCUMENTS_MCP_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS,
);

/**
 * Central unknown-key backstop for static tools. Every curated tool derives its
 * advertised schema from a `v.strictObject` validator, so its handler already
 * rejects a key the schema does not declare; this repeats the check at dispatch
 * against the schema the client was actually shown, so a tool that ever bypasses
 * that path cannot silently swallow a typo. Top-level only: a nested payload is
 * the owning schema's business, and a schema that opts into `additionalProperties:
 * true` keeps its open contract.
 */
export type UndeclaredArgument = {
  key: string;
  /** A declared key that differs only by case or underscores, if any. */
  suggestion: string | undefined;
};

/** `matterId` and `matter_id` collapse to the same token; so do `validateOnly` and `validate_only`. */
const argumentNameToken = (name: string): string =>
  name.toLowerCase().replaceAll("_", "");

export const findUndeclaredArguments = ({
  args,
  inputSchema,
}: {
  args: Record<string, unknown>;
  inputSchema: McpToolInputSchema;
}):
  | { declared: readonly string[]; undeclared: readonly UndeclaredArgument[] }
  | undefined => {
  if (inputSchema["additionalProperties"] === true) {
    return undefined;
  }
  const { properties } = inputSchema;
  const declared = properties === undefined ? [] : Object.keys(properties);
  const undeclared = Object.keys(args)
    .filter((candidate) => !declared.includes(candidate))
    .map((key) => ({
      key,
      suggestion: declared.find(
        (name) => argumentNameToken(name) === argumentNameToken(key),
      ),
    }));
  return undeclared.length === 0 ? undefined : { declared, undeclared };
};

const undeclaredArgumentMessage = ({ key, suggestion }: UndeclaredArgument) =>
  suggestion === undefined
    ? `Unknown parameter: ${key}`
    : `Unknown parameter: ${key} (did you mean ${suggestion}?)`;

export const isDocumentsMcpCapabilityAllowed = (
  args: Record<string, unknown>,
): boolean => {
  const capability = args["capability"];
  return (
    typeof capability === "string" &&
    DOCUMENTS_MCP_CAPABILITY_IDS.has(capability)
  );
};

export const getMcpToolDefinition = async (
  toolName: string,
  context: McpRequestContext,
  mode: McpMode = "default",
): Promise<McpToolDefinition | undefined> =>
  await getGatewayMcpToolDefinition({ context, mode, toolName });

export const getMcpToolRequiredScopesHint = (
  toolName: string,
  mode: McpMode = "default",
): readonly ToolScope[] | undefined => {
  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (staticTool) {
    if (staticTool.additionalScopes === undefined) {
      return [staticTool.scope];
    }
    return [staticTool.scope, ...staticTool.additionalScopes];
  }

  if (mode !== "default") {
    return undefined;
  }

  if (isExternalMcpToolName(toolName)) {
    return ["stella:external_mcps"];
  }

  if (isSkillToolName(toolName)) {
    return ["stella:skills"];
  }

  return undefined;
};

export const listMcpTools = async (
  context: McpRequestContext,
  mode: McpMode = "default",
  scopes?: readonly string[],
): Promise<McpTool[]> => {
  if (scopes === undefined) {
    return toMcpTools(await listGatewayMcpToolDefinitions({ context, mode }));
  }

  return toMcpTools(
    await listGatewayMcpToolDefinitions({ context, mode, scopes }),
  );
};

export const handleMcpToolCall = async ({
  args,
  context,
  mode = "default",
  toolName,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode?: McpMode;
  toolName: string;
}): Promise<CallToolResult> => {
  const gatewayResult = await dispatchGatewayToolCall({
    args,
    context,
    mode,
    toolName,
  });
  if (gatewayResult) {
    return gatewayResult.type === "external_mcp"
      ? gatewayResult.result
      : serializeToolResult(gatewayResult.result);
  }

  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  if (!staticTool) {
    return serializeToolResult(
      structuredErrorResult({
        code: "unknown_tool",
        message: `Unknown tool: ${toolName}`,
        hint: "Call tools/list for the tools available to this session.",
      }),
    );
  }

  if (
    mode === "documents" &&
    toolName === "invoke_capability" &&
    !isDocumentsMcpCapabilityAllowed(args)
  ) {
    return serializeToolResult(
      structuredErrorResult({
        code: "feature_disabled",
        message:
          "This capability is not available on the documents MCP surface",
        hint: "Use one of the upload lifecycle operations exposed by the document upload panel.",
      }),
    );
  }

  // Reject a gated-off tool even when the caller names it directly: the list
  // surface hides it, and this closes the guess-the-name bypass so the gate
  // holds on both the advertisement and the dispatch path.
  if (!isMcpToolFeatureEnabled(staticTool.feature)) {
    return serializeToolResult(
      structuredErrorResult({
        code: "feature_disabled",
        message: FEATURE_DISABLED_MESSAGE,
        hint: featureDisabledHint(staticTool.feature),
      }),
    );
  }

  const unknownArgs = findUndeclaredArguments({
    args,
    inputSchema: staticTool.inputSchema,
  });
  if (unknownArgs) {
    const keys = unknownArgs.undeclared.map((entry) => entry.key);
    return serializeToolResult(
      structuredErrorResult({
        code: "validation_error",
        message: `Unknown parameter${keys.length === 1 ? "" : "s"}: ${keys.join(", ")}`,
        issues: unknownArgs.undeclared.map((entry) => ({
          path: entry.key,
          message: undeclaredArgumentMessage(entry),
        })),
        hint: `Remove ${keys.map((key) => `'${key}'`).join(", ")}. ${toolName} accepts only: ${unknownArgs.declared.join(", ")}.`,
      }),
    );
  }

  // Destructive-op guardrail (agent misuse protection): an irreversible tool
  // (delete_*) must be called with `confirm: true`, set only after a human user
  // approved the action. Runs before dispatch so the mutation never starts
  // without the confirmation.
  if (
    staticTool.annotations.destructiveHint === true &&
    args["confirm"] !== true
  ) {
    return serializeToolResult(
      structuredErrorResult({
        code: "confirmation_required",
        message: `${toolName} is an irreversible operation and was called without confirmation`,
        hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
      }),
    );
  }

  const handler = MCP_TOOL_HANDLERS.get(toolName);
  if (!handler) {
    return serializeToolResult(
      structuredErrorResult({
        code: "unknown_tool",
        message: `Unknown tool: ${toolName}`,
        hint: "Call tools/list for the tools available to this session.",
      }),
    );
  }

  const executionContext =
    staticTool.annotations.destructiveHint === true
      ? bindApprovedMcpAuditContext(context)
      : context;
  // Handlers never see the mode: they return either a finished result or an
  // egress plan. The central pipeline applies anonymization (anonymized mode)
  // before windowing; this transport boundary then serializes. Both steps run
  // inside one Result so an anonymization or windowing failure is captured like
  // any handler failure.
  const finished = await Result.tryPromise({
    try: async () => {
      const response = await handler({
        args,
        context: executionContext,
      });
      return await finalizeToolEgress(
        {
          context: executionContext,
          mode,
          response,
        },
        {
          anonymizeTextFields:
            executionContext.testDependencies?.anonymizeTextFields,
        },
      );
    },
    catch: (error) => error,
  });
  if (Result.isError(finished)) {
    captureError(finished.error, { source: "mcp", toolName });
    // Generic message: never leak internals to the caller. `captureError` keeps
    // the real exception for observability.
    return serializeToolResult(
      structuredErrorResult({
        code: "internal_error",
        message: "Tool execution failed",
        hint: MCP_INTERNAL_ERROR_HINT,
      }),
    );
  }
  return serializeToolResult(finished.value);
};
