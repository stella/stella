import { beforeEach, describe, expect, mock, test } from "bun:test";

import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";

/**
 * Machine API keys as an MCP credential.
 *
 * The property under test is not "a key works" — it is that a key is held to
 * *exactly* the authorization a JWT bearer token is held to, and that the extra
 * ways a key can go wrong (revoked, rotated away, owner demoted, owner removed
 * from the org, metadata naming a foreign org) all fail closed.
 *
 * `verifyApiKey` and `resolveMemberAuthorization` are mocked because both are
 * thin wrappers over the database; what this file exercises is the decision
 * logic layered on top of them, which is where an escalation would actually
 * live.
 */

const verifyApiKey = mock();
const resolveMemberAuthorization = mock();

void mock.module("@/api/lib/auth", () => ({
  getAuth: () => ({ api: { verifyApiKey } }),
  resolveMemberAuthorization,
}));

const { resolveMachineApiKeySession } = await import("@/api/mcp/api-key-auth");
const { extractMcpSession } = await import("@/api/mcp/auth");

const OWNER_USER_ID = "user-machine-owner";
const ORG_ID = "org-owning-the-key";
const FOREIGN_ORG_ID = "org-somebody-else";
const CREDENTIAL = `${MACHINE_API_KEY_PREFIX}abcdef0123456789`;
const SCOPES = ["stella:read", "stella:search"];

type KeyOverrides = {
  enabled?: boolean;
  metadata?: unknown;
  permissions?: unknown;
  referenceId?: string;
};

const validKey = (overrides: KeyOverrides = {}) => ({
  enabled: true,
  metadata: { organizationId: ORG_ID, scopes: SCOPES },
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

describe("resolveMachineApiKeySession", () => {
  test("produces the identical session shape the JWT bearer path produces", async () => {
    // This is the crux of treating a key as "another credential type" rather
    // than "another authorization path": whatever comes out here is handed to
    // `resolveMcpSessionContext` exactly as a JWT-derived session is, so if the
    // two shapes ever diverge, the key would be authorized by different rules.
    givenKey();
    givenMemberRole("member");

    const fromKey = await resolveMachineApiKeySession(CREDENTIAL);
    const fromJwt = extractMcpSession({
      org_id: ORG_ID,
      scope: SCOPES.join(" "),
      sub: OWNER_USER_ID,
    });

    expect(fromKey).toEqual(fromJwt);
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

describe("authenticateMcpRequest credential dispatch", () => {
  test("routes a prefixed credential to the API key verifier and never to the JWT verifier", async () => {
    const { authenticateMcpRequest } = await import("@/api/mcp/auth");
    givenKey();
    givenMemberRole("member");

    const session = await authenticateMcpRequest(CREDENTIAL);

    expect(session.userId).toBe(OWNER_USER_ID);
    expect(verifyApiKey).toHaveBeenCalled();
  });

  test("never falls back to the API key verifier for a JWT-shaped credential", async () => {
    // Falling back between verifiers would turn either one's rejection into a
    // second attempt at the other, so a token only ever gets one verification
    // path. A JWT-shaped string must not reach `verifyApiKey` even when it is
    // invalid.
    const { authenticateMcpRequest } = await import("@/api/mcp/auth");

    await authenticateMcpRequest("header.payload.signature").catch(
      () => undefined,
    );

    expect(verifyApiKey).not.toHaveBeenCalled();
  });
});
