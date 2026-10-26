import { panic, Result } from "better-result";
import { expect } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  billingDraftUserSettings,
  featureEnrolments,
  organizationSettings,
} from "@/api/db/schema";
import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import { createDesktopBillingDraftSettingsReadEndpoint } from "@/api/handlers/desktop-time-entries/billing-draft-settings";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import {
  desktopProofRequestUrl,
  VerifiedDesktopDeviceProof,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

/** Only credentials use the endpoint's collaborator; policy and SQL stay real. */
export const measureDesktopBillingDraftSettings = async (
  fixture: ReadFixture,
) => {
  const { db, organizationId, userId, size } = fixture;
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const unrelatedUsers = Array.from({ length: size }, () =>
    mintAuthProviderId<"user">(),
  );
  const request = new Request(
    "https://api.example.test/v1/desktop/billing-drafts/settings",
  );
  let receipt: ConsumedDesktopDeviceProof | undefined;
  try {
    await db.insert(organization).values({
      id: otherOrganizationId,
      name: "Other scaling organization",
      slug: otherOrganizationId,
      createdAt: new Date(),
    });
    await db.insert(user).values(
      unrelatedUsers.map((id) => ({
        id,
        name: "Unrelated settings owner",
        email: `${id}@example.test`,
        emailVerified: true,
      })),
    );
    await db.insert(member).values(
      [userId, ...unrelatedUsers].map((id) => ({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId: id,
        role: "member",
        createdAt: new Date(),
      })),
    );
    await db.insert(featureEnrolments).values(
      [userId, ...unrelatedUsers].map((id) => ({
        organizationId,
        userId: id,
        featureId: "time-billing" as const,
      })),
    );
    // Insert decoys first so dropping either ownership predicate cannot pass
    // merely because LIMIT 1 happens to find the intended record first.
    await db.insert(organizationSettings).values([
      {
        id: createSafeId<"organizationSettings">(),
        organizationId: otherOrganizationId,
        aiBillingDraftsMode: "disabled",
      },
      {
        id: createSafeId<"organizationSettings">(),
        organizationId,
        aiBillingDraftsMode: "enabled",
      },
    ]);
    await db.insert(billingDraftUserSettings).values([
      ...unrelatedUsers.map((id) => ({
        organizationId,
        userId: id,
        preference: "Unrelated member preference",
        consentAt: null,
      })),
      {
        organizationId: otherOrganizationId,
        userId,
        preference: "Other organization preference",
        consentAt: null,
      },
      {
        organizationId,
        userId,
        preference: "Keep the target narrative concise",
        consentAt: new Date("2026-10-01T12:00:00.000Z"),
      },
    ]);
    await db.execute(sql`GRANT SELECT ON TABLE
      pg_temp."user", pg_temp."member", pg_temp."feature_enrolments",
      pg_temp."organization_settings", pg_temp."billing_draft_user_settings"
      TO stella`);

    const signer = await createDesktopDeviceSigner();
    const credential = "scaling-credential";
    const signed = await signer.signRequest({ request, credential });
    const verified = (
      await VerifiedDesktopDeviceProof.verify({
        request: signed,
        expectedUrl: desktopProofRequestUrl(
          signed,
          env.PUBLIC_URL ?? env.BETTER_AUTH_URL,
        ),
        expectedThumbprint: signer.deviceJkt,
        binding: { type: "account", keyId: "scaling-key", credential },
      })
    ).unwrap();
    receipt = (
      await ConsumedDesktopDeviceProof.claim({ proof: verified, db })
    ).unwrap();
    const account = {
      organizationId,
      userId,
      keyId: "scaling-key",
      consumedProof: receipt,
      memberRole: sessionMemberRole("member"),
      scopedDb: createMembershipScopedDb(markRlsDatabase(db), {
        organizationId,
        userId,
        serverValidatedWorkspaceIds: [],
      }),
    };
    // The registry retains the canonical mounted definition. Its measurement
    // uses this same production factory with only credential verification supplied.
    const endpoint = createDesktopBillingDraftSettingsReadEndpoint(
      async () => await Promise.resolve(Result.ok(account)),
    );
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        asTestRaw<Parameters<typeof endpoint.handler>[0]>({
          request,
          route: "/v1/desktop/billing-drafts/settings" satisfies ApiRoutePath,
        }),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("Desktop settings scaling requires a successful response");
      }
      expect(response).toEqual({
        organizationMode: "enabled",
        consent: "granted",
        preference: "Keep the target narrative concise",
      });
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: 1,
      };
    });
  } finally {
    if (receipt !== undefined) {
      await db
        .delete(desktopDeviceProofReplays)
        .where(eq(desktopDeviceProofReplays.jti, receipt.proof.jti));
    }
    await db
      .delete(billingDraftUserSettings)
      .where(
        inArray(billingDraftUserSettings.organizationId, [
          organizationId,
          otherOrganizationId,
        ]),
      );
    await db
      .delete(organizationSettings)
      .where(
        inArray(organizationSettings.organizationId, [
          organizationId,
          otherOrganizationId,
        ]),
      );
    await db
      .delete(featureEnrolments)
      .where(eq(featureEnrolments.organizationId, organizationId));
    await db.delete(member).where(eq(member.organizationId, organizationId));
    await db.delete(user).where(inArray(user.id, unrelatedUsers));
    await db
      .delete(organization)
      .where(eq(organization.id, otherOrganizationId));
  }
};
