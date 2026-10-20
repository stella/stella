import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/server";
import { Panic, panic, Result } from "better-result";

import { DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS } from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import { captureError } from "@/api/lib/analytics/capture";
import { resourcesAreVisible } from "@/api/lib/entities/resource-access";
import { isSearchIndexUnavailable } from "@/api/lib/legal-search/search-index-unavailable";
import {
  isExternalMcpToolName,
  isSkillToolName,
} from "@/api/lib/mcp-upstream/namespace";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { McpMode } from "@/api/mcp/constants";
import {
  bindApprovedMcpAuditContext,
  createPublicMcpHandlerContext,
  type McpRequestContext,
} from "@/api/mcp/context";
import { finalizeToolEgress } from "@/api/mcp/egress";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { dispatchGatewayToolCall } from "@/api/mcp/gateway/dispatch-call";
import type { ExternalGatewayDependencies } from "@/api/mcp/gateway/external-tools";
import {
  getGatewayMcpToolDefinition,
  isMcpToolFeatureEnabled,
  listGatewayMcpToolDefinitions,
  resolveMcpToolOutputContract,
  toMcpTools,
} from "@/api/mcp/gateway/list-tools";
import { modeAllowsGatewayTools } from "@/api/mcp/gateway/mode-policy";
import { hasGrantedScope } from "@/api/mcp/gateway/static-tool-visibility";
import {
  agentInputValidationError,
  normalizeObjectInputAtBoundary,
  withInputNotes,
} from "@/api/mcp/input-normalization";
import { matterRequiredResult } from "@/api/mcp/matter-requirement";
import { observeMcpToolCall } from "@/api/mcp/observe-tool-call";
import {
  getStaticMcpToolDefinition,
  getStaticMcpToolHandler,
  invokeStaticMcpTool,
} from "@/api/mcp/static-tool-definitions";
import { scopeToolResultToSurface } from "@/api/mcp/surface-tool-mentions";
import { mcpToolAuthorityDenialRefusal } from "@/api/mcp/tool-authority";
import type {
  InternalToolResult,
  McpToolDefinition,
  McpToolResponse,
  PublicMcpToolHandler,
  RuntimeMcpToolOutputContract,
  ToolScope,
} from "@/api/mcp/tool-types";
import { PUBLIC_MCP_TOOL_DEFINITION } from "@/api/mcp/tool-types";
import {
  confirmationUnavailableResult,
  MCP_INTERNAL_ERROR_HINT,
  McpOutputContractError,
  notFoundResult,
  searchIndexUnavailableResult,
  serializeToolResult,
  structuredErrorResult,
} from "@/api/mcp/tool-utils";

export { findUndeclaredArguments } from "@/api/mcp/input-normalization";
export type { UndeclaredArgument } from "@/api/mcp/input-normalization";

const DOCUMENTS_MCP_CAPABILITY_IDS: ReadonlySet<string> = new Set(
  DOCUMENT_VERSION_UPLOAD_CAPABILITY_IDS,
);

export const invokePublicMcpHandler = async (
  handler: PublicMcpToolHandler,
  args: Record<string, unknown>,
  context: McpRequestContext,
): Promise<McpToolResponse> => {
  const publicContext = createPublicMcpHandlerContext(context);
  if (Result.isError(publicContext)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "This tool is unavailable on this deployment.",
      retryable: false,
    });
  }
  return await handler({ args, context: publicContext.value });
};

const staticInvocationRefusal = (
  toolName: string,
  denial: "member-role" | "credential" | null,
) =>
  structuredErrorResult({
    ...(denial === null
      ? {
          code: "permission_denied",
          message: `Tool ${toolName} is unavailable.`,
        }
      : mcpToolAuthorityDenialRefusal(`this ${toolName} operation`, denial)),
  });

/**
 * Central unknown-key backstop for static tools. Every curated tool derives its
 * advertised schema from a `v.strictObject` validator, so its handler already
 * rejects a key the schema does not declare; this repeats the check at dispatch
 * against the schema the client was actually shown, so a tool that ever bypasses
 * that path cannot silently swallow a typo. Top-level only: a nested payload is
 * the owning schema's business, and a schema that opts into `additionalProperties:
 * true` keeps its open contract.
 */
/**
 * Whether this call needs `confirm: true`, and what to tell a model that
 * omitted it. One switch, not two: the decision and the refusal it produces
 * cannot describe different operations.
 */
type TransportConfirmation =
  | { required: false }
  | { required: true; message: string; hint: string };

const NO_CONFIRMATION: TransportConfirmation = { required: false };

