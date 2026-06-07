import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createHostedSetupSession } from "@/api/lib/hosted-usage-provider/client";
import { getApiCredentials } from "@/api/lib/hosted-usage-provider/config";

/** Create a hosted setup session for an active usage policy. */

const createHostedSetupBodySchema = t.Object({
  usagePolicyId: tSafeId("usagePolicy"),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: createHostedSetupBodySchema,
} satisfies HandlerConfig;

const hostedExternalAccountRef = (
  organizationId: SafeId<"organization">,
): string => `stella_org_${organizationId}`;

const createHostedSetup = createSafeRootHandler(
  config,
  async function* ({ body, session, safeDb, user }) {
    const credentials = getApiCredentials();
    if (!credentials) {
      return Result.err(
        new HandlerError({
          status: 502,
          message:
            "Hosted usage management is not configured on this deployment",
        }),
      );
    }

    const dbResult = yield* Result.await(
      safeDb(async (tx) => {
        const policyRows = await tx
          .select({
            id: usagePolicies.id,
            active: usagePolicies.active,
            hostedPolicyRef: usagePolicies.hostedPolicyRef,
          })
          .from(usagePolicies)
          .where(eq(usagePolicies.id, body.usagePolicyId))
          .limit(1);
        const policy = policyRows.at(0);
        if (!policy) {
          return { kind: "policy_not_found" as const };
        }
        if (!policy.active || !policy.hostedPolicyRef) {
          return { kind: "policy_not_hosted" as const };
        }

        const entitlementRows = await tx
          .select({
            source: usageEntitlements.source,
            hostedAccountRef: usageEntitlements.hostedAccountRef,
          })
          .from(usageEntitlements)
          .where(
            and(
              eq(
                usageEntitlements.organizationId,
                session.activeOrganizationId,
              ),
            ),
          )
          .limit(1);
        const entitlement = entitlementRows.at(0);
        if (entitlement && entitlement.source === "manual") {
          return { kind: "manual_entitlement_present" as const };
        }

        return {
          kind: "ok" as const,
          policyRef: policy.hostedPolicyRef,
          accountRef: entitlement?.hostedAccountRef ?? null,
        };
      }),
    );

    if (dbResult.kind === "policy_not_found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Usage policy not found" }),
      );
    }
    if (dbResult.kind === "policy_not_hosted") {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Usage policy is not available through hosted self-service",
        }),
      );
    }
    if (dbResult.kind === "manual_entitlement_present") {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "This organisation has a manually managed usage entitlement. Contact an operator to switch management.",
        }),
      );
    }

    const baseUrl = env.FRONTEND_URL.endsWith("/")
      ? env.FRONTEND_URL.slice(0, -1)
      : env.FRONTEND_URL;
    // Build the post-setup destination server-side: accepting a
    // client-supplied success URL would turn the trusted hosted-setup
    // flow into an open redirect toward an arbitrary origin.
    const usageSettingsUrl = `${baseUrl}/settings/organization/usage`;
    const externalAccountRef = dbResult.accountRef
      ? undefined
      : hostedExternalAccountRef(session.activeOrganizationId);

    const sessionResult = await createHostedSetupSession({
      credentials,
      policyRef: dbResult.policyRef,
      accountRef: dbResult.accountRef ?? undefined,
      externalAccountRef,
      returnUrl: usageSettingsUrl,
      successUrl: usageSettingsUrl,
      metadata: {
        organization_id: session.activeOrganizationId,
        usage_policy_id: body.usagePolicyId,
        // seat_user_id identifies the seat that initiated hosted setup.
        // Useful for add-on allocations; harmless for entitlement setup.
        seat_user_id: user.id,
      },
    });
    if (Result.isError(sessionResult)) {
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not create hosted usage setup session",
          cause: sessionResult.error,
        }),
      );
    }

    return Result.ok({
      hostedSessionId: sessionResult.value.id,
      url: sessionResult.value.url,
    });
  },
);

export default createHostedSetup;
