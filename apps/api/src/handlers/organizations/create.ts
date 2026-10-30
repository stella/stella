import { Result } from "better-result";

import { ORGANIZATION_CREATE_SCOPE } from "@stll/api-contract/organization-create";

import { organizationCreateBodySchema } from "@/api/handlers/organizations/schema";
import {
  ACCOUNT_ACCESS,
  createSafeSessionHandler,
} from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { createOrganizationForAccount } from "@/api/lib/organizations/create";
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
      reason: "organization_management",
      consumesServices: false,
    },
    description:
      "Create an organization that you will own. Requires stella:organization_create account consent for OAuth callers. Omit slug to derive a unique slug from the name. Explicit slug conflicts return organization_slug_conflict; restricted accounts return account_access_unavailable. Send Idempotency-Key to safely replay a creation. The current organization stays active. Run stella auth login and select the returned organization before acting in it.",
  },
  async function* ({ user, body: { name, slug }, request }) {
    const organization = yield* Result.await(
      createOrganizationForAccount({
        userId: user.id,
        name,
        ...(slug === undefined ? {} : { slug }),
        idempotencyKey: request.headers.get("Idempotency-Key"),
      }),
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
    "Better-auth owns organization and membership creation and runs the lifecycle hooks. Account receipts claim a unique key before creation; audit and completed receipts commit together.",
});

export default createOrganization;