const irreversibleConfirmation = (toolName: string): TransportConfirmation => ({
  required: true,
  message: `${toolName} is an irreversible operation and was called without confirmation`,
  hint: "This operation is irreversible. Confirm with the human user, then retry with confirm: true.",
});

const transportConfirmation = (
  definition: McpToolDefinition,
  args: Record<string, unknown>,
): TransportConfirmation => {
  const behavior = definition.destructiveBehavior;
  if (behavior === undefined) {
    return NO_CONFIRMATION;
  }

  switch (behavior.type) {
    case "always":
      return irreversibleConfirmation(definition.name);
    case "outbound":
      return {
        required: true,
        message: `${definition.name} sends data outside this workspace and was called without confirmation`,
        hint: `${behavior.reason} Show the human user exactly what will be sent, get their approval, then retry with confirm: true.`,
      };
    case "input-discriminator": {
      const value = args[behavior.property];
      return typeof value === "string" &&
        behavior.destructiveValues.includes(value)
        ? irreversibleConfirmation(definition.name)
        : NO_CONFIRMATION;
    }
    case "capability-catalog":
      // The handler resolves the selected capability from the canonical
      // catalog, then applies its target-specific confirmation gate.
      return NO_CONFIRMATION;
    case "upstream":
      // Dynamic connector tools are executed by their owning MCP server. Its
      // advertised risk remains visible to clients, while the upstream server
      // owns any operation-specific confirmation protocol.
      return NO_CONFIRMATION;
    default:
      behavior satisfies never;
      return panic("Unhandled MCP confirmation behavior");
  }
};

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
  if (!modeAllowsGatewayTools(mode)) {
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
  externalGatewayDependencies?: ExternalGatewayDependencies,
): Promise<McpTool[]> => {
  if (scopes === undefined) {
    return toMcpTools(
      await listGatewayMcpToolDefinitions({
        context,
        mode,
        ...(externalGatewayDependencies === undefined
          ? {}
          : { externalGatewayDependencies }),
      }),
      { mode, context },
    );
  }

  return toMcpTools(
    await listGatewayMcpToolDefinitions({
      context,
      mode,
      scopes,
      ...(externalGatewayDependencies === undefined
        ? {}
        : { externalGatewayDependencies }),
    }),
    { mode, context },
  );
};

/**
 * Whether this session could call a static tool: the surface lists it, its
 * feature is on, and the credential holds every scope it requires (the same
 * checks `tools/call` applies before dispatch).
 */
const isStaticToolCallable = ({
  context,
  grantedScopes,
  mode,
  toolName,
}: {
  context: McpRequestContext;
  grantedScopes: readonly string[];
  mode: McpMode;
  toolName: string;
}): boolean => {
  const definition = getStaticMcpToolDefinition(toolName, mode);
  if (
    !definition ||
    !isMcpToolFeatureEnabled(definition.feature) ||
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: definition.name,
      featureId: definition.featureId,
    })
  ) {
    return false;
  }
  return [definition.scope, ...(definition.additionalScopes ?? [])].every(
    (scope) => hasGrantedScope(grantedScopes, scope),
  );
};

type McpToolSurface = { context: McpRequestContext; mode: McpMode };

const createSurfaceSerializer =
  ({ context, mode }: McpToolSurface) =>
  (
    result: InternalToolResult,
    outputContract?: RuntimeMcpToolOutputContract,
    toolName?: string,
  ): CallToolResult =>
    serializeToolResult(
      scopeToolResultToSurface(result, { mode, context }),
      outputContract,
      toolName,
    );

type McpToolCallArgs = {
  args: Record<string, unknown>;
  context: McpRequestContext;
  mode?: McpMode;
  toolName: string;
  dependencies?: { dispatchGatewayToolCall: typeof dispatchGatewayToolCall };
};
const unknownToolResult = (toolName: string) =>
  structuredErrorResult({
    code: "unknown_tool",
    message: `Unknown tool: ${toolName}`,
    hint: "Call tools/list for the tools available to this session.",
  });

