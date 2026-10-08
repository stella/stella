import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { McpRequestContext } from "@/api/mcp/context";
import type { TypedMcpToolResponse } from "@/api/mcp/tool-types";
import { structuredErrorResult } from "@/api/mcp/tool-utils";

const REQUIRES_THIRD_PARTY_OUTBOUND: unique symbol = Symbol(
  "RequiresThirdPartyOutbound",
);

/**
 * Marks a tool handler that reaches a third-party service. Only
 * `withThirdPartyOutbound` attaches it, so the type of a handler map says which
 * tools need a permit: chat binds its read script policy to it, and a read
 * whose handler carries it cannot be offered to scripts.
 */
export type RequiresThirdPartyOutbound = {
  readonly [REQUIRES_THIRD_PARTY_OUTBOUND]: true;
};

type ThirdPartyOutboundHandlerOptions = {
  args: Record<string, unknown>;
  context: McpRequestContext;
  permit: ThirdPartyOutboundPermit;
};

type ThirdPartyOutboundHandler<TData, TDependencies extends unknown[]> = ((
  request: { args: Record<string, unknown>; context: McpRequestContext },
  ...dependencies: TDependencies
) => Promise<TypedMcpToolResponse<TData>>) &
  RequiresThirdPartyOutbound;

/**
 * Declare a handler that reaches a third-party service. The handler receives
 * the context's permit; a context without one (the chat script runner) is
 * refused before the handler runs, so nothing is sent.
 */
export const withThirdPartyOutbound = <
  TData,
  TDependencies extends unknown[] = [],
>(
  handler: (
    options: ThirdPartyOutboundHandlerOptions,
    ...dependencies: TDependencies
  ) => Promise<TypedMcpToolResponse<TData>>,
): ThirdPartyOutboundHandler<TData, TDependencies> =>
  Object.assign(
    async (
      {
        args,
        context,
      }: {
        args: Record<string, unknown>;
        context: McpRequestContext;
      },
      ...dependencies: TDependencies
    ): Promise<TypedMcpToolResponse<TData>> => {
      const permit = context.thirdPartyOutboundPermit;
      if (permit === undefined) {
        return structuredErrorResult({
          code: "permission_denied",
          message:
            "This tool reaches a third-party service and runs only as a direct tool call",
          hint: "Call the tool directly instead of from a script.",
        });
      }
      return await handler({ args, context, permit }, ...dependencies);
    },
    { [REQUIRES_THIRD_PARTY_OUTBOUND]: true } as const,
  );
