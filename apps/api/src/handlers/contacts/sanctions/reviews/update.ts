import { Result } from "better-result";
import { t } from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { reviewSanctionsMatch } from "@/api/lib/lists/sanctions/monitoring-review";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export default createSafeRootHandler(
  {
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
    params: t.Object({ contactId: tSafeId("contact") }),
    body: t.Object({
      source: t.UnionEnum(sanctionsSourceIds()),
      sourceEntryId: t.String({ minLength: 1, maxLength: 512 }),
      disposition: t.UnionEnum(["dismissed", "confirmed"]),
      reason: t.String({ minLength: 1, maxLength: 2000 }),
      expectedContactFingerprint: t.String({
        pattern: "^[0-9a-f]{64}$",
        minLength: 64,
        maxLength: 64,
        description:
          "Copy expectedContactFingerprint from the current match reviewTarget",
      }),
      expectedEntryHash: t.String({
        pattern: "^[0-9a-f]{64}$",
        minLength: 64,
        maxLength: 64,
        description:
          "Copy expectedEntryHash from the current match reviewTarget",
      }),
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