const callGatewayTool = async ({
  args,
  context,
  mode = "default",
  toolName,
  dependencies,
}: McpToolCallArgs): Promise<CallToolResult | undefined> => {
  const serializeForSurface = createSurfaceSerializer({ context, mode });
  const gatewayResult = await (
    dependencies?.dispatchGatewayToolCall ?? dispatchGatewayToolCall
  )({
    args,
    context,
    mode,
    toolName,
  });
  if (gatewayResult) {
    if (gatewayResult.type === "external_mcp") {
      return gatewayResult.result;
    }
    // A Stella-owned dynamic family (skills) serves through its shared
    // contract exactly like a static tool: the projection is validated and a
    // violation answers with the same internal_error envelope.
    const serialized = Result.try({
      try: () =>
        serializeForSurface(
          gatewayResult.result,
          resolveMcpToolOutputContract(toolName),
        ),
      catch: (error) => error,
    });
    return Result.isError(serialized)
      ? internalErrorResult({
          mode,
          context,
          toolName,
          error: serialized.error,
        })
      : serialized.value;
  }

  return undefined;
};

const staticToolReferenceRefusal = async ({
  context,
  definition,
  args,
  mode,
  toolName,
}: {
  context: McpRequestContext;
  definition: McpToolDefinition;
  args: Record<string, unknown>;
  mode: McpMode;
  toolName: string;
}) => {
  if (
    !(await resourcesAreVisible({
      inputs: [
        {
          schema:
            "inputSchemaSource" in definition
              ? definition.inputSchemaSource
              : definition.inputSchema,
          value: args,
        },
      ],
      scopedDb: context.scopedDb,
    }))
  ) {
    return notFoundResult("Not found");
  }
  // Before confirmation: asking a human to approve a call that cannot run
  // would only defer the same answer.
  const needsMatter = matterRequiredResult({
    args,
    context,
    saveMatterCallable: isStaticToolCallable({
      context,
      grantedScopes: context.grantedScopes,
      mode,
      toolName: "save_matter",
    }),
    toolName,
  });
  if (needsMatter !== null) {
    return needsMatter;
  }

  return null;
};

const dispatchMcpToolCall = async ({
  args,
  context,
  mode = "default",
  toolName,
  dependencies,
}: McpToolCallArgs): Promise<CallToolResult> => {
  const serializeForSurface = createSurfaceSerializer({ context, mode });
  const staticTool = getStaticMcpToolDefinition(toolName, mode);
  const gatewayResult = await callGatewayTool({
    args,
    context,
    mode,
    toolName,
    ...(dependencies === undefined ? {} : { dependencies }),
  });
  if (gatewayResult !== undefined) {
    return gatewayResult;
  }
  if (!staticTool) {
    return serializeForSurface(unknownToolResult(toolName));
  }
  const outputContract = resolveMcpToolOutputContract(toolName, mode);
  if (outputContract === undefined) {
    panic(`Static MCP tool is missing its output contract: ${toolName}`);
  }

  if (
    mode === "documents" &&
    toolName === MCP_CAPABILITY_EXECUTORS.write &&
    !isDocumentsMcpCapabilityAllowed(args)
  ) {
    return serializeForSurface(
      structuredErrorResult({
        code: "feature_disabled",
        message:
          "This capability is not available on the documents MCP surface",
        hint: "Use one of the upload lifecycle operations exposed by the document upload panel.",
      }),
    );
  }

  const handler = getStaticMcpToolHandler(toolName, mode);
  if (!handler && !(PUBLIC_MCP_TOOL_DEFINITION in staticTool)) {
    return serializeForSurface(unknownToolResult(toolName));
  }

  // Handlers never see the mode: they return either a finished result or an
  // egress plan. The central pipeline applies anonymization (anonymized mode)
  // before windowing; this transport boundary then serializes. Both steps run
  // inside one Result so an anonymization or windowing failure is captured like
  // any handler failure.
  const finished = await Result.tryPromise({
    try: async () => {
      // Resolve confirmation from the registry's canonical behavior.
      // Capability-catalog and upstream tools defer the final decision to their
      // owning dispatch boundary because the selected target determines risk.
      const confirmation = transportConfirmation(staticTool, args);
      const executionContext = confirmation.required
        ? bindApprovedMcpAuditContext(context)
        : context;
      const invocation = await invokeStaticMcpTool({
        args,
        normalizeInput: ({ access, exactProperties, schema, value }) =>
          normalizeObjectInputAtBoundary({
            access,
            ...(exactProperties === undefined ? {} : { exactProperties }),
            schema,
            value,
          }),
        beforeInvoke: async (normalizedArgs) => {
          if (confirmation.required) {
            const unconfirmable = confirmationUnavailableResult({
              toolConfirmation: context.toolConfirmation,
              subject: toolName,
            });
            if (unconfirmable !== null) {
              return unconfirmable;
            }
            if (normalizedArgs["confirm"] !== true) {
              return structuredErrorResult({
                code: "confirmation_required",
                message: confirmation.message,
                hint: confirmation.hint,
              });
            }
          }
          return await staticToolReferenceRefusal({
            context,
            definition: staticTool,
            args: normalizedArgs,
            mode,
            toolName,
          });
        },
        context: executionContext,
        definition: staticTool,
        mode,
      });
      if (invocation.status === "validation-error") {
        const firstIssue = invocation.failure.issues.at(0);
        if (firstIssue?.message.startsWith("Unknown parameter:")) {
          return serializeForSurface(
            structuredErrorResult({
              code: "validation_error",
              message:
                firstIssue.message.split(" (did you mean", 1)[0] ??
                firstIssue.message,
              issues: [...invocation.failure.issues],
              hint: invocation.failure.hint,
            }),
          );
        }
        return serializeForSurface(
          agentInputValidationError({
            failure: invocation.failure,
            subject: `${toolName} arguments`,
          }),
        );
      }
      if (invocation.status === "authority-refused") {
        if (invocation.denial === null) {
          return serializeForSurface(
            structuredErrorResult({
              code: "permission_denied",
              message: "This operation is unavailable for this account.",
            }),
          );
        }
        return serializeForSurface(
          structuredErrorResult(
            mcpToolAuthorityDenialRefusal(
              toolName,
              invocation.denial === "visibility"
                ? "member-role"
                : invocation.denial,
            ),
          ),
        );
      }
      if (invocation.status === "input-authority-refused") {
        return serializeForSurface(
          staticInvocationRefusal(toolName, invocation.denial),
        );
      }
      const response = invocation.response;
      const finalized = await finalizeToolEgress(
        {
          context: executionContext,
          mode,
          response,
        },
        {
          anonymizeTextFields:
            executionContext.testDependencies?.anonymizeTextFields,
          loadAnonymizationAllowlistCanonicalsByWorkspace:
            executionContext.testDependencies
              ?.loadAnonymizationAllowlistCanonicalsByWorkspace,
          loadAnonymizationGazetteerEntriesByWorkspace:
            executionContext.testDependencies
              ?.loadAnonymizationGazetteerEntriesByWorkspace,
        },
      );
      return withInputNotes(
        serializeForSurface(finalized, outputContract, toolName),
        invocation.inputNotes,
      );
    },
    catch: (error) => error,
  });
  if (Result.isError(finished)) {
    return internalErrorResult({
      mode,
      context,
      toolName,
      error: finished.error,
    });
  }
  return finished.value;
};

