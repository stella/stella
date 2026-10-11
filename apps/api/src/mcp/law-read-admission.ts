import { panic, Result } from "better-result";

import {
  admitLawRead,
  type LawReadAdmissionError,
  type LawReadAdmission,
} from "@/api/lib/usage/law-read-admission";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  isThirdPartyOutboundHandler,
  markThirdPartyOutboundHandler,
  type RequiresThirdPartyOutbound,
} from "@/api/mcp/third-party-outbound";
import type {
  InternalToolErrorResult,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { structuredErrorResult } from "@/api/mcp/tool-utils";

export type McpLawReadAdmissionResult =
  | { type: "admitted"; admission: LawReadAdmission }
  | {
      type: "refused";
      code: LawReadAdmissionError["type"];
      result: InternalToolErrorResult;
    };

const admittedHandlers = new WeakSet<object>();

export const isAdmittedMcpLawReadHandler = (handler: unknown): boolean =>
  typeof handler === "function" && admittedHandlers.has(handler);

export const lawReadRefusal = (
  code: LawReadAdmissionError["type"],
): InternalToolErrorResult => {
  switch (code) {
    case "missing_scope":
      return structuredErrorResult({
        code: "missing_scope",
        message: "Public law access is not available in this deployment.",
        hint: "Use an organization and deployment where public law access is enabled, then retry.",
      });
    case "not_entitled":
      return structuredErrorResult({
        code: "not_entitled",
        message:
          "This organization is not entitled to read the public law corpus.",
        hint: "Ask an organization administrator to review public law access for this organization.",
      });
    case "access_unavailable":
      return structuredErrorResult({
        code: "access_unavailable",
        message: "Public law access could not be checked right now.",
        hint: "Retry the request shortly.",
        retryable: true,
      });
    default:
      code satisfies never;
      return panic("Unhandled law read refusal");
  }
};

export const admitMcpLawRead = async (
  context: McpRequestContext,
): Promise<McpLawReadAdmissionResult> => {
  if (
    context.lawReadAdmission !== undefined &&
    context.lawReadAdmission.organizationId === context.organizationId
  ) {
    return { type: "admitted", admission: context.lawReadAdmission };
  }
  const admitted = await (
    context.testDependencies?.admitLawRead ?? admitLawRead
  )({ organizationId: context.organizationId });
  if (Result.isError(admitted)) {
    return {
      type: "refused",
      code: admitted.error.type,
      result: lawReadRefusal(admitted.error.type),
    };
  }
  return { type: "admitted", admission: admitted.value };
};

export function withMcpLawReadAdmission<TData>(
  handler: TypedMcpToolHandler<TData> & RequiresThirdPartyOutbound,
): TypedMcpToolHandler<TData> & RequiresThirdPartyOutbound;
export function withMcpLawReadAdmission<TData>(
  handler: TypedMcpToolHandler<TData>,
): TypedMcpToolHandler<TData>;
export function withMcpLawReadAdmission<TData>(
  handler: McpToolHandler<TData>,
): McpToolHandler<TData>;
export function withMcpLawReadAdmission(
  handler: McpToolHandler,
): McpToolHandler {
  const admittedHandler: McpToolHandler = async ({ args, context }) => {
    const result = await admitMcpLawRead(context);
    if (result.type === "refused") {
      return result.result;
    }
    return await handler({
      args,
      context: { ...context, lawReadAdmission: result.admission },
    });
  };
  admittedHandlers.add(admittedHandler);
  return isThirdPartyOutboundHandler(handler)
    ? markThirdPartyOutboundHandler(admittedHandler)
    : admittedHandler;
}
