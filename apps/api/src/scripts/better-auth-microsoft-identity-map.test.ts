import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
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
  objectId = OBJECT_ID,
  subject = "legacy-pairwise-subject",
}: {
  audience?: string;
  issuer?: string;
  keyId?: string;
  objectId?: string;
  subject?: string;
} = {}) => {
  const token = await new SignJWT({ oid: objectId, tid: TENANT_ID })
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(ISSUED_AT)
    .setNotBefore(ISSUED_AT)
    .setExpirationTime(ISSUED_AT + 3600)
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
        formatVersion: 1,
        microsoftAccounts: [
          {
            accountId: OBJECT_ID,
            accountRowId: "account-row",
            issuer: ISSUER,
            legacyAccountId: "legacy-pairwise-subject",
          },
        ],
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
        formatVersion: 1,
        microsoftAccounts: [],
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
