import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import {
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
} from "jose";
import type { JWK } from "jose";

import {
  AGENT_AUTH_ASSERTION_TTL_SECONDS,
  AGENT_AUTH_CEREMONY_TTL_SECONDS,
  AGENT_AUTH_ID_JAG_JWT_TYP,
  AGENT_AUTH_POLL_INTERVAL_SECONDS,
  AGENT_AUTH_SERVICE_SCOPES,
} from "@/api/agent-auth/constants";
import { IdJagValidationError, validateIdJag } from "@/api/agent-auth/id-jag";
import { agentDelegation, agentRegistration } from "@/api/db/agent-auth-schema";
import { user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  AgentTokenError,
  createAgentOAuthClient,
  generateOpaqueToken,
  hashClaimToken,
  issueAuthorizationCode,
  mintInternalSessionCookieHeader,
  startServiceAuthRegistration,
} from "@/api/lib/agent-auth";
import type { ServiceAuthCeremony } from "@/api/lib/agent-auth";
import { getAuth } from "@/api/lib/auth";
import { getAuthIssuerUrl } from "@/api/lib/auth-paths";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";

/**
 * Service-issued ES256 signing key for the intermediate
 * `oauth-id-jag+jwt` (Stella's own assertion). Generated once per process
 * and held in memory: the assertion's TTL is minutes, so a key that lives
 * for the process lifetime is sufficient and avoids decrypting
 * better-auth's at-rest-encrypted JWKS private keys (which would couple to
 * its internal key store).
 *
 * DEVIATION from the plan: the intermediate assertion is signed with this
 * dedicated AS-controlled key rather than the better-auth `jwks` row. It
 * is still asymmetric, `typ`-checked, and verifiable only by us.
 */
type ServiceSigningKey = {
  privateKey: CryptoKey;
  publicJwk: JWK;
  kid: string;
};

let serviceSigningKeyPromise: Promise<ServiceSigningKey> | undefined;

const getServiceSigningKey = async (): Promise<ServiceSigningKey> => {
  serviceSigningKeyPromise ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const kid = Bun.randomUUIDv7();
    return { privateKey, publicJwk: { ...publicJwk, kid }, kid };
  })();
  return await serviceSigningKeyPromise;
};

/**
 * The spec-shaped result of a clean (matched or auto-provisioned) ID-JAG
 * registration: a service-issued intermediate assertion the agent
 * re-presents at `/agent/token` to mint its access token.
 */
export type IdJagRegistrationResult = {
  registrationId: string;
  registrationType: "identity_assertion";
  identityAssertion: string;
  assertionExpiresIn: number;
  scopes: readonly string[];
};

/**
 * The terminal outcomes of an ID-JAG identity request. `ready` is a clean
 * match/auto-provision; `interaction_required` forces the human step-up
 * claim ceremony for an existing-email-no-delegation collision, so an
 * external platform can never silently take over an account; `rejected`
 * carries the validation failure for the HTTP mapping.
 */
export type IdJagIdentityOutcome =
  | { kind: "ready"; result: IdJagRegistrationResult }
  | { kind: "interaction_required"; ceremony: ServiceAuthCeremony }
  | { kind: "rejected"; error: IdJagValidationError };

type ResolvedPrincipal = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
};

const findDelegation = async (
  iss: string,
  sub: string,
): Promise<ResolvedPrincipal | undefined> => {
  const rows = await rootDb
    .select({
      userId: agentDelegation.userId,
      organizationId: agentDelegation.organizationId,
    })
    .from(agentDelegation)
    .where(and(eq(agentDelegation.iss, iss), eq(agentDelegation.sub, sub)))
    .limit(1);
  const row = rows.at(0);
  if (!row) {
    return undefined;
  }
  // Stored delegation IDs were branded when written; re-brand on read so the
  // resolved principal carries proof of ownership through the type system.
  return brandActorSessionIdentity({
    organizationId: row.organizationId,
    userId: row.userId,
  });
};

const findUserByEmail = async (
  email: string,
): Promise<{ id: string } | undefined> => {
  const rows = await rootDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return rows.at(0);
};

class ProvisionError extends Error {
  override name = "ProvisionError";
}

/**
 * Auto-provision a brand-new identity: create a better-auth user from the
 * verified email through the internal adapter (so the same user-create
 * database hooks normal signup runs apply) and bootstrap a default org
 * through the organization plugin's `createOrganization` (the same path a
 * human's first org goes through), which also adds the user as the owner
 * member. No org/member creation is hand-rolled here.
 */
