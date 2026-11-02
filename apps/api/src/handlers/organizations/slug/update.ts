import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import {
  createOpaqueOrganizationSlug,
  ORGANIZATION_SLUG_RULES,
} from "@stll/auth-model";

import { changeOrganizationSlug } from "@/api/db/root";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getAuth } from "@/api/lib/auth";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { consumeOrganizationSlugRateLimit } from "@/api/lib/rate-limit/organization-slug";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.ORGANIZATION),
  description:
    "Change the active organization's slug. Owners and admins may choose a lowercase slug or generate an opaque org- identifier. The old slug has no alias. A taken slug returns organization_slug_conflict; choose another or use type opaque.",
  permissions: { organization: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: {
    type: "capability",
    reason: "organization_admin",
    consumesServices: false,
  },
  body: v.variant("type", [
    v.strictObject({
      type: v.literal("explicit"),
      slug: v.pipe(
        v.string(),
        v.minLength(ORGANIZATION_SLUG_RULES.minLength),
        v.maxLength(ORGANIZATION_SLUG_RULES.maxLength),
        v.regex(ORGANIZATION_SLUG_RULES.pattern),
      ),
    }),
    v.strictObject({ type: v.literal("opaque") }),
  ]),
} satisfies HandlerConfig;

const updateOrganizationSlug = createSafeRootHandler(
  config,
  async function* ({ body, session, user, memberRole, recordAuditEvent }) {
    if (session.credentialType === "agent_run") {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "agent_run_refused",
          message:
            "Change the organization slug with an owner or admin credential outside an agent run.",
        }),
      );
    }
    if (
      !(await consumeOrganizationSlugRateLimit(session.activeOrganizationId))
    ) {
      return Result.err(
        new HandlerError({
          status: 429,
          code: "rate_limited",
          message: "Too many organization slug changes. Retry in one minute.",
        }),
      );
    }
    const updated = yield* Result.await(
      changeOrganizationSlug({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        memberRole,
        slug:
          body.type === "opaque" ? createOpaqueOrganizationSlug() : body.slug,
        recordAuditEvent,
        auth: getAuth(),
      }),
    );
    return Result.ok(updated);
  },
);

declareAggregateMutation(updateOrganizationSlug, {
  type: "aggregate",
  aggregates: ["organization"],
});

export default updateOrganizationSlug;
