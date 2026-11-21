import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { reviewSanctionsMatch } from "@/api/lib/lists/sanctions/monitoring-review";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export default createSafeRootHandler(
  {
    contract: "patch",
    realtime: organizationResourceSetUpdates(RESOURCE_TYPE.CONTACT),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    description:
      "Dismiss or confirm one current sanctions match with a reason. Read contacts.sanctions.get first and copy the match's reviewTarget, then supply disposition and reason. A stale reviewTarget is rejected; read the contact again before retrying. A decision remains valid only while the contact fingerprint and listed-entry hash remain unchanged. Repeating the same decision is idempotent; changed evidence reopens it.",
    permissions: { contact: ["update"] },
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
    },
    params: v.object({ contactId: resourceIdSchema("contact") }),
    body: v.object({
      source: v.picklist(sanctionsSourceIds()),
      sourceEntryId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
      disposition: v.picklist(["dismissed", "confirmed"]),
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
      expectedContactFingerprint: v.pipe(
        v.string(),
        v.regex(/^[0-9a-f]{64}$/u),
        v.minLength(64),
        v.maxLength(64),
        v.description(
          "Copy expectedContactFingerprint from the current match reviewTarget",
        ),
      ),
      expectedEntryHash: v.pipe(
        v.string(),
        v.regex(/^[0-9a-f]{64}$/u),
        v.minLength(64),
        v.maxLength(64),
        v.description(
          "Copy expectedEntryHash from the current match reviewTarget",
        ),
      ),
    }),
  },
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await reviewSanctionsMatch(tx, {
            organizationId: session.activeOrganizationId,
            contactId: params.contactId,
            reviewerId: user.id,
            ...body,
            recordAuditEvent,
          }),
      ),
    );
    return result;
  },
);
