import { Result } from "better-result";

import { organizationAuditExportView } from "@/api/handlers/organizations/audit-export/view";
import { readLatestOrganizationAuditExport } from "@/api/lib/account-export/store";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  contract: "patch",
  description:
    "Read your latest audit log archive of the active organization, which deleting the organization requires. Owners only.",
  permissions: { organization: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  // Deleting an organization is a signed-in owner's decision in the web app.
  mcp: { type: "internal", reason: "account_lifecycle" },
  access: "read",
} satisfies HandlerConfig;

const latestOrganizationAuditExport = createSafeRootHandler(
  config,
  async function* ({ session, user }) {
    const latest = yield* Result.await(
      readLatestOrganizationAuditExport({
        userId: user.id,
        organizationId: session.activeOrganizationId,
      }),
    );
    return Result.ok({
      latest: latest === null ? null : organizationAuditExportView(latest),
    });
  },
);

export default latestOrganizationAuditExport;
