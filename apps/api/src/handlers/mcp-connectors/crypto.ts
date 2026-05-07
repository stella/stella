import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type SecretPurpose =
  | "mcp_access_token"
  | "mcp_refresh_token"
  | "mcp_static_token"
  | "mcp_client_secret";

type SecretEnvelope = {
  connectorId: SafeId<"mcpConnector">;
  purpose: SecretPurpose;
  secret: string;
  userId?: SafeId<"user"> | undefined;
};

export type EncryptedSecret = {
  ciphertext: Buffer;
  iv: Buffer;
};

export const encryptMcpSecret = async ({
  connectorId,
  organizationId,
  purpose,
  secret,
  userId,
}: {
  connectorId: SafeId<"mcpConnector">;
  organizationId: SafeId<"organization">;
  purpose: SecretPurpose;
  secret: string;
  userId?: SafeId<"user"> | undefined;
}): Promise<EncryptedSecret> =>
  await encryptContent(
    organizationId,
    JSON.stringify({
      connectorId,
      purpose,
      secret,
      ...(userId ? { userId } : {}),
    } satisfies SecretEnvelope),
  );

export const decryptMcpSecret = async ({
  ciphertext,
  connectorId,
  iv,
  organizationId,
  purpose,
  userId,
}: {
  ciphertext: Buffer;
  connectorId: SafeId<"mcpConnector">;
  iv: Buffer;
  organizationId: SafeId<"organization">;
  purpose: SecretPurpose;
  userId?: SafeId<"user"> | undefined;
}): Promise<string> => {
  const json = await decryptContent(organizationId, ciphertext, iv);
  const parsed: unknown = JSON.parse(json);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("connectorId" in parsed) ||
    !("purpose" in parsed) ||
    !("secret" in parsed) ||
    parsed.connectorId !== connectorId ||
    parsed.purpose !== purpose ||
    typeof parsed.secret !== "string"
  ) {
    throw new HandlerError({
      status: 500,
      message: "Stored MCP secret envelope is invalid",
    });
  }

  if (userId && (!("userId" in parsed) || parsed.userId !== userId)) {
    throw new HandlerError({
      status: 500,
      message: "Stored MCP secret envelope belongs to a different user",
    });
  }

  return parsed.secret;
};
