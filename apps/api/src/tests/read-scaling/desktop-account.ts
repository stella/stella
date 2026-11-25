import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { desktopDeviceProofReplays } from "@/api/db/schema/desktop-device-proof-replay";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import {
  desktopProofRequestUrl,
  VerifiedDesktopDeviceProof,
} from "@/api/lib/business-registries/desktop/proof";
import { ConsumedDesktopDeviceProof } from "@/api/lib/business-registries/desktop/proof-store";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { createDesktopDeviceSigner } from "@/api/tests/helpers/desktop-device-proof";

type DesktopScalingAccountOptions = {
  db: GatedTestDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  request: Request;
};

/**
 * A linked desktop account for one measured request: the device proof is
 * signed and claimed for real, and only credential verification is supplied
 * to the production endpoint factory. `release` deletes the claimed proof.
 */
export const desktopScalingAccount = async ({
  db,
  organizationId,
  userId,
  request,
}: DesktopScalingAccountOptions) => {
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
  const receipt = (
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
    featureAccessSnapshot: buildFeatureAccessSnapshot({
      organizationId,
      userId,
      identity: { email: `${userId}@example.test`, emailVerified: true },
      enrolments: [{ featureId: "time-billing", organizationId, userId }],
    }),
  };
  return {
    authorizeAccount: async () => await Promise.resolve(Result.ok(account)),
    release: async () => {
      await db
        .delete(desktopDeviceProofReplays)
        .where(eq(desktopDeviceProofReplays.jti, receipt.proof.jti));
    },
  };
};
