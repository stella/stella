import { Result } from "better-result";
import { t } from "elysia";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  disableSanctionsMonitoring,
  enableSanctionsMonitoring,
} from "@/api/lib/lists/sanctions/monitoring-opt-out";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export default createSafeRootHandler(
  {
    realtime: organizationResourceSetUpdates(RESOURCE_TYPE.CONTACT),
    accountAccess: ACCOUNT_ACCESS.accountControl,
    description:
      "Enable or disable sanctions monitoring for the active organization. Disabling hides active hits and preserves history. Enabling queues a bounded backfill; contact opt-outs still apply. Read contacts.sanctions.get for eventual screening results. Changes are audited.",
    permissions: { organizationSettings: ["update"] },
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
    },
    body: t.Object({ mode: t.UnionEnum(["enabled", "disabled"]) }),
  },
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await (
            body.mode === "enabled"
              ? enableSanctionsMonitoring
              : disableSanctionsMonitoring
          )(tx, {
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          }),
      ),
    );
    return Result.ok(result);
  },
);
