import { Result } from "better-result";
import * as v from "valibot";

import {
  DATA_EXPORT_START_OUTCOME,
  startDataExport,
} from "@/api/handlers/data-exports/start-export";
import { toDataExportSummary } from "@/api/handlers/data-exports/summary";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { enqueueDataExport } from "@/api/lib/data-export/queue";
import { DATA_EXPORT_VERSION_SCOPE_VALUES } from "@/api/lib/data-export/version-scope";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const dataExportEnqueueFailed = failureSink({
  event: "data_export.enqueue",
  expected: [],
});

const config = {
  contract: "patch",
  description:
    "Start a full export of the organization's data: every matter with its " +
    "documents and their complete version history, tasks, time entries, " +
    "invoices and linked contacts, plus organization-wide contacts, clauses " +
    "and templates, as ZIP parts of about 2 GB with a manifest listing every " +
    "file and its SHA-256 checksum. The export runs as low-priority " +
    "background work, so it can take a while for large organizations; poll " +
    "data-exports.get for progress and an estimated time left, then use " +
    "data-exports.download for links. " +
    "One export runs per organization at a time: while one is queued or " +
    "running, this returns that export instead of starting another. " +
    "Download links are available for 7 days from the start of the export. " +
    "Personal matters are not included. Organization owners and admins " +
    "only.",
  permissions: { dataExport: ["create"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "write",
  realtime: noResourceSetUpdates(
    "Exports are not a live resource set: clients follow an export by polling data-exports.get.",
  ),
  body: v.strictObject({
    versions: v.pipe(
      v.picklist(DATA_EXPORT_VERSION_SCOPE_VALUES),
      v.description(
        "`all` includes every earlier version of every document; `current` only each document's current version.",
      ),
    ),
  }),
} satisfies HandlerConfig;

const createDataExport = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const started = yield* Result.await(
      safeDb(
        async (tx) =>
          await startDataExport({
            tx,
            organizationId,
            userId: user.id,
            versions: body.versions,
            recordAuditEvent,
          }),
      ),
    );
    if (started.row === null) {
      // The active export finished between the insert and the read.
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Another export just finished; start a new one.",
        }),
      );
    }
    if (started.outcome === DATA_EXPORT_START_OUTCOME.STARTED) {
      const exportId = started.row.id;
      // A failed handoff leaves the row queued; the maintenance sweep hands
      // it to the queue again, so the request still succeeds.
      await enqueueDataExport({
        exportId,
        organizationId,
        userId: user.id,
        attempt: 0,
      }).catch((error: unknown) => {
        observeFailure(error, {
          sink: dataExportEnqueueFailed,
          ctx: { entityId: exportId, operation: "data_export.enqueue" },
        });
      });
    }
    return Result.ok({
      outcome: started.outcome,
      export: toDataExportSummary(started.row),
    });
  },
);

declareAggregateMutation(createDataExport, {
  type: "independent",
  reason:
    "Creates an organization export job and audit event; it changes no matter or domain aggregate rows.",
});

export default createDataExport;