const MCP_OUTPUT_CONTRACT_SINK = failureSink({
  event: "mcp.output_contract_violated",
  expected: [],
});

/**
 * The one envelope for a handler, egress, or output-contract failure. Generic
 * message: never leak internals to the caller. `captureError` keeps the real
 * exception for observability. An output-contract violation goes through the
 * failure owner instead, which grades it a defect and logs it at ERROR: the
 * caller sees an ordinary tool error, so nothing else would surface it. A
 * search index that could not be reached is not a defect of the call, so it
 * keeps its own retryable `search_index_unavailable` envelope.
 */
const internalErrorResult = ({
  mode,
  context,
  toolName,
  error,
}: {
  mode: McpMode;
  context: McpRequestContext;
  toolName: string;
  error: unknown;
}): CallToolResult => {
  const contractViolation =
    Panic.is(error) && McpOutputContractError.is(error.cause)
      ? error.cause
      : undefined;
  if (isSearchIndexUnavailable(error)) {
    return serializeToolResult(
      scopeToolResultToSurface(searchIndexUnavailableResult(error), {
        mode,
        context,
      }),
    );
  }
  if (contractViolation !== undefined) {
    observeFailure(contractViolation, {
      sink: MCP_OUTPUT_CONTRACT_SINK,
      ctx: { source: "mcp", tool: toolName },
    });
  } else {
    captureError(error, { source: "mcp", toolName });
  }
  return serializeToolResult(
    scopeToolResultToSurface(
      structuredErrorResult({
        code: "internal_error",
        message: "Tool execution failed",
        hint: MCP_INTERNAL_ERROR_HINT,
      }),
      { mode, context },
    ),
  );
};

export const handleMcpToolCall = async ({
  args,
  context,
  mode = "default",
  toolName,
  dependencies,
}: McpToolCallArgs): Promise<CallToolResult> =>
  await observeMcpToolCall({
    context,
    mode,
    toolName,
    run: async () =>
      await dispatchMcpToolCall({
        args,
        context,
        mode,
        toolName,
        ...(dependencies === undefined ? {} : { dependencies }),
      }),
  });