const autoProvision = async (
  email: string,
): Promise<Result<ResolvedPrincipal, ProvisionError>> => {
  const auth = getAuth();
  const provisioned = await Result.tryPromise(async () => {
    const ctx = await auth.$context;
    const localPart = email.split("@").at(0)?.trim() ?? "";
    const createdUser = await ctx.internalAdapter.createUser({
      email,
      name: localPart.length > 0 ? localPart : email,
      emailVerified: true,
    });

    // If org bootstrap fails the user is already persisted; delete it so a
    // failed provision never leaves an orgless, unreachable account behind.
    const orgResult = await Result.tryPromise(
      async () =>
        await auth.api.createOrganization({
          body: {
            name:
              localPart.length > 0 ? `${localPart}'s workspace` : "Workspace",
            slug: `agent-${Bun.randomUUIDv7().slice(0, 12)}`,
            userId: createdUser.id,
            keepCurrentActiveOrganization: true,
          },
        }),
    );
    if (Result.isError(orgResult)) {
      await rootDb.delete(user).where(eq(user.id, createdUser.id));
      throw new ProvisionError();
    }
    return brandActorSessionIdentity({
      organizationId: orgResult.value.id,
      userId: createdUser.id,
    });
  });

  if (Result.isError(provisioned)) {
    return Result.err(new ProvisionError());
  }
  return Result.ok(provisioned.value);
};

const writeDelegation = async ({
  iss,
  sub,
  userId,
  organizationId,
}: {
  iss: string;
  sub: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
}): Promise<void> => {
  await rootDb
    .insert(agentDelegation)
    .values({
      id: createSafeId<"mcpOAuthClient">(),
      iss,
      sub,
      userId,
      organizationId,
    })
    .onConflictDoNothing();
};

const signServiceAssertion = async (
  registrationId: string,
): Promise<string> => {
  const key = await getServiceSigningKey();
  const issuer = getAuthIssuerUrl();
  return await new SignJWT({})
    .setProtectedHeader({
      alg: "ES256",
      typ: AGENT_AUTH_ID_JAG_JWT_TYP,
      kid: key.kid,
    })
    .setIssuer(issuer)
    .setAudience(issuer)
    .setSubject(registrationId)
    .setIssuedAt()
    .setExpirationTime(`${AGENT_AUTH_ASSERTION_TTL_SECONDS}s`)
    .sign(key.privateKey);
};

/**
 * Verify a service-issued intermediate assertion against our own signing
 * key and return the bound registration id (`sub`). Rejects anything not
 * signed by us, with the wrong `typ`, wrong audience/issuer, or expired.
 */
export const verifyServiceAssertion = async (
  assertion: string,
): Promise<Result<string, AgentTokenError>> => {
  const key = await getServiceSigningKey();
  const publicKey = await importJWK(key.publicJwk, "ES256");
  const issuer = getAuthIssuerUrl();
  const verified = await Result.tryPromise(
    async () =>
      await jwtVerify(assertion, publicKey, {
        issuer,
        audience: issuer,
        algorithms: ["ES256"],
        typ: AGENT_AUTH_ID_JAG_JWT_TYP,
        requiredClaims: ["sub", "exp"],
      }),
  );
  if (Result.isError(verified)) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }
  const sub = verified.value.payload.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }
  return Result.ok(sub);
};

/**
 * Create an agent client + a `claimed` registration row holding a fresh
 * authorization code bound to the resolved principal, then mint the
 * service-issued intermediate assertion. The registration is born
 * `claimed` (not `pending`): there is no human step for a clean ID-JAG
 * match, so the code is ready for the jwt-bearer exchange immediately.
 */
const issueRegistrationForPrincipal = async (
  principal: ResolvedPrincipal,
): Promise<Result<IdJagRegistrationResult, AgentTokenError>> => {
  const registrationId = createSafeId<"mcpOAuthClient">();
  const credentials = await createAgentOAuthClient({
    registrationType: "identity_assertion",
    registrationId,
    scopes: AGENT_AUTH_SERVICE_SCOPES,
    grantTypes: ["authorization_code"],
  });

  const sessionCookieHeader = await mintInternalSessionCookieHeader({
    userId: principal.userId,
    organizationId: principal.organizationId,
  });
  const codeResult = await issueAuthorizationCode({
    clientId: credentials.clientId,
    scopes: AGENT_AUTH_SERVICE_SCOPES,
    sessionCookieHeader,
  });
  if (Result.isError(codeResult)) {
    return Result.err(new AgentTokenError("token_mint_failed"));
  }

  const expiresAt = new Date(
    Date.now() + AGENT_AUTH_CEREMONY_TTL_SECONDS * 1000,
  );
  await rootDb.insert(agentRegistration).values({
    id: registrationId,
    registrationType: "identity_assertion",
    status: "claimed",
    // ID-JAG has no human claim token; store an opaque hash so the
    // notNull constraint holds and a claim-grant poll never resolves it.
    claimTokenHash: hashClaimToken(generateOpaqueToken()),
    clientId: credentials.clientId,
    clientSecretSink: credentials.clientSecret,
    boundUserId: principal.userId,
    boundOrganizationId: principal.organizationId,
    grantedScopes: [...AGENT_AUTH_SERVICE_SCOPES],
    authorizationCode: codeResult.value,
    pollIntervalSeconds: AGENT_AUTH_POLL_INTERVAL_SECONDS,
    expiresAt,
  });

  const identityAssertion = await signServiceAssertion(registrationId);
  return Result.ok({
    registrationId,
    registrationType: "identity_assertion",
    identityAssertion,
    assertionExpiresIn: AGENT_AUTH_ASSERTION_TTL_SECONDS,
    scopes: AGENT_AUTH_SERVICE_SCOPES,
  });
};

