import { createMCPClient } from "@tanstack/ai-mcp";
import { Result } from "better-result";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createSafeMcpFetch } from "@/api/lib/mcp-upstream/connections";
import { decryptMcpSecret } from "@/api/lib/mcp-upstream/crypto";
import type { EncryptedSecret } from "@/api/lib/mcp-upstream/crypto";
import {
  safeOutboundFetchStream,
  validateOutboundFetchTarget,
} from "@/api/lib/safe-outbound-fetch";

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
    const client = await createMCPClient({
      transport: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${credential}` },
        fetch: createSafeMcpFetch(safeOutboundFetchStream, permit),
      },
    });
    try {
      const tools = await client.tools(undefined, {
        callToolTimeoutMs: 30_000,
      });
      const available = tools.filter(
        (tool) => allowedTools === null || allowedTools.includes(tool.name),
      );
      const tool = available.find(({ name }) => name === operation.toolName);
      if (!tool) {
        throw new HandlerError({
          status: 404,
          message: "Connector tool is unavailable",
        });
      }
      // The connection handles the action; only a fixed receipt can return to chat.
      await tool.execute(operation.arguments);
    } finally {
      await client.close();
    }
  });
  // SDK errors may contain upstream response data; only a fixed error crosses this boundary.
  if (result.isErr()) {
    return Result.err(
      new HandlerError({ status: 502, message: "Connector request failed" }),
    );
  }
  return Result.ok(undefined);
};
