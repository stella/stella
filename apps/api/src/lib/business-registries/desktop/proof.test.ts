import { defaultKeyHasher } from "@better-auth/api-key";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { randomBytes } from "node:crypto";

import { sha256Base64Url } from "@stll/sha256/bun";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { env } from "@/api/env";
import renewDesktopAccount from "@/api/handlers/desktop-registry/renew";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
  DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS,
} from "./config";
import { VerifiedDesktopDeviceProof, desktopProofRequestUrl } from "./proof";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const IAT = NOW.getTime() / 1000;
const PROOF_URL = "https://api.example.test/v1/desktop-account/renew";
const CREDENTIAL = `stella_dr_${"1".repeat(128)}`;
const ATH = sha256Base64Url(CREDENTIAL);

const DEFAULT_ACCOUNT_BINDING = {
  type: "account",
  keyId: "fixture-key",
  credential: CREDENTIAL,
} as const;

const fixture = async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const thumbprint = await calculateJwkThumbprint(jwk);
  const sign = async (payload: Record<string, unknown>) =>
    await new SignJWT(payload)
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk })
      .sign(keys.privateKey);
  const verify = async (compact: string) =>
    await VerifiedDesktopDeviceProof.verify({
      request: new Request(`${PROOF_URL}?view=one`, {
        method: "POST",
        headers: { DPoP: compact },
      }),
      expectedUrl: `${PROOF_URL}?view=one#fragment`,
      expectedThumbprint: thumbprint,
      binding: DEFAULT_ACCOUNT_BINDING,
      now: NOW,
    });
  return { jwk, thumbprint, sign, verify };
};

const claims = () => ({
  htm: "POST",
  htu: PROOF_URL,
  iat: IAT,
  jti: Bun.randomUUIDv7(),
  ath: ATH,
});
type ProofResult = Awaited<
  ReturnType<typeof VerifiedDesktopDeviceProof.verify>
>;
const expectRefusal = (result: ProofResult, code = "desktop_proof_invalid") => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toMatchObject({ status: 401, code, retryable: false });
  }
};

describe("desktop account request proofs", () => {
  test("a valid signed account proof is accepted", async () => {
    const { sign, verify, thumbprint } = await fixture();
    const payload = claims();
    const result = await verify(await sign(payload));
    if (result.isErr()) {
      panic(result.error.message);
    }
    expect(result.value).toBeInstanceOf(VerifiedDesktopDeviceProof);
    expect(result.value).toMatchObject({
      thumbprint,
      jti: payload.jti,
      expiresAt: new Date(NOW.getTime() + 61_000),
      binding: {
        type: "account",
        keyId: "fixture-key",
        credentialHash: await defaultKeyHasher(CREDENTIAL),
      },
    });
  });

  test("a missing request proof is refused", async () => {
    const { thumbprint } = await fixture();
    expectRefusal(
      await VerifiedDesktopDeviceProof.verify({
        request: new Request(PROOF_URL, { method: "POST" }),
        expectedUrl: PROOF_URL,
        expectedThumbprint: thumbprint,
        binding: DEFAULT_ACCOUNT_BINDING,
        now: NOW,
      }),
    );
  });
});

const databaseUrl = process.env["DATABASE_URL"];
const postgresEnabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" && Boolean(databaseUrl);

