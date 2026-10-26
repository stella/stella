import { Result } from "better-result";
import * as v from "valibot";

import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { loadBillingGuidelines } from "@/api/lib/billing/billing-guidelines";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const permissions = {
  organizationSettings: ["update"],
} satisfies HandlerConfig["permissions"];
const clientQuerySchema = v.object({
  clientId: v.optional(resourceIdSchema("contact")),
});

const config = {
  contract: "patch",
  description:
    "Read the organization's AI billing draft mode and guideline files, plus " +
    "a client's billing format when clientId is supplied. Pass updatedAt " +
    "unchanged as expectedUpdatedAt to organization-settings.billing-drafts.update.",
  permissions,
  accountAccess: ACCOUNT_ACCESS.accountControl,
  access: "read",
  mcp: {
    type: "capability",
    reason: "billing_admin",
    readClass: "tenant",
    consumesServices: false,
  },
  query: clientQuerySchema,
} satisfies HandlerConfig;

const readBillingDraftConfiguration = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query }) {
    const organizationId = session.activeOrganizationId;
    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: organizationId } },
          columns: { aiBillingDraftsMode: true, updatedAt: true },
        }),
      ),
    );
    const files = yield* Result.await(
      loadBillingGuidelines({
        safeDb,
        organizationId,
        clientIds: query.clientId ? [query.clientId] : [],
      }),
    );
    const client = query.clientId
      ? yield* Result.await(
          safeDb((tx) =>
            tx.query.contacts.findFirst({
              where: {
                id: { eq: query.clientId },
                organizationId: { eq: organizationId },
              },
              columns: { timeBillingFormat: true },
            }),
          ),
        )
      : undefined;
    if (query.clientId !== undefined && client === undefined) {
      return Result.err(
        new HandlerError({ status: 404, message: "Client not found" }),
      );
    }
    return Result.ok({
      mode: settings?.aiBillingDraftsMode ?? "disabled",
      updatedAt: (settings?.updatedAt ?? new Date(0)).toISOString(),
      files,
      timeBillingFormat: client?.timeBillingFormat ?? "categories",
    });
  },
);

export default readBillingDraftConfiguration;
