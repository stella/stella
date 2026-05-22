import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type {
  AccessToken,
  ClientSecret,
  RefreshToken,
  StaticBearerToken,
} from "@/api/lib/secret-brands";

type SecretPurpose =
  | "mcp_access_token"
  | "mcp_refresh_token"
  | "mcp_static_token"
  | "mcp_client_secret";

// Maps each storage purpose to the in-memory brand its decrypted value
// carries. Keep this in lockstep with SecretPurpose — the discriminated
// return type below depends on it.
type DecryptedFor<P extends SecretPurpose> = P extends "mcp_access_token"
  ? AccessToken
  : P extends "mcp_refresh_token"
    ? RefreshToken
    : P extends "mcp_static_token"
      ? StaticBearerToken
      : P extends "mcp_client_secret"
        ? ClientSecret
        : never;

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

export const decryptMcpSecret = async <P extends SecretPurpose>({
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
  purpose: P;
  userId?: SafeId<"user"> | undefined;
}): Promise<DecryptedFor<P>> => {
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

  // SAFETY: DecryptedFor<P> resolves to a Secret<K> alias whose K is fixed
  // by the SecretPurpose mapping above. This module is the brand-mint
  // boundary for MCP secrets; downstream callers see the discriminated brand.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return parsed.secret as DecryptedFor<P>;
};
