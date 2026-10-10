import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";

import { createDesktopLinkRedeemHandler } from "@/api/handlers/desktop-registry/redeem-link";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { brandActorSessionIdentity } from "@/api/lib/safe-id-boundaries";
import { PRIVATE_CACHE_CONTROL } from "@/api/lib/security-headers";

type RedemptionServices = NonNullable<
  Parameters<typeof createDesktopLinkRedeemHandler>[0]
>;
type RedemptionScenario =
  | "credential"
  | "invalid-credential"
  | "connected"
  | "other-user"
  | "other-organization"
  | "audit-failure"
  | "mint-failure";

const createRedemptionFixture = (
  scenario: RedemptionScenario,
  protocol: string | null = String(DESKTOP_ACCOUNT_POLICY.linkProtocol),
) => {
  const identity = {
    ...brandActorSessionIdentity({
      userId: "user-1",
      organizationId: "organization-1",
    }),
    // Every service owns its persistence; the HTTP handler only threads this
    // capability through, so an accidental database call must fail this test.
    scopedDb: async () =>
      panic("Unexpected database call in redemption fixture"),
  };
  const key = "stella_dr_fixture";
  const keyId = "key-fixture";
  const expiresAt = new Date("2026-10-08T12:00:00.000Z");
  const serviceCalls: string[] = [];
  const grantBodies: unknown[] = [];
  const mintIdentities: unknown[] = [];
  const auditKeyIds: string[] = [];
  const revocations: {
    userId: string;
    organizationId: string;
    keyId: string;
  }[] = [];
  const services = {
    authorizeGrant: async (body) => {
      serviceCalls.push("authorizeGrant");
      grantBodies.push(body);
      return Result.ok(identity);
    },
    authorizeLinkedAccount: async (request) => {
      serviceCalls.push("authorizeLinkedAccount");
      expect(request.headers.get("authorization")).toBe(
        "Bearer stella_dr_existing",
      );
      if (scenario === "invalid-credential") {
        return Result.err(
          new HandlerError({
            status: 401,
            message: "Desktop account is unavailable",
          }),
        );
      }
      const linkedIdentity = brandActorSessionIdentity({
        userId: scenario === "other-user" ? "user-2" : identity.userId,
        organizationId:
          scenario === "other-organization"
            ? "organization-2"
            : identity.organizationId,
      });
      return Result.ok({
        ...linkedIdentity,
        memberRole: sessionMemberRole("member"),
        keyId: "existing-key",
        scopedDb: identity.scopedDb,
      });
    },
    loadAccount: async (loadedIdentity) => {
      serviceCalls.push("loadAccount");
      expect(loadedIdentity.userId).toBe(identity.userId);
      expect(loadedIdentity.organizationId).toBe(identity.organizationId);
      return Result.ok({
        email: "lawyer@example.com",
        name: "Example Lawyer",
        organizationName: "Example Organization",
      });
    },
    mintCredential: async (mintedIdentity) => {
      serviceCalls.push("mintCredential");
      mintIdentities.push(mintedIdentity);
      return scenario === "mint-failure"
        ? Result.err(
            new HandlerError({
              status: 503,
              message: "Could not connect desktop account",
            }),
          )
        : Result.ok({ id: keyId, key, expiresAt });
    },
    auditCredential: async ({
      identity: auditedIdentity,
      keyId: auditedKeyId,
    }) => {
      serviceCalls.push("auditCredential");
      expect(auditedIdentity.userId).toBe(identity.userId);
      expect(auditedIdentity.organizationId).toBe(identity.organizationId);
      auditKeyIds.push(auditedKeyId);
      return scenario === "audit-failure"
        ? Result.err(new DatabaseError({ message: "Audit write failed" }))
        : Result.ok(undefined);
    },
    revokeCredential: async (revokedIdentity, revokedKeyId) => {
      serviceCalls.push("revokeCredential");
      revocations.push({
        userId: revokedIdentity.userId,
        organizationId: revokedIdentity.organizationId,
        keyId: revokedKeyId,
      });
      return Result.ok(undefined);
    },
  } satisfies RedemptionServices;
  const route = createDesktopLinkRedeemHandler(services);
  const app = new Elysia().post("/redeem-link", route.handler, {
    body: route.config.body,
  });
  const body = {
    correlationId: "90123344-5566-7788-9900-aabbccddeeff",
    verifier: "a".repeat(64),
    expectedUserId: identity.userId,
    expectedOrganizationId: identity.organizationId,
  };
  const request = new Request("http://localhost/redeem-link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(protocol === null
        ? {}
        : { [DESKTOP_ACCOUNT_PROTOCOL_HEADER]: protocol }),
      ...([
        "connected",
        "other-user",
        "other-organization",
        "invalid-credential",
      ].includes(scenario) && { authorization: "Bearer stella_dr_existing" }),
    },
    body: JSON.stringify(body),
  });
  return {
    app,
    request,
    body,
    identity,
    key,
    keyId,
    expiresAt,
    serviceCalls,
    grantBodies,
    mintIdentities,
    auditKeyIds,
    revocations,
  };
};

