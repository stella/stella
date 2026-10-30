import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { agentRegistration } from "@/api/db/agent-auth-schema";
import { rootDb } from "@/api/db/root";
import { oauthGrantRevocations } from "@/api/db/schema";
import type { McpSession } from "@/api/mcp/auth";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

const admittedOAuthCredential = Symbol("admittedOAuthCredential");
type OAuthCredential = Extract<
  NonNullable<McpSession["credential"]>,
  { type: "oauth_client" }
>;
export type AdmittedOAuthCredential = OAuthCredential & {
  readonly [admittedOAuthCredential]: true;
  readonly registrationId: string | null;
};
export type AdmittedMcpSession = Omit<McpSession, "credential"> & {
  credential?:
    | Exclude<McpSession["credential"], OAuthCredential>
    | AdmittedOAuthCredential;
};

type AdmitOAuthCredentialOptions = {
  credential: OAuthCredential;
  organizationId: string;
  userId: string;
  db?: Pick<typeof rootDb, "select">;
};

/**
 * Owner-level admission reads the deny-by-default OAuth control-plane rows.
 * Bind registration attribution in the same read to avoid a second lookup.
 */
export const admitOAuthCredential = async ({
  credential,
  organizationId,
  userId,
  db = rootDb,
}: AdmitOAuthCredentialOptions): Promise<
  Result<AdmittedOAuthCredential, McpAuthenticationError>
> => {
  const match = (
    await db
      .select({
        registrationId: agentRegistration.id,
        revokedAt: oauthGrantRevocations.revokedAt,
      })
      .from(sql`(SELECT 1) AS oauth_session`)
      .leftJoin(
        agentRegistration,
        and(
          eq(agentRegistration.clientId, credential.clientId),
          eq(agentRegistration.boundUserId, userId),
          eq(agentRegistration.boundOrganizationId, organizationId),
          eq(agentRegistration.status, "claimed"),
        ),
      )
      .leftJoin(
        oauthGrantRevocations,
        and(
          eq(oauthGrantRevocations.oauthClientId, credential.clientId),
          eq(oauthGrantRevocations.userId, userId),
          eq(oauthGrantRevocations.organizationId, organizationId),
          credential.grantId === undefined
            ? sql`${oauthGrantRevocations.revokedAt} >= to_timestamp(${credential.issuedAt})`
            : eq(oauthGrantRevocations.grantId, credential.grantId),
        ),
      )
      .limit(1)
  ).at(0);
  if (match?.revokedAt !== null && match?.revokedAt !== undefined) {
    return Result.err(
      new McpAuthenticationError({ message: "Invalid or expired token" }),
    );
  }
  return Result.ok({
    ...credential,
    [admittedOAuthCredential]: true,
    registrationId: match?.registrationId ?? null,
  });
};

type AdmitMcpSessionOptions = {
  db?: Pick<typeof rootDb, "select">;
};

export const admitMcpSession = async (
  { credential, ...session }: McpSession,
  options: AdmitMcpSessionOptions = {},
): Promise<
  Result<AdmittedMcpSession, McpAuthenticationError | McpTokenVerificationError>
> => {
  if (credential?.type !== "oauth_client") {
    return Result.ok({
      ...session,
      ...(credential === undefined ? {} : { credential }),
    });
  }
  const admitted = await Result.tryPromise({
    try: async () =>
      await admitOAuthCredential({
        credential,
        organizationId: session.organizationId,
        userId: session.userId,
        ...options,
      }),
    catch: (cause) =>
      new McpTokenVerificationError({
        message: "Token admission is temporarily unavailable",
        cause,
      }),
  });
  if (admitted.isErr()) {
    return admitted;
  }
  return admitted.value.map((value) => ({ ...session, credential: value }));
};
