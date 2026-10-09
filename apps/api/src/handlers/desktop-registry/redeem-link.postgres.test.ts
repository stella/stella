import { defaultKeyHasher } from "@better-auth/api-key";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { randomBytes } from "node:crypto";

import {
  DESKTOP_ACCOUNT_POLICY,
  DESKTOP_ACCOUNT_PROTOCOL_HEADER,
} from "@stll/api-contract/desktop-registry";
import { sha256Hex } from "@stll/sha256/bun";

import {
  apikey,
  member,
  organization,
  user,
  verification,
} from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { env } from "@/api/env";
import { createDesktopLinkRedeemHandler } from "@/api/handlers/desktop-registry/redeem-link";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_PREFIX,
  DESKTOP_REGISTRY_KEY_SECONDS,
} from "@/api/lib/business-registries/desktop/config";
import { createDesktopLinkGrant } from "@/api/lib/business-registries/desktop/link-grant-store";
import {
  VerifiedDesktopDeviceProof,
  desktopProofRequestUrl,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";

// Every authorization operation and credential write here uses the production
// handler and its real database owners, including initial grant claims and
// existing account authorization.
const postgresUrl = process.env["DATABASE_URL"];
describe.skipIf(
  process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true" || !postgresUrl,
)("desktop link proof authorization boundary (postgres)", () => {
  for (const link of ["initial", "existing-account"] as const) {
    for (const proofState of [
      "missing",
      "wrong-device",
      "wrong-endpoint",
      "replayed",
      "valid",
    ] as const) {
      test(`${link} link ${proofState} proof is authorized before grant claim`, async () => {
        if (!postgresUrl) {
          panic("DATABASE_URL required");
        }
        await withGatedTestClients(postgresUrl, async ({ openClient }) => {
          const db = openClient().db;
          const device = await createDesktopDeviceSigner();
          const otherDevice = await createDesktopDeviceSigner();
          const userId = mintAuthProviderId<"user">();
          const organizationId = mintAuthProviderId<"organization">();
          const correlationId = Bun.randomUUIDv7();
          const verifier = "a".repeat(64);
          const credential = `${DESKTOP_REGISTRY_KEY_PREFIX}${randomBytes(64).toString("hex")}`;
          const keyId = mintAuthProviderIdValue();
          await db.transaction(async (tx) => {
            await tx.insert(user).values({
              id: userId,
              name: "Proof boundary fixture",
              email: `${userId}@example.test`,
              emailVerified: true,
            });
            await tx.insert(organization).values({
              id: organizationId,
              name: "Proof boundary fixture",
              slug: organizationId,
              createdAt: new Date(),
            });
            await tx.insert(member).values({
              id: mintAuthProviderIdValue(),
              userId,
              organizationId,
              role: "member",
              createdAt: new Date(),
            });
            if (link === "existing-account") {
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
                  deviceJkt: device.deviceJkt,
                  inactivityExpiresAt: new Date(
                    Date.now() + DESKTOP_REGISTRY_KEY_SECONDS * 1000,
                  ).toISOString(),
                }),
              });
            }
          });
          try {
            const issued = await createDesktopLinkGrant({
              db,
              correlationId,
              verifierHash: sha256Hex(verifier),
              deviceJkt: device.deviceJkt,
              userId,
              organizationId,
            });
            expect(issued.isOk()).toBe(true);
            const body = {
              correlationId,
              verifier,
              deviceJkt: device.deviceJkt,
              expectedUserId: userId,
              expectedOrganizationId: organizationId,
            };
            const route = createDesktopLinkRedeemHandler();
            const app = new Elysia().post("/redeem-link", route.handler, {
              body: route.config.body,
            });
            const unsigned = new Request("http://localhost/redeem-link", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                [DESKTOP_ACCOUNT_PROTOCOL_HEADER]: String(
                  DESKTOP_ACCOUNT_POLICY.linkProtocol,
                ),
                ...(link === "existing-account"
                  ? { authorization: `Bearer ${credential}` }
                  : {}),
              },
              body: JSON.stringify(body),
            });
            const signer = proofState === "wrong-device" ? otherDevice : device;
            const signed = await signer.signRequest({
              request:
                proofState === "wrong-endpoint"
                  ? new Request(
                      "http://localhost/another-endpoint",
                      unsigned.clone(),
                    )
                  : unsigned.clone(),
              nonce: correlationId,
              ...(link === "existing-account" ? { credential } : {}),
            });
            const request = unsigned.clone();
            if (proofState !== "missing") {
              request.headers.set(
                "DPoP",
                signed.headers.get("DPoP") ?? panic("Proof header required"),
              );
            }
            if (proofState === "replayed") {
              const verified = await VerifiedDesktopDeviceProof.verify({
                request,
                expectedUrl: desktopProofRequestUrl(
                  request,
                  env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
                ),
                expectedThumbprint: device.deviceJkt,
                binding:
                  link === "existing-account"
                    ? { type: "account", keyId, credential }
                    : { type: "link", nonce: correlationId },
              });
              if (verified.isErr()) {
                panic(verified.error.message);
              }
              const receipt = await ConsumedDesktopDeviceProof.claim({
                proof: verified.value,
                db,
              });
              expect(receipt.isOk()).toBe(true);
            }
            const response = await app.handle(request);
            const payload: unknown = await response.json();
            expect(response.status).toBe(proofState === "valid" ? 200 : 401);
            const grant = await db
              .select({ id: verification.id })
              .from(verification)
              .where(eq(verification.id, `desktop-link:${correlationId}`));
            const keys = await db
              .select({ id: apikey.id })
              .from(apikey)
              .where(eq(apikey.referenceId, userId));
            const audit = await db
              .select({ id: auditLogs.id })
              .from(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId));
            if (proofState === "valid") {
              expect(payload).toMatchObject({
                status:
                  link === "existing-account" ? "connected" : "credential",
              });
              expect(grant).toEqual([]);
              expect(keys).toHaveLength(1);
              expect(audit).toHaveLength(link === "existing-account" ? 0 : 1);
            } else {
              const expectedCode = {
                missing: "desktop_proof_invalid",
                "wrong-device": "desktop_device_mismatch",
                "wrong-endpoint": "desktop_proof_invalid",
                replayed: "desktop_proof_replayed",
              } as const satisfies Record<typeof proofState, string>;
              expect(payload).toMatchObject({ code: expectedCode[proofState] });
              expect(grant).toHaveLength(1);
              expect(keys).toHaveLength(link === "existing-account" ? 1 : 0);
              expect(audit).toEqual([]);
            }
          } finally {
            await db
              .delete(verification)
              .where(eq(verification.id, `desktop-link:${correlationId}`));
            await db
              .delete(desktopDeviceProofReplays)
              .where(eq(desktopDeviceProofReplays.jkt, device.deviceJkt));
            await db
              .delete(desktopDeviceProofReplays)
              .where(eq(desktopDeviceProofReplays.jkt, otherDevice.deviceJkt));
            await db
              .delete(auditLogs)
              .where(eq(auditLogs.organizationId, organizationId));
            await db.delete(apikey).where(eq(apikey.referenceId, userId));
            await db.delete(member).where(eq(member.userId, userId));
            await db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await db.delete(user).where(eq(user.id, userId));
          }
        });
      });
    }
  }
});
