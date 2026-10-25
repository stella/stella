import { TaggedError } from "better-result";
import { and, eq } from "drizzle-orm";

import { oauthClient, oauthClientResource } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { OPEN_REGISTRATION_SCOPES } from "@/api/lib/auth/oauth-registration-policy";
import { createSafeId } from "@/api/lib/branded-types";
import { PARTNER_CLIENT_TYPE } from "@/api/lib/db/partner-client-contract";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

export class PartnerClientOperatorError extends TaggedError(
  "PartnerClientOperatorError",
)<{ message: string }> {}

const PARTNER_CLIENT_AUDIT_ACTOR = "system:partner-client-operator";

export type CreatePartnerOAuthClientOptions = {
  name: string;
  redirectUris: readonly string[];
  mcpResourceUrl: string;
  clientSecretSha256: string;
};

/**
 * No partner clients are seeded; only an explicit operator invocation mints
 * one. The client gets the scopes a self-registered client gets and the MCP
 * resource only; every user still signs in and consents.
 */
export const createPartnerOAuthClientInTransaction = async ({
  tx,
  name,
  redirectUris,
  mcpResourceUrl,
  clientSecretSha256,
}: CreatePartnerOAuthClientOptions & { tx: Transaction }) => {
  const clientId = Bun.randomUUIDv7().replaceAll("-", "");
  await tx.insert(oauthClient).values({
    id: createSafeId<"mcpOAuthClient">(),
    clientId,
    registrationOrigin: "managed",
    type: PARTNER_CLIENT_TYPE,
    name,
    clientSecret: clientSecretSha256,
    public: false,
    requirePKCE: true,
    skipConsent: false,
    tokenEndpointAuthMethod: "client_secret_basic",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    redirectUris: [...redirectUris],
    scopes: [...OPEN_REGISTRATION_SCOPES],
  });
  await tx.insert(oauthClientResource).values({
    id: Bun.randomUUIDv7(),
    clientId,
    resourceId: mcpResourceUrl,
  });
  await recordSystemAudit(tx, PARTNER_CLIENT_AUDIT_ACTOR, {
    subject: createSafeId<"systemScriptRun">(),
    counts: { created: 1, rotated: 0, disabled: 0 },
  });
  return { clientId };
};

export type ChangePartnerOAuthClientOptions =
  | { clientId: string; operation: "rotate"; clientSecretSha256: string }
  | { clientId: string; operation: "disable" };

/**
 * Rotation replaces the secret; refresh needs client authentication, so the
 * old secret stops working at the next refresh. Disabling refuses every new
 * authorization and token request for the client.
 */
export const changePartnerOAuthClientInTransaction = async ({
  tx,
  ...change
}: ChangePartnerOAuthClientOptions & { tx: Transaction }) => {
  const { clientId, operation } = change;
  const changed = await tx
    .update(oauthClient)
    .set(
      change.operation === "rotate"
        ? { clientSecret: change.clientSecretSha256 }
        : { disabled: true },
    )
    .where(
      and(
        eq(oauthClient.clientId, clientId),
        eq(oauthClient.type, PARTNER_CLIENT_TYPE),
        eq(oauthClient.registrationOrigin, "managed"),
        eq(oauthClient.disabled, false),
      ),
    )
    .returning({ clientId: oauthClient.clientId });
  if (changed.length !== 1) {
    return abortTransaction(
      new PartnerClientOperatorError({
        message: "Active partner client not found",
      }),
    );
  }
  await recordSystemAudit(tx, PARTNER_CLIENT_AUDIT_ACTOR, {
    subject: createSafeId<"systemScriptRun">(),
    counts:
      operation === "rotate"
        ? { created: 0, rotated: 1, disabled: 0 }
        : { created: 0, rotated: 0, disabled: 1 },
  });
  return { clientId };
};
