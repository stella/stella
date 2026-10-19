import { panic, Result } from "better-result";
import * as v from "valibot";

import { projectForChat } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { containsRawUuid } from "@/api/lib/chat/uuid-mask";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import { isRecord } from "@/api/lib/type-guards";
import type { McpRequestContext } from "@/api/mcp/context";
import { finalizeToolEgress } from "@/api/mcp/egress";
import { isMcpDescriptorFeatureEnabled } from "@/api/mcp/feature-access";
import { isMcpToolFeatureEnabled } from "@/api/mcp/gateway/list-tools";
import {
  agentInputValidationError,
  normalizeObjectInputAtBoundary,
} from "@/api/mcp/input-normalization";
import {
  DEFAULT_MCP_TOOL_DEFINITIONS,
  getStaticMcpToolDefinition,
  invokeStaticMcpTool,
} from "@/api/mcp/static-tool-definitions";
import type { McpToolHandler, McpToolResponse } from "@/api/mcp/tool-types";
import { validationErrorResult } from "@/api/mcp/tool-utils";

import type {
  ChatProjectableToolName,
  ProjectionDataByName,
  RegistryReadToolName,
} from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateInputRefs } from "./ref-mediation";
import { toRegistryChatToolError } from "./registry-tool-error";

export type ThirdPartyOutboundReadToolName =
  | "search_boe_legislation"
  | "lookup_business_registry";

type ProjectableRegistryReadToolName = ChatProjectableToolName<
  typeof READ_TOOL_REF_FIELD_MAP
>;

const isProjectableRegistryReadToolName = (
  toolName: RegistryReadToolName,
): toolName is ProjectableRegistryReadToolName =>
  READ_TOOL_REF_FIELD_MAP[toolName].chatProjectable;

export type RegistryReadToolDataByName = ProjectionDataByName<
  typeof READ_TOOL_REF_FIELD_MAP,
  ProjectableRegistryReadToolName
>;

export type RunRegistryReadToolProps = {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  context: McpRequestContext;
  refRegistry: ChatRefRegistry;
  /**
   * Eval seam: answers the tool in place of its registry handler. Everything
   * around the handler stays production (ref dehydration, boundary
   * normalization, the handler's own argument parse and its envelope, egress,
   * the strict projection), so an eval fixture meets the surface a model
   * meets, without a database.
   */
  handler?: McpToolHandler | undefined;
  /**
   * Narrows the normalized arguments before the handler runs (the turn's
   * corpus scope). It sees canonical values, so it compares a country as the
   * handler will read it; a refusal stops the read.
   */
  scopeArgs?:
    | ((
        args: Record<string, unknown>,
      ) => Promise<Result<Record<string, unknown>, ChatToolError>>)
    | undefined;
};

/**
 * Every registry handler opens by parsing its arguments with the definition's
 * own valibot schema and answering a failure with `validationErrorResult`. An
 * injected handler gets that step here, so a refused call (an unknown key, a
 * bad value) meets the handler's envelope and an accepted one the parsed
 * arguments. A legacy definition without a valibot source validates by hand
 * inside its handler; its injected handler sees the normalized arguments.
 * The definition comes from the `as const` registry array, whose element
 * union keeps each valibot source's own type.
 */
