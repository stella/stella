import { describe, expect, test } from "bun:test";
import { errors, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";

import { parseBetterAuthMicrosoftIdentityMapArgs } from "@/api/scripts/better-auth-microsoft-identity-map";
import {
  BetterAuthMicrosoftIdentityMapInfrastructureError,
  BetterAuthMicrosoftIdentityMapError,
  deriveBetterAuthMicrosoftIdentityMap,
} from "@/api/scripts/better-auth-microsoft-identity-map.logic";
import { MAX_MICROSOFT_IDENTITY_MAPPINGS } from "@/api/scripts/better-auth-migration-audit.logic";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const ISSUED_AT = Math.floor(
  new Date("2026-01-01T12:00:00.000Z").getTime() / 1000,
);
const { privateKey: SIGNING_KEY, publicKey } = await generateKeyPair("RS256");
const PUBLIC_JWK = await exportJWK(publicKey);

const createTokenFixture = async ({
  audience = CLIENT_ID,
  issuer = ISSUER,
  keyId = "fixture-key",
  lifetimeSeconds = 3600,
  objectId = OBJECT_ID,
  subject = "legacy-pairwise-subject",
  tenant = TENANT_ID,
}: {
  audience?: string;
  issuer?: string;
  keyId?: string;
  lifetimeSeconds?: number;
  objectId?: string;
  subject?: string;
  tenant?: string;
} = {}) => {
  const token = await new SignJWT({ oid: objectId, tid: tenant })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(ISSUED_AT)
    .setNotBefore(ISSUED_AT)
    .setExpirationTime(ISSUED_AT + lifetimeSeconds)
    .sign(SIGNING_KEY);
  const getSigningKey: JWTVerifyGetKey = async () => PUBLIC_JWK;
  return { getSigningKey, token };
};

describe("deriveBetterAuthMicrosoftIdentityMap", () => {
  test("verifies an expired historical token and derives the canonical identity", async () => {
    const fixture = await createTokenFixture();
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: fixture.getSigningKey,
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: "common",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value).toEqual({
        identityMap: {
          formatVersion: 1,
          microsoftAccounts: [
            {
              accountId: OBJECT_ID,
              accountRowId: "account-row",
              issuer: ISSUER,
              legacyAccountId: "legacy-pairwise-subject",
            },
          ],
        },
        verification: { signature: 1, "stored-claims": 0 },
      });
    }
  });

  test.each([
    ["missing token", null, "legacy-pairwise-subject", CLIENT_ID, ISSUER],
    ["wrong subject", undefined, "different-subject", CLIENT_ID, ISSUER],
    [
      "wrong audience",
      undefined,
      "legacy-pairwise-subject",
      "other-client",
      ISSUER,
    ],
    [
      "wrong issuer",
      undefined,
      "legacy-pairwise-subject",
      CLIENT_ID,
      "https://issuer.example/v2.0",
    ],
  ])(
    "rejects %s",
    async (_name, tokenOverride, legacyAccountId, audience, issuer) => {
      const fixture = await createTokenFixture({ audience, issuer });
      const result = await deriveBetterAuthMicrosoftIdentityMap({
        clientId: CLIENT_ID,
        getSigningKey: fixture.getSigningKey,
        now: NOW,
        sources: [
          {
            accountRowId: "account-row",
            idToken: tokenOverride === null ? null : fixture.token,
            legacyAccountId,
          },
        ],
        tenantId: "common",
      });

      expect(result.status).toBe("error");
    },
  );

  test("rejects two rows that resolve to the same issuer and oid", async () => {
    const first = await createTokenFixture({
      keyId: "fixture-key-one",
      subject: "legacy-one",
    });
    const second = await createTokenFixture({
      keyId: "fixture-key-two",
      subject: "legacy-two",
    });
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: first.getSigningKey,
      now: NOW,
      sources: [
        {
          accountRowId: "account-one",
          idToken: first.token,
          legacyAccountId: "legacy-one",
        },
        {
          accountRowId: "account-two",
          idToken: second.token,
          legacyAccountId: "legacy-two",
        },
      ],
      tenantId: TENANT_ID,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBeInstanceOf(BetterAuthMicrosoftIdentityMapError);
      expect(result.error.code).toBe("identity-collision");
    }
  });

  test("accepts an empty Microsoft inventory", async () => {
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: async () => {
        throw new Error("unused");
      },
      now: NOW,
      sources: [],
      tenantId: TENANT_ID,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value).toEqual({
        identityMap: { formatVersion: 1, microsoftAccounts: [] },
        verification: { signature: 0, "stored-claims": 0 },
      });
    }
  });

  test("rejects an inventory larger than the consumer accepts", async () => {
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: async () => {
        throw new Error("unused");
      },
      now: NOW,
      sources: Array.from(
        { length: MAX_MICROSOFT_IDENTITY_MAPPINGS + 1 },
        () => ({
          accountRowId: "account-row",
          idToken: null,
          legacyAccountId: "legacy-pairwise-subject",
        }),
      ),
      tenantId: TENANT_ID,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("identity-map-limit-exceeded");
    }
  });

  test("preserves signing-key retrieval failures", async () => {
    const fixture = await createTokenFixture();
    const infrastructureError =
      new BetterAuthMicrosoftIdentityMapInfrastructureError({
        code: "signing-key-fetch-failed",
        message: "Microsoft signing keys could not be fetched",
      });
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: async () => {
        throw infrastructureError;
      },
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: TENANT_ID,
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toBe(infrastructureError);
    }
  });

  const retiredSigningKey = async () => {
    throw new errors.JWKSNoMatchingKey();
  };

  test("derives the identity from stored claims when the signing key is retired", async () => {
    const fixture = await createTokenFixture();
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: retiredSigningKey,
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: "common",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value).toEqual({
        identityMap: {
          formatVersion: 1,
          microsoftAccounts: [
            {
              accountId: OBJECT_ID,
              accountRowId: "account-row",
              issuer: ISSUER,
              legacyAccountId: "legacy-pairwise-subject",
            },
          ],
        },
        verification: { signature: 0, "stored-claims": 1 },
      });
    }
  });

  test("counts signature and stored-claims sources separately", async () => {
    const live = await createTokenFixture({
      keyId: "live-key",
      subject: "legacy-one",
    });
    const retired = await createTokenFixture({
      keyId: "retired-key",
      objectId: "44444444-4444-4444-8444-444444444444",
      subject: "legacy-two",
    });
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: async (header) => {
        if (header.kid === "live-key") {
          return PUBLIC_JWK;
        }
        throw new errors.JWKSNoMatchingKey();
      },
      now: NOW,
      sources: [
        {
          accountRowId: "account-one",
          idToken: live.token,
          legacyAccountId: "legacy-one",
        },
        {
          accountRowId: "account-two",
          idToken: retired.token,
          legacyAccountId: "legacy-two",
        },
      ],
      tenantId: TENANT_ID,
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.verification).toEqual({
        signature: 1,
        "stored-claims": 1,
      });
      expect(result.value.identityMap.microsoftAccounts).toHaveLength(2);
    }
  });

  test.each([
    ["wrong audience", { audience: "other-client" }, "legacy-pairwise-subject"],
    [
      "wrong issuer",
      { issuer: "https://issuer.example/v2.0" },
      "legacy-pairwise-subject",
    ],
    ["wrong subject", {}, "different-subject"],
  ])(
    "still rejects %s when the signing key is retired",
    async (_name, fixtureOverrides, legacyAccountId) => {
      const fixture = await createTokenFixture(fixtureOverrides);
      const result = await deriveBetterAuthMicrosoftIdentityMap({
        clientId: CLIENT_ID,
        getSigningKey: retiredSigningKey,
        now: NOW,
        sources: [
          {
            accountRowId: "account-row",
            idToken: fixture.token,
            legacyAccountId,
          },
        ],
        tenantId: "common",
      });

      expect(result.status).toBe("error");
    },
  );

  test("accepts a personal-account token with a day-long lifetime and non-RFC oid", async () => {
    const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const consumerObjectId = "00000000-0000-0000-1a2b-3c4d5e6f7a8b";
    const fixture = await createTokenFixture({
      issuer: `https://login.microsoftonline.com/${consumerTenant}/v2.0`,
      // A day plus the provider's five-minute issuance padding.
      lifetimeSeconds: 24 * 60 * 60 + 5 * 60,
      objectId: consumerObjectId,
      tenant: consumerTenant,
    });
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: retiredSigningKey,
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: "common",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.identityMap.microsoftAccounts).toEqual([
        {
          accountId: consumerObjectId,
          accountRowId: "account-row",
          issuer: `https://login.microsoftonline.com/${consumerTenant}/v2.0`,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ]);
    }
  });

  test.each([
    ["a day-long lifetime", { lifetimeSeconds: 24 * 60 * 60 }],
    [
      "a non-RFC object id",
      { objectId: "00000000-0000-0000-1a2b-3c4d5e6f7a8b" },
    ],
  ])(
    "rejects a work or school token with %s",
    async (_name, fixtureOverrides) => {
      const fixture = await createTokenFixture(fixtureOverrides);
      const result = await deriveBetterAuthMicrosoftIdentityMap({
        clientId: CLIENT_ID,
        getSigningKey: retiredSigningKey,
        now: NOW,
        sources: [
          {
            accountRowId: "account-row",
            idToken: fixture.token,
            legacyAccountId: "legacy-pairwise-subject",
          },
        ],
        tenantId: "common",
      });

      expect(result.status).toBe("error");
    },
  );

  test("rejects a personal-account token whose lifetime exceeds a day", async () => {
    const consumerTenant = "9188040d-6c67-4c5b-b112-36a304b66dad";
    const fixture = await createTokenFixture({
      issuer: `https://login.microsoftonline.com/${consumerTenant}/v2.0`,
      lifetimeSeconds: 25 * 60 * 60,
      tenant: consumerTenant,
    });
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: fixture.getSigningKey,
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: "common",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("invalid-source-state");
    }
  });

  test("rejects a token whose signature fails against a published key", async () => {
    const fixture = await createTokenFixture();
    const { publicKey: otherPublicKey } = await generateKeyPair("RS256");
    const otherJwk = await exportJWK(otherPublicKey);
    const result = await deriveBetterAuthMicrosoftIdentityMap({
      clientId: CLIENT_ID,
      getSigningKey: async () => otherJwk,
      now: NOW,
      sources: [
        {
          accountRowId: "account-row",
          idToken: fixture.token,
          legacyAccountId: "legacy-pairwise-subject",
        },
      ],
      tenantId: "common",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.code).toBe("token-verification-failed");
    }
  });
});

describe("parseBetterAuthMicrosoftIdentityMapArgs", () => {
  test("requires the private output and explicit write freeze", () => {
    expect(
      parseBetterAuthMicrosoftIdentityMapArgs([
        "--output",
        "/rehearsal/identity-map.json",
        "--writes-frozen",
      ]).status,
    ).toBe("ok");
    expect(
      parseBetterAuthMicrosoftIdentityMapArgs([
        "--output",
        "/rehearsal/identity-map.json",
      ]).status,
    ).toBe("error");
  });

  test.each([
    { args: ["--output", "", "--writes-frozen"] },
    {
      args: [
        "--output",
        "/rehearsal/identity-map.json",
        "--writes-frozen",
        "extra",
      ],
    },
    {
      args: ["--writes-frozen", "/rehearsal/identity-map.json", "--output"],
    },
  ])("rejects an invalid exact argument shape", ({ args }) => {
    expect(parseBetterAuthMicrosoftIdentityMapArgs(args).status).toBe("error");
  });
});
