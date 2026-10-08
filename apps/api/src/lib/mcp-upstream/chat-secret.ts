import { Result } from "better-result";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createBearerMcpClient } from "@/api/lib/mcp-upstream/connections";
import { decryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import type { EncryptedSecret } from "@/api/lib/mcp-upstream/crypto";
import { validateOutboundFetchTarget } from "@/api/lib/safe-outbound-fetch";

type CallWithChatSecretOptions = {
  encrypted: EncryptedSecret;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  connectorId: SafeId<"mcpConnector">;
  url: string;
  allowedTools: string[] | null;
  permit: ThirdPartyOutboundPermit;
  operation: { toolName: string; arguments: Record<string, unknown> };
};

export const callWithChatSecret = async ({
  encrypted,
  organizationId,
  userId,
  connectorId,
  url,
  allowedTools,
  permit,
  operation,
}: CallWithChatSecretOptions): Promise<Result<void, HandlerError>> => {
  const target = await validateOutboundFetchTarget(url);
  if (target.isErr()) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Connector address is unavailable",
      }),
    );
  }
  const result = await Result.tryPromise(async () => {
    const credential = await decryptMcpSecret({
      ...encrypted,
      connectorId,
      organizationId,
      userId,
      purpose: "mcp_static_token",
    });
    const client = await createBearerMcpClient({ url, credential, permit });
    try {
      const tools = await client.tools({
        callToolTimeoutMs: 30_000,
      });
      const available = tools.filter(
        (tool) => allowedTools === null || allowedTools.includes(tool.name),
      );
      const tool = available.find(({ name }) => name === operation.toolName);
      if (!tool?.execute) {
        return "tool-unavailable" as const;
      }
      // The connection handles the action; only a fixed receipt can return to chat.
      const completion = await tool.execute(operation.arguments);
      if (
        completion !== null &&
        typeof completion === "object" &&
        "isError" in completion &&
        completion.isError === true
      ) {
        return "failed" as const;
      }
      return "completed" as const;
    } finally {
      await client.close();
    }
  });
  // SDK errors may contain upstream response data; only a fixed error crosses this boundary.
  if (result.isErr() || result.value === "failed") {
    return Result.err(
      new HandlerError({ status: 502, message: "Connector request failed" }),
    );
  }
  if (result.value === "tool-unavailable") {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Connector tool is unavailable",
      }),
    );
  }
  return Result.ok(undefined);
};
