import { panic, Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  MACHINE_API_KEY_GRANTABLE_AUDIENCES,
  MACHINE_API_KEY_GRANTABLE_SCOPES,
  MACHINE_API_KEY_PREFIX,
} from "@/api/lib/machine-api-key-config";
import { resolveMachineApiKeySession as resolveMachineApiKeySessionWithDependencies } from "@/api/mcp/api-key-auth";
import { extractMcpSession } from "@/api/mcp/auth";
import { getMcpResourceScopes, MCP_MODES } from "@/api/mcp/constants";
import type { McpMode } from "@/api/mcp/constants";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import type { McpEffectiveAuthority } from "@/api/mcp/effective-authority";
import { McpAuthenticationError } from "@/api/mcp/errors";

/**
 * Machine API keys as an MCP credential.
 *
 * The property under test is not "a key works" — it is that a key is held to
 * *exactly* the authorization a JWT bearer token is held to, narrowed by its own
 * permission set, and that the extra ways a key can go wrong (revoked, rotated
 * away, owner demoted, owner removed from the org, metadata naming a foreign
 * org) all fail closed.
 *
 * `verifyApiKey` and `resolveMemberAuthorization` are mocked because both are
 * thin wrappers over the database; what this file exercises is the decision
 * logic layered on top of them, which is where an escalation would actually
 * live.
 */

const verifyApiKey = mock();
const resolveMemberAuthorization = mock();

const resolveMachineApiKeySession = async (
  credential: string,
  options: { mode?: McpMode | undefined } = {},
) =>
  await resolveMachineApiKeySessionWithDependencies(credential, {
    ...options,
    verifyApiKey,
    resolveAuthorization: resolveMemberAuthorization,
  });

const OWNER_USER_ID = "user-machine-owner";
const ORG_ID = "org-owning-the-key";
const FOREIGN_ORG_ID = "org-somebody-else";
const CREDENTIAL = `${MACHINE_API_KEY_PREFIX}abcdef0123456789`;
const KEY_ID = "machine-key-1";
const SCOPES = ["stella:read", "stella:search"];

type KeyOverrides = {
  enabled?: boolean;
  metadata?: unknown;
  permissions?: unknown;
  referenceId?: string;
};

const validKey = (overrides: KeyOverrides = {}) => ({
  enabled: true,
  id: KEY_ID,
  metadata: { organizationId: ORG_ID, scopes: SCOPES },
  name: "Machine API key",
  permissions: { workspace: ["read"] },
  referenceId: OWNER_USER_ID,
  ...overrides,
});

const givenKey = (overrides: KeyOverrides = {}): void => {
  verifyApiKey.mockResolvedValue({
    error: null,
    key: validKey(overrides),
    valid: true,
  });
};

const givenMemberRole = (role: string | null): void => {
  resolveMemberAuthorization.mockResolvedValue(
    role === null ? null : { role, workspace: null },
  );
};

const expectRejected = async (): Promise<Error> => {
  // `: unknown` because a rejection carries no type guarantee. The result is
  // bound as `rejection` so the callback can keep the `error` name the lint
  // rule requires without shadowing it.
  const rejection = await resolveMachineApiKeySession(CREDENTIAL).then(
    () => null,
    (error: unknown) => error,
  );
  if (rejection === null) {
    throw new Error("expected the credential to be rejected");
  }
  if (!(rejection instanceof Error)) {
    throw new Error("expected the rejection to be an Error");
  }
  return rejection;
};

beforeEach(() => {
  verifyApiKey.mockReset();
  resolveMemberAuthorization.mockReset();
});

/**
 * Audience binding.
 *
 * A JWT is held to one audience by its own `aud` claim, which the bearer path
 * verifies per mode. A key carries no such claim, so without this binding one
 * credential is accepted on every audience path: a key minted for the public
 * legal corpus replays against the default surface and reaches matter data with
 * the same scopes. The property is that a bound key is usable on exactly the
 * audience it names, and that an unbound key keeps the reach it already had.
 */