describe.skipIf(!postgresEnabled)(
  "desktop proof refusal persistence (postgres)",
  () => {
    test("an invalid signature is refused without changing account state", async () => {
      if (!databaseUrl) {
        panic("DATABASE_URL required");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const db = openClient().db;
        const device = await fixture();
        const unrelatedKeys = await generateKeyPair("ES256");
        const userId = mintAuthProviderId<"user">();
        const organizationId = mintAuthProviderId<"organization">();
        const keyId = mintAuthProviderIdValue();
        const credential = `${DESKTOP_REGISTRY_KEY_PREFIX}${randomBytes(64).toString("hex")}`;
        const successorKey = `${DESKTOP_REGISTRY_KEY_PREFIX}${randomBytes(64).toString("hex")}`;
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.insert(user).values({
            id: userId,
            name: "Proof fixture",
            email: `${userId}@example.test`,
            emailVerified: true,
          });
          await tx.insert(organization).values({
            id: organizationId,
            name: "Proof fixture",
            slug: organizationId,
            createdAt: now,
          });
          await tx.insert(member).values({
            id: mintAuthProviderIdValue(),
            userId,
            organizationId,
            role: "member",
            createdAt: now,
          });
          await tx.insert(apikey).values({
            id: keyId,
            configId: DESKTOP_REGISTRY_KEY_CONFIG,
            referenceId: userId,
            key: await defaultKeyHasher(credential),
            enabled: true,
            expiresAt: null,
            rateLimitEnabled: true,
            rateLimitTimeWindow: 60_000,
            rateLimitMax: 60,
            requestCount: 0,
            metadata: JSON.stringify({
              purpose: DESKTOP_REGISTRY_KEY_CONFIG,
              organizationId,
              deviceJkt: device.thumbprint,
              inactivityExpiresAt: new Date(
                now.getTime() +
                  (DESKTOP_REGISTRY_KEY_SECONDS -
                    DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS -
                    1) *
                    1000,
              ).toISOString(),
            }),
          });
        });
        try {
          const requestOptions = {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${credential}`,
            },
            body: JSON.stringify({ type: "rotate", successorKey }),
          };
          const request = new Request("http://localhost/renew", requestOptions);
          const expectedUrl = desktopProofRequestUrl(
            request,
            env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
          );
          const payload = {
            ...claims(),
            htu: expectedUrl,
            iat: Math.floor(now.getTime() / 1000),
            ath: sha256Base64Url(credential),
          };
          const valid = await device.sign(payload);
          const invalid = await new SignJWT(payload)
            .setProtectedHeader({
              typ: "dpop+jwt",
              alg: "ES256",
              jwk: device.jwk,
            })
            .sign(unrelatedKeys.privateKey);
          expect(invalid).not.toBe(valid);
          expect(decodeProtectedHeader(invalid)).toEqual(
            decodeProtectedHeader(valid),
          );
          const invalidPayload = decodeJwt(invalid);
          expect(invalidPayload).toEqual(payload);
          const verification = {
            request: new Request("http://localhost/renew", requestOptions),
            expectedUrl,
            expectedThumbprint: device.thumbprint,
            binding: { type: "account", keyId, credential },
            now,
          } as const;
          verification.request.headers.set("DPoP", valid);
          expect(
            (await VerifiedDesktopDeviceProof.verify(verification)).isOk(),
          ).toBe(true);
          verification.request.headers.set("DPoP", invalid);
          expectRefusal(await VerifiedDesktopDeviceProof.verify(verification));
          const credentialColumns = {
            id: apikey.id,
            key: apikey.key,
            enabled: apikey.enabled,
            expiresAt: apikey.expiresAt,
            metadata: apikey.metadata,
          };
          const before = await db
            .select(credentialColumns)
            .from(apikey)
            .where(eq(apikey.referenceId, userId));
          expect(before).toHaveLength(1);
          request.headers.set("DPoP", invalid);
          const app = new Elysia().post(
            "/renew",
            renewDesktopAccount.handler,
            renewDesktopAccount.config,
          );
          const response = await app.handle(request);
          expect(response.status).toBe(401);
          expect(await response.json()).toMatchObject({
            code: "desktop_proof_invalid",
          });
          expect(
            await db
              .select(credentialColumns)
              .from(apikey)
              .where(eq(apikey.referenceId, userId)),
          ).toEqual(before);
          expect(
            await db
              .select({ jti: desktopDeviceProofReplays.jti })
              .from(desktopDeviceProofReplays)
              .where(eq(desktopDeviceProofReplays.jkt, device.thumbprint)),
          ).toEqual([]);
          expect(
            await db
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId)),
          ).toEqual([]);
        } finally {
          await db
            .delete(desktopDeviceProofReplays)
            .where(eq(desktopDeviceProofReplays.jkt, device.thumbprint));
          await db
            .delete(auditLogs)
            .where(eq(auditLogs.organizationId, organizationId));
          await db.delete(apikey).where(eq(apikey.referenceId, userId));
          await db
            .delete(organization)
            .where(eq(organization.id, organizationId));
          await db.delete(user).where(eq(user.id, userId));
        }
      });
    });
  },
);