describe("desktop link redemption over HTTP", () => {
  for (const scenario of ["credential", "connected"] as const) {
    for (const protocol of [null, "3", "invalid", "4"] as const) {
      test(`${scenario} redemption requires supported protocol ${String(protocol)}`, async () => {
        const fixture = createRedemptionFixture(scenario, protocol);
        const response = await fixture.app.handle(fixture.request);
        if (protocol === "4") {
          expect(DESKTOP_ACCOUNT_POLICY.linkProtocol).toBe(4);
          expect(response.status).toBe(200);
          expect(fixture.grantBodies).toEqual([fixture.body]);
          if (scenario === "credential") {
            expect(fixture.mintIdentities).toEqual([fixture.identity]);
          } else {
            expect(fixture.serviceCalls).toContain("authorizeLinkedAccount");
            expect(fixture.mintIdentities).toEqual([]);
          }
          return;
        }
        expect(response.status).toBe(426);
        expect(fixture.serviceCalls).toEqual([]);
        expect(fixture.grantBodies).toEqual([]);
        expect(fixture.mintIdentities).toEqual([]);
        expect(fixture.auditKeyIds).toEqual([]);
        expect(fixture.revocations).toEqual([]);
        const payload: unknown = await response.json();
        expect(payload).toMatchObject({
          code: "desktop_update_required",
          message: "Update stella desktop",
          retryable: false,
        });
        expect(payload).not.toHaveProperty("key");
      });
    }
  }

  test("issues an audited account credential with organization display data and no-store", async () => {
    const fixture = createRedemptionFixture("credential");
    const response = await fixture.app.handle(fixture.request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    const payload: unknown = await response.json();
    expect(payload).toMatchObject({
      status: "credential",
      account: { email: "lawyer@example.com", name: "Example Lawyer" },
      organizationName: "Example Organization",
      key: fixture.key,
      expiresAt: fixture.expiresAt.toISOString(),
    });
    expect(fixture.grantBodies).toEqual([fixture.body]);
    expect(fixture.mintIdentities).toEqual([fixture.identity]);
    expect(fixture.auditKeyIds).toEqual([fixture.keyId]);
    expect(fixture.revocations).toEqual([]);
  });

  test("an existing credential for the same identity confirms the link without minting", async () => {
    const fixture = createRedemptionFixture("connected");
    const response = await fixture.app.handle(fixture.request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(await response.json()).toEqual({
      status: "connected",
      identity: {
        userId: fixture.identity.userId,
        organizationId: fixture.identity.organizationId,
      },
    });
    expect(fixture.grantBodies).toEqual([fixture.body]);
    expect(fixture.mintIdentities).toEqual([]);
    expect(fixture.auditKeyIds).toEqual([]);
    expect(fixture.revocations).toEqual([]);
  });

  test("a bearer for another user or organization cannot confirm the granted identity", async () => {
    for (const scenario of ["other-user", "other-organization"] as const) {
      const fixture = createRedemptionFixture(scenario);
      const response = await fixture.app.handle(fixture.request);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
      expect(await response.json()).toEqual({
        message: "Desktop account is unavailable",
      });
      expect(fixture.grantBodies).toEqual([fixture.body]);
      expect(fixture.mintIdentities).toEqual([]);
      expect(fixture.auditKeyIds).toEqual([]);
      expect(fixture.revocations).toEqual([]);
    }
  });

  test("an unavailable linked credential leaves the connection request unclaimed", async () => {
    const fixture = createRedemptionFixture("invalid-credential");
    const response = await fixture.app.handle(fixture.request);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(fixture.grantBodies).toEqual([]);
    expect(fixture.mintIdentities).toEqual([]);
    expect(fixture.auditKeyIds).toEqual([]);
    expect(fixture.revocations).toEqual([]);
  });

  test("an audit failure revokes the issued key before returning a credential-free failure", async () => {
    const fixture = createRedemptionFixture("audit-failure");
    const response = await fixture.app.handle(fixture.request);
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    const payload: unknown = await response.json();
    expect(payload).not.toHaveProperty("key");
    expect(payload).not.toHaveProperty("account");
    expect(JSON.stringify(payload)).not.toContain(fixture.key);
    expect(fixture.auditKeyIds).toEqual([fixture.keyId]);
    expect(fixture.revocations).toEqual([
      {
        userId: fixture.identity.userId,
        organizationId: fixture.identity.organizationId,
        keyId: fixture.keyId,
      },
    ]);
  });

  test("a credential issuer failure returns unavailable without auditing or revoking", async () => {
    const fixture = createRedemptionFixture("mint-failure");
    const response = await fixture.app.handle(fixture.request);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(await response.json()).toEqual({
      message: "Could not connect desktop account",
    });
    expect(fixture.mintIdentities).toEqual([fixture.identity]);
    expect(fixture.auditKeyIds).toEqual([]);
    expect(fixture.revocations).toEqual([]);
  });
});