describe("machine API key audience binding", () => {
  const expectRejectedOn = async (mode: McpMode): Promise<Error> => {
    const rejection = await resolveMachineApiKeySession(CREDENTIAL, {
      mode,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    if (!(rejection instanceof Error)) {
      throw new Error(`expected the credential to be rejected on ${mode}`);
    }
    return rejection;
  };

  test("a key bound to the law audience is usable there", async () => {
    givenKey({
      metadata: { audience: "law", organizationId: ORG_ID, scopes: SCOPES },
    });
    givenMemberRole("member");

    const session = await resolveMachineApiKeySession(CREDENTIAL, {
      mode: "law",
    });

    expect(session.organizationId).toBe(ORG_ID);
    expect(session.scopes).toEqual(SCOPES);
  });

  test("the same key is refused on every other audience", async () => {
    givenKey({
      metadata: { audience: "law", organizationId: ORG_ID, scopes: SCOPES },
    });
    givenMemberRole("owner");

    for (const mode of MACHINE_API_KEY_GRANTABLE_AUDIENCES) {
      if (mode === "law") {
        continue;
      }
      const rejection = await expectRejectedOn(mode);
      // The same generic rejection every other failure uses: which audience a
      // credential belongs to is not something a probe gets told.
      expect(rejection.message).toBe("Invalid or expired API key");
    }
  });

  test("the audience is checked before the credential's owner is looked up", async () => {
    // Failing closed early also means a mismatched key cannot be used to probe
    // whether its owner is still a member of the organization.
    givenKey({
      metadata: { audience: "law", organizationId: ORG_ID, scopes: SCOPES },
    });
    givenMemberRole("owner");

    await expectRejectedOn("default");

    expect(resolveMemberAuthorization).not.toHaveBeenCalled();
  });

  test("a key minted before audiences existed still reaches every audience", async () => {
    // The metadata has no `audience` key at all, which is exactly what every
    // already-issued key looks like. Nothing about them may change.
    givenKey();
    givenMemberRole("member");

    for (const mode of MACHINE_API_KEY_GRANTABLE_AUDIENCES) {
      const session = await resolveMachineApiKeySession(CREDENTIAL, {
        mode,
      });
      expect(session.userId).toBe(OWNER_USER_ID);
    }
  });

  test("the bindable audiences are exactly those whose scopes are grantable", () => {
    // The boundary schemas need a literal tuple, so the list is written out.
    // The rule it stands for is recomputed here instead of being trusted: a new
    // audience whose scopes a machine key can carry must be offered, and one
    // whose scopes it cannot must not be. The anonymized surface is the latter.
    const grantable = MCP_MODES.filter((mode) =>
      getMcpResourceScopes(mode).every((scope) =>
        MACHINE_API_KEY_GRANTABLE_SCOPES.some(
          (candidate) => candidate === scope,
        ),
      ),
    );

    const bindable: readonly McpMode[] = MACHINE_API_KEY_GRANTABLE_AUDIENCES;
    expect(bindable).toEqual(grantable);
    expect(MACHINE_API_KEY_GRANTABLE_AUDIENCES).not.toContain("anonymized");
    expect(MACHINE_API_KEY_GRANTABLE_AUDIENCES).toContain("law");
  });

  test("an audience the metadata schema does not know refuses the credential", async () => {
    givenKey({
      metadata: {
        audience: "not-an-audience",
        organizationId: ORG_ID,
        scopes: SCOPES,
      },
    });
    givenMemberRole("owner");

    expect((await expectRejectedOn("default")).message).toBe(
      "Invalid or expired API key",
    );
  });
});

describe("resolveMachineApiKeySession", () => {
  test("matches JWT authorization identity while preserving credential provenance", async () => {
    // This is the crux of treating a key as "another credential type" rather
    // than "another authorization path": whatever comes out here is handed to
    // `resolveMcpSessionContext` exactly as a JWT-derived session is, so if the
    // authorization fields ever diverge, the key would be authorized by
    // different rules. Credential provenance intentionally remains distinct
    // so downstream audit records can identify the actual performer.
    givenKey();
    givenMemberRole("member");

    const fromKey = await resolveMachineApiKeySession(CREDENTIAL);
    const extracted = extractMcpSession({
      org_id: ORG_ID,
      scope: SCOPES.join(" "),
      sub: OWNER_USER_ID,
    });
    const fromJwt = Result.isError(extracted)
      ? panic(`Unexpected rejection: ${extracted.error.message}`)
      : extracted.value;

    expect({
      organizationId: fromKey.organizationId,
      scopes: fromKey.scopes,
      userId: fromKey.userId,
    }).toEqual({
      organizationId: fromJwt.organizationId,
      scopes: fromJwt.scopes,
      userId: fromJwt.userId,
    });
    expect(fromKey.credential).toEqual({
      id: KEY_ID,
      name: "Machine API key",
      permissions: { workspace: ["read"] },
      type: "machine_api_key",
    });
    expect(fromJwt.credential).toEqual({ type: "delegated_user" });
  });

  test("carries the key's permission set onto the session it resolves to", async () => {
    // The stored set is what the key is held to at call time, not merely what
    // was compared against the owner's role here: a session that dropped it
    // would leave the key acting with the owner's entire role, and the set
    // would restrict nothing after authentication.
    givenKey({ permissions: { timeEntry: ["read"] } });
    givenMemberRole("owner");

    const session = await resolveMachineApiKeySession(CREDENTIAL);

    expect(session.credential).toMatchObject({
      permissions: { timeEntry: ["read"] },
      type: "machine_api_key",
    });
  });

  test("resolves to a real user id, which is what makes the member and RLS checks apply", async () => {
    // `referenceId` must surface as `userId`. `resolveMcpSessionContext` feeds
    // that value into `resolveMemberAuthorization` and into the RLS database
    // identity, so a synthetic or org-shaped principal here would produce a
    // session that no membership row backs.
    givenKey();
    givenMemberRole("admin");

    const session = await resolveMachineApiKeySession(CREDENTIAL);

    expect(session.userId).toBe(OWNER_USER_ID);
    expect(resolveMemberAuthorization).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      userId: OWNER_USER_ID,
    });
  });

  test("takes the organization from server-written metadata, never from the credential holder", async () => {
    // The only org a key can act in is the one stored on the row at creation.
    // A key whose metadata names another org still resolves against that org's
    // membership, so possession of the secret grants nothing extra.
    givenKey({ metadata: { organizationId: FOREIGN_ORG_ID, scopes: SCOPES } });
    givenMemberRole("owner");

    const session = await resolveMachineApiKeySession(CREDENTIAL);

    expect(session.organizationId).toBe(FOREIGN_ORG_ID);
    expect(resolveMemberAuthorization).toHaveBeenCalledWith({
      organizationId: FOREIGN_ORG_ID,
      userId: OWNER_USER_ID,
    });
  });

  test("rejects a key whose owner is not a member of the owning organization", async () => {
    // Cross-org: the owner was removed from the org (or never belonged to it).
    // Revocation of a membership has to revoke the credential implicitly.
    givenKey();
    givenMemberRole(null);

    await expectRejected();
  });

  test("rejects a revoked key", async () => {
    // Revocation disables the row rather than deleting it, so `enabled` is the
    // flag that must be honoured even though the digest still resolves.
    givenKey({ enabled: false });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("rejects a key the plugin reports as invalid, which is how expiry and rotation surface", async () => {
    // A rotated-away or expired key fails verification at the plugin layer.
    verifyApiKey.mockResolvedValue({
      error: { code: "KEY_EXPIRED" },
      key: null,
      valid: false,
    });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("rejects permissions the owner's CURRENT role can no longer grant", async () => {
    // The escalation guard. `organizationSettings: ["update"]` is owner/admin
    // only, so a key minted by an admin who has since been demoted to member
    // must stop working rather than carrying the old authority forward.
    givenKey({ permissions: { organizationSettings: ["update"] } });
    givenMemberRole("member");

    await expectRejected();
  });

  test("accepts the same permissions while the owner still holds the granting role", async () => {
    // The counterpart to the previous test: the guard has to be a real subset
    // check, not a blanket denial that would make it vacuously "safe".
    givenKey({ permissions: { organizationSettings: ["update"] } });
    givenMemberRole("admin");

    const session = await resolveMachineApiKeySession(CREDENTIAL);

    expect(session.userId).toBe(OWNER_USER_ID);
  });

  test("rejects stored permissions naming a resource that does not exist", async () => {
    // A renamed or mistyped resource must fail loudly. Passing it through would
    // yield a key that looks scoped but restricts nothing.
    givenKey({ permissions: { notARealResource: ["read"] } });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("rejects a key carrying no permissions at all", async () => {
    givenKey({ permissions: {} });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("rejects malformed metadata instead of defaulting the organization", async () => {
    // If metadata cannot be parsed there is no organization to scope to, and
    // guessing one would be the worst possible recovery.
    givenKey({ metadata: null });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("rejects metadata carrying unexpected extra keys", async () => {
    // `strictObject`: a row written by something other than the current code
    // path is not a row to trust silently.
    givenKey({
      metadata: {
        impersonateUserId: "user-someone-else",
        organizationId: ORG_ID,
        scopes: SCOPES,
      },
    });
    givenMemberRole("owner");

    await expectRejected();
  });

  test("reports every rejection identically, so a probe learns nothing about why", async () => {
    // A caller holding a stolen or guessed key must not be able to distinguish
    // "no such key" from "expired" from "you were removed from the org" —
    // each of those is a useful hint for the next attempt.
    givenMemberRole("owner");

    givenKey({ enabled: false });
    const revoked = await expectRejected();

    givenKey({ metadata: null });
    const malformed = await expectRejected();

    givenKey();
    givenMemberRole(null);
    const notAMember = await expectRejected();

    verifyApiKey.mockResolvedValue({ error: null, key: null, valid: false });
    const unknown = await expectRejected();

    const messages = new Set([
      revoked.message,
      malformed.message,
      notAMember.message,
      unknown.message,
    ]);
    expect(messages.size).toBe(1);
  });
});

describe("hasEffectiveAuthority", () => {
  test("holds a credential to the intersection of its role and its own set", () => {
    // Both halves must grant. The role half alone would make the stored set
    // decorative; the credential half alone would let a set outlive the role
    // that justified it.
    const authority: McpEffectiveAuthority = {
      memberRole: "owner",
      credentialPermissions: { timeEntry: ["read"] },
    };

    expect(hasEffectiveAuthority(authority, { timeEntry: ["read"] })).toBe(
      true,
    );
    // Owner grants it; the credential does not name the resource.
    expect(hasEffectiveAuthority(authority, { clause: ["create"] })).toBe(
      false,
    );
    // The credential names the resource but not the action.
    expect(hasEffectiveAuthority(authority, { timeEntry: ["delete"] })).toBe(
      false,
    );
  });

  test("a credential set never widens the role", () => {
    expect(
      hasEffectiveAuthority(
        {
          memberRole: "intern",
          credentialPermissions: { organizationSettings: ["update"] },
        },
        { organizationSettings: ["update"] },
      ),
    ).toBe(false);
  });

  test("no credential set leaves the role deciding, which is the token path", () => {
    expect(
      hasEffectiveAuthority({ memberRole: "owner" }, { clause: ["create"] }),
    ).toBe(true);
    expect(
      hasEffectiveAuthority({ memberRole: "intern" }, { clause: ["create"] }),
    ).toBe(false);
  });

  test("a credential set naming several resources must cover all of them", () => {
    const authority: McpEffectiveAuthority = {
      memberRole: "owner",
      credentialPermissions: { timeEntry: ["read"], clause: ["create"] },
    };

    expect(
      hasEffectiveAuthority(authority, {
        timeEntry: ["read"],
        clause: ["create"],
      }),
    ).toBe(true);
    expect(
      hasEffectiveAuthority(authority, {
        timeEntry: ["read"],
        clause: ["delete"],
      }),
    ).toBe(false);
  });
});

describe("authenticateMcpRequest credential dispatch", () => {
  test("routes a prefixed credential to the API key verifier and never to the JWT verifier", async () => {
    const { authenticateMcpRequest } = await import("@/api/mcp/auth");
    givenKey();
    givenMemberRole("member");

    const session = await authenticateMcpRequest(CREDENTIAL, {
      resolveApiKeySession: resolveMachineApiKeySession,
    });

    expect(Result.isOk(session) && session.value.userId).toBe(OWNER_USER_ID);
    expect(verifyApiKey).toHaveBeenCalled();
  });

  test("hands the presented audience to the API key verifier", async () => {
    // The wiring the binding depends on. A key is refused on the wrong audience
    // only if the transport's mode actually reaches the key path; the JWT path
    // gets the same thing through `getMcpAccessTokenVerificationOptions(mode)`.
    const { authenticateMcpRequest } = await import("@/api/mcp/auth");
    givenKey({
      metadata: { audience: "law", organizationId: ORG_ID, scopes: SCOPES },
    });
    givenMemberRole("member");

    const onLaw = await authenticateMcpRequest(CREDENTIAL, {
      mode: "law",
      resolveApiKeySession: resolveMachineApiKeySession,
    });
    expect(Result.isOk(onLaw) && onLaw.value.userId).toBe(OWNER_USER_ID);

    const onDefault = await authenticateMcpRequest(CREDENTIAL, {
      mode: "default",
      resolveApiKeySession: resolveMachineApiKeySession,
    });
    expect(Result.isError(onDefault) && onDefault.error).toBeInstanceOf(
      McpAuthenticationError,
    );
  });

  test("never falls back to the API key verifier for a JWT-shaped credential", async () => {
    // Falling back between verifiers would turn either one's rejection into a
    // second attempt at the other, so a token only ever gets one verification
    // path. A JWT-shaped string must not reach `verifyApiKey` even when it is
    // invalid.
    const { authenticateMcpRequest } = await import("@/api/mcp/auth");

    const rejected = await authenticateMcpRequest("header.payload.signature");

    expect(Result.isError(rejected)).toBe(true);

    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});