const runInjectedHandler = async ({
  args,
  context,
  toolName,
  handler,
}: {
  args: Record<string, unknown>;
  context: McpRequestContext;
  toolName: RegistryReadToolName;
  handler: McpToolHandler;
}): Promise<McpToolResponse> => {
  const definition =
    DEFAULT_MCP_TOOL_DEFINITIONS.find(({ name }) => name === toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (!("inputSchemaSource" in definition)) {
    return await handler({ args, context });
  }
  const parsed = v.safeParse(definition.inputSchemaSource, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  if (!isRecord(parsed.output)) {
    return panic("An object input schema parsed to a non-object value");
  }
  return await handler({ args: parsed.output, context });
};

/** The key the boundary's input notes ride under beside a read's payload. */
const CHAT_INPUT_NOTES_KEY = "inputRead";

/**
 * The boundary's "read X as Y" notes, beside the projected payload, so the
 * model learns which value the server acted on (a clamped limit, a year read
 * as a date bound, a short ELI). A note quoting a raw UUID is left out: the
 * input side was already dehydrated from refs, and no tenant UUID may reach
 * the model.
 */
const withChatInputNotes = (
  payload: unknown,
  notes: readonly string[],
): unknown => {
  const safe = [...new Set(notes)].filter((note) => !containsRawUuid(note));
  return safe.length === 0 || !isRecord(payload)
    ? payload
    : { ...payload, [CHAT_INPUT_NOTES_KEY]: safe };
};

/**
 * Run one read-only MCP registry tool as a chat tool.
 *
 * 1. Refuse a tool the ref-field map keeps off the chat surface, or one whose
 *    deploy feature flag is off (feature gating still applies to chat; OAuth
 *    scope gating does not, see `buildMcpContextFromChat`).
 * 2. Dehydrate ref args to real UUIDs.
 * 3. Run the handler and finalize its egress in DEFAULT mode (chat is not the
 *    anonymized surface).
 * 4. Project a typed error into a `ChatToolError`; otherwise project the typed
 *    payload for chat in a single schema-driven pass
 *    (`projectForChat`: strict parse, strip, ref hydration, UUID invariant).
 * 5. Carry the boundary's input notes beside the projected payload.
 */
export const runRegistryReadTool = async ({
  toolName,
  args,
  context,
  refRegistry,
  handler,
  scopeArgs,
}: RunRegistryReadToolProps): Promise<Result<unknown, ChatToolError>> => {
  if (!isProjectableRegistryReadToolName(toolName)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: `Tool ${toolName} is not available in chat.`,
      }),
    );
  }
  const entry = READ_TOOL_REF_FIELD_MAP[toolName];

  const staticDefinition =
    getStaticMcpToolDefinition(toolName) ??
    panic(`Read tool ${toolName} is missing from the static registry`);
  if (
    !isMcpDescriptorFeatureEnabled({
      context,
      kind: "tools",
      id: staticDefinition.name,
      featureId: staticDefinition.featureId,
    })
  ) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "Tool is unavailable.",
      }),
    );
  }
  if (!isMcpToolFeatureEnabled(staticDefinition.feature)) {
    return Result.err(
      new ChatToolError({
        kind: "unavailable",
        message: "This feature is not enabled on this deployment.",
      }),
    );
  }

  const dehydrated = dehydrateInputRefs({ args, refRegistry, toolName });
  if (Result.isError(dehydrated)) {
    return Result.err(dehydrated.error);
  }

  const normalized = normalizeObjectInputAtBoundary({
    access: staticDefinition.access,
    schema: staticDefinition.inputSchema,
    value: dehydrated.value.args,
  });
  if (!normalized.ok) {
    return Result.err(
      toRegistryChatToolError(
        agentInputValidationError({
          failure: normalized,
          subject: `${toolName} arguments`,
        }).error,
      ),
    );
  }
  const scoped =
    scopeArgs === undefined
      ? Result.ok(normalized.value)
      : await scopeArgs(normalized.value);
  if (Result.isError(scoped)) {
    return Result.err(scoped.error);
  }

  let response: McpToolResponse;
  if (handler !== undefined) {
    response = await runInjectedHandler({
      args: scoped.value,
      context,
      toolName,
      handler,
    });
  } else {
    const invocation = await invokeStaticMcpTool({
      args: scoped.value,
      context,
      definition: staticDefinition,
    });
    if (invocation.status === "refused") {
      return Result.err(
        new ChatToolError({
          kind: "unavailable",
          message: `Your member role does not permit ${toolName}.`,
        }),
      );
    }
    response = invocation.response;
  }
  const finished = await finalizeToolEgress({
    context,
    mode: "default",
    response,
  });

  if (finished.status === "error") {
    return Result.err(toRegistryChatToolError(finished.error));
  }

  // One schema-driven pass: strict parse (an unknown key — a field nobody
  // classified — fails closed before it can reach the model), then strip,
  // ref hydration, and the fail-closed "no tenant UUID reaches the model"
  // invariant in the same walk. Failures carry only paths to telemetry.
  const projected = projectForChat({
    dehydration: dehydrated.value,
    payload: finished.data,
    refRegistry,
    schema: entry.projection,
    source: "run-registry-tool",
    toolName,
  });
  return Result.isError(projected)
    ? projected
    : Result.ok(withChatInputNotes(projected.value, normalized.notes));
};