const finishReady = async (
  principal: ResolvedPrincipal,
): Promise<IdJagIdentityOutcome> => {
  const result = await issueRegistrationForPrincipal(principal);
  if (Result.isError(result)) {
    return {
      kind: "rejected",
      error: new IdJagValidationError(
        "invalid_assertion",
        "Could not issue an agent registration.",
      ),
    };
  }
  return { kind: "ready", result: result.value };
};

/**
 * Tag the step-up ceremony registration with the pending `(iss, sub)` so
 * the human's confirm can write the delegation.
 */
const bindCeremonyToIssuer = async ({
  registrationId,
  iss,
  sub,
}: {
  registrationId: string;
  iss: string;
  sub: string;
}): Promise<void> => {
  await rootDb
    .update(agentRegistration)
    .set({ pendingDelegationIss: iss, pendingDelegationSub: sub })
    .where(eq(agentRegistration.id, registrationId));
};

/**
 * Resolve an inbound ID-JAG to a terminal outcome. Resolution order is
 * the trust-critical part:
 *   1. `(iss, sub)` delegation exists -> route to that principal.
 *   2. verified email matches an existing user with NO delegation ->
 *      interaction_required step-up (never silent-bind).
 *   3. no match -> auto-provision a new user + default org.
 * A delegation row is written on (3) and after the human completes the
 * step-up for (2) (see confirmIdJagDelegation).
 */
export const resolveIdJagIdentity = async (
  assertion: string,
): Promise<IdJagIdentityOutcome> => {
  const validated = await validateIdJag(assertion);
  if (Result.isError(validated)) {
    return { kind: "rejected", error: validated.error };
  }
  const { iss, sub, email } = validated.value;

  const delegation = await findDelegation(iss, sub);
  if (delegation) {
    return await finishReady(delegation);
  }

  const existingUser = await findUserByEmail(email);
  if (existingUser) {
    const ceremony = await startServiceAuthRegistration(email);
    await bindCeremonyToIssuer({
      registrationId: ceremony.registrationId,
      iss,
      sub,
    });
    return { kind: "interaction_required", ceremony };
  }

  const provisioned = await autoProvision(email);
  if (Result.isError(provisioned)) {
    return {
      kind: "rejected",
      error: new IdJagValidationError(
        "invalid_assertion",
        "Could not provision an account for this identity.",
      ),
    };
  }
  await writeDelegation({ iss, sub, ...provisioned.value });
  return await finishReady(provisioned.value);
};

/**
 * After a human confirms an ID-JAG step-up ceremony, write the durable
 * `(iss, sub)` delegation so the next assertion routes straight to the
 * bound principal. A no-op for ceremonies with no pending delegation
 * (plain service_auth claims).
 */
export const confirmIdJagDelegation = async ({
  registrationId,
  userId,
  organizationId,
}: {
  registrationId: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
}): Promise<void> => {
  const rows = await rootDb
    .select({
      iss: agentRegistration.pendingDelegationIss,
      sub: agentRegistration.pendingDelegationSub,
    })
    .from(agentRegistration)
    .where(eq(agentRegistration.id, registrationId))
    .limit(1);
  const pending = rows.at(0);
  if (!pending?.iss || !pending.sub) {
    return;
  }
  await writeDelegation({
    iss: pending.iss,
    sub: pending.sub,
    userId,
    organizationId,
  });
};

/**
 * Resolve a verified registration id (the service-assertion `sub`) to its
 * confidential client credentials + one-shot authorization code for the
 * jwt-bearer token exchange. Returns the bound org so the caller can keep
 * the issued token's `org_id` consistent.
 */
export type IdJagExchangeContext = {
  clientId: string;
  clientSecret: string;
  authorizationCode: string;
};

export const loadIdJagExchangeContext = async (
  registrationId: string,
): Promise<Result<IdJagExchangeContext, AgentTokenError>> => {
  const rows = await rootDb
    .select({
      clientId: agentRegistration.clientId,
      clientSecretSink: agentRegistration.clientSecretSink,
      authorizationCode: agentRegistration.authorizationCode,
      status: agentRegistration.status,
      expiresAt: agentRegistration.expiresAt,
      registrationType: agentRegistration.registrationType,
    })
    .from(agentRegistration)
    .where(eq(agentRegistration.id, registrationId))
    .limit(1);

  const registration = rows.at(0);
  if (
    !registration ||
    registration.registrationType !== "identity_assertion" ||
    registration.status !== "claimed"
  ) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }
  if (registration.expiresAt < new Date()) {
    return Result.err(new AgentTokenError("expired_token"));
  }
  if (!registration.authorizationCode) {
    return Result.err(new AgentTokenError("invalid_grant"));
  }

  // Consume the code one-shot: clear it before the exchange so a replayed
  // service assertion cannot mint a second token.
  await rootDb
    .update(agentRegistration)
    .set({ authorizationCode: null })
    .where(eq(agentRegistration.id, registrationId));

  return Result.ok({
    clientId: registration.clientId,
    clientSecret: registration.clientSecretSink,
    authorizationCode: registration.authorizationCode,
  });
};
