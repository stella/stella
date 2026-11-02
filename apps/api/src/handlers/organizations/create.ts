import { Result } from "better-result";

import {
  ORGANIZATION_CREATE_SCOPE,
  ORGANIZATION_EVALUATION_LIMIT,
  ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE,
} from "@stll/api-contract/organization-create";

import { createOrganizationForAccount } from "@/api/db/root";
import { organizationCreateBodySchema } from "@/api/handlers/organizations/schema";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import { createOrganizationInTransaction } from "@/api/lib/auth/create-organization-in-transaction";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const createOrganization = createSafeSessionHandler(
  {
    accountAccess: ACCOUNT_ACCESS.accountControl,
    accountScope: ORGANIZATION_CREATE_SCOPE,
    contract: "patch",
    access: "write",
    idempotency: { type: "replay" },
    body: organizationCreateBodySchema,
    realtime: noResourceSetUpdates(
      "Organization lists refresh after account-level creation.",
    ),
    mcp: {
      type: "capability",
      by: "create_organization",
      confirmation: "required",
      reason: "organization_management",
      consumesServices: false,
    },
    description: `Create an organization that you will own after human approval. Evaluation periods are limited to ${ORGANIZATION_EVALUATION_LIMIT} per account for its lifetime; ${ORGANIZATION_EVALUATION_LIMIT_REACHED_CODE} refuses further trials, including after deletion. Existing paid organizations keep their access. Requires stella:organization_create account consent for OAuth callers. Omit slug to generate an opaque organization address. Explicit slug conflicts return organization_slug_conflict; restricted accounts return account_access_unavailable. Send Idempotency-Key to safely replay a creation. The current organization stays active. Run stella auth login and select the returned organization before acting in it.`,
  },
  async function* ({ user, body: { name, slug }, request }) {
    const organization = yield* Result.await(
      createOrganizationForAccount(
        {
          userId: user.id,
          evaluation: isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE")
            ? "grant"
            : "none",
          name,
          ...(slug === undefined ? {} : { slug }),
          idempotencyKey: request.headers.get("Idempotency-Key"),
        },
        { createOrganization: createOrganizationInTransaction },
      ),
    );
    return Result.ok({
      ...organization,
      nextCall: {
        command: "stella auth login" as const,
        instruction:
          "Run stella auth login and select this organization to act in it.",
      },
    });
  },
);

declareAggregateMutation(createOrganization, {
  type: "independent",
  reason:
    "The owner transaction binds Better Auth and all creation lifecycle writes. Account-locked evaluation grants, organization creation, account audit and replay receipts commit together.",
});

export default createOrganization;
