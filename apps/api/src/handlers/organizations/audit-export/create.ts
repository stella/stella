import { Result } from "better-result";

import { organizationAuditExportView } from "@/api/handlers/organizations/audit-export/view";
import { enqueueAccountExport } from "@/api/lib/account-export/enqueue";
import { requestOrganizationAuditExport } from "@/api/lib/account-export/store";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { requireRequestExceptionScope } from "@/api/lib/observability/request-context";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const ORGANIZATION_AUDIT_EXPORT_ENQUEUE_FAILED = failureSink({
  event: "organization_audit_export.enqueue_failed",
  expected: [],
});

const config = {
  contract: "patch",
  description:
    "Request an archive of the active organization's whole audit log for yourself, which deleting the organization requires. An archive still building, or ready and holding every entry, is returned as it is. Owners only.",
  permissions: { organization: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  realtime: noResourceSetUpdates(
    "Account-scoped export state refreshes through the caller-owned query",
  ),
  // Deleting an organization is a signed-in owner's decision in the web app.
  mcp: { type: "internal", reason: "account_lifecycle" },
} satisfies HandlerConfig;

const requestOrganizationAuditArchive = createSafeRootHandler(
  config,
  async function* ({ session, user, request }) {
    if (session.credentialType === "agent_run") {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "agent_run_refused",
          message:
            "Export the organization's audit log with an owner credential outside an agent run.",
        }),
      );
    }
    const organizationId = session.activeOrganizationId;
    const row = yield* Result.await(
      requestOrganizationAuditExport({ userId: user.id, organizationId }),
    );
    // Queue transport is reconstructible from the committed ledger. A failed
    // enqueue must not turn an accepted request into an ambiguous refusal.
    const queued = await Result.tryPromise(
      async () => await enqueueAccountExport(row.id),
    );
    if (Result.isError(queued)) {
      observeFailure(queued.error, {
        sink: ORGANIZATION_AUDIT_EXPORT_ENQUEUE_FAILED,
        scope: requireRequestExceptionScope(request),
        ctx: { jobId: row.id },
        request,
      });
    }
    // A request returns an archive that is building or holds every entry.
    return Result.ok(
      organizationAuditExportView({ row, coversCurrentTrail: true }),
    );
  },
);

declareAggregateMutation(requestOrganizationAuditArchive, {
  type: "independent",
  reason:
    "The export store serializes the request under the account and export aggregate locks in one audited transaction.",
});

export default requestOrganizationAuditArchive;
