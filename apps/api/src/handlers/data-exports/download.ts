import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { ownerSyntheticSessionAuthorityReader } from "@/api/db/root";
import { organizationDataExports } from "@/api/db/schema";
import type { DataExportStatus } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { auditedPresignDownload } from "@/api/lib/audited-download";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
  DATA_EXPORT_MANIFEST_FILE_NAME,
  dataExportObjectKey,
} from "@/api/lib/data-export/queue";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { callerDownloadSource } from "@/api/lib/s3-presign";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const DOWNLOAD_FILE = {
  PART: "part",
  MANIFEST: "manifest",
} as const;

const UNAVAILABLE_MESSAGE = {
  queued: "This export is not ready to download yet.",
  running: "This export is not ready to download yet.",
  ready: "This export has expired; start a new export.",
  expired: "This export has expired; start a new export.",
  failed: "This export failed; start a new export.",
} as const satisfies Record<DataExportStatus, string>;

const config = {
  contract: "patch",
  description:
    "Get a download link for one part of a ready data export, or for its " +
    "export manifest (the JSON file listing every part with its size and " +
    "SHA-256). The link is valid for 15 minutes and supports HTTP range " +
    "requests, so an interrupted download can resume; request a new link " +
    "when it lapses. Each link is recorded in the audit log. Refused once " +
    "the export has expired. Organization owners and admins only.",
  permissions: { dataExport: ["read"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  contentDelivery: { type: "audited" },
  mcp: {
    type: "capability",
    reason: "reporting_export",
    consumesServices: false,
  },
  access: "write",
  realtime: noResourceSetUpdates(
    "Signing a download link only records an audit event.",
  ),
  params: v.strictObject({ exportId: resourceIdSchema("dataExport") }),
  body: v.strictObject({
    file: v.union([
      v.strictObject({
        type: v.literal(DOWNLOAD_FILE.PART),
        index: v.pipe(
          v.number(),
          v.integer(),
          v.minValue(1),
          v.description("1-based part number."),
        ),
      }),
      v.strictObject({ type: v.literal(DOWNLOAD_FILE.MANIFEST) }),
    ]),
  }),
} satisfies HandlerConfig;

const downloadDataExport = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, user, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const granted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .select({
            status: organizationDataExports.status,
            attempt: organizationDataExports.attempt,
            parts: organizationDataExports.parts,
            expiresAt: organizationDataExports.expiresAt,
          })
          .from(organizationDataExports)
          .where(
            and(
              eq(organizationDataExports.id, params.exportId),
              eq(organizationDataExports.organizationId, organizationId),
            ),
          )
          .limit(1);
        const row = rows.at(0);
        if (row === undefined) {
          return { type: "not_found" } as const;
        }
        const now = new Date();
        if (row.status !== "ready" || row.expiresAt === null) {
          return { type: "unavailable", status: row.status } as const;
        }
        // A link must live at least one whole second; less is already expired.
        const remainingSeconds = Math.floor(
          (row.expiresAt.getTime() - now.getTime()) / 1000,
        );
        if (remainingSeconds < 1) {
          return { type: "unavailable", status: row.status } as const;
        }
        const requested = body.file;
        // The manifest is written by the attempt that marked the export
        // ready, which is the row's attempt; each part by the attempt its
        // checkpoint records.
        const file =
          requested.type === DOWNLOAD_FILE.MANIFEST
            ? {
                attempt: row.attempt,
                fileName: DATA_EXPORT_MANIFEST_FILE_NAME,
                sizeBytes: null,
                sha256: null,
              }
            : row.parts.find((part) => part.index === requested.index);
        if (file === undefined) {
          return { type: "no_such_part" } as const;
        }
        const expiresInSeconds = Math.min(
          DATA_EXPORT_DOWNLOAD_URL_TTL_SECONDS,
          remainingSeconds,
        );
        // Part names are generated server-side; sanitising is idempotent.
        const fileName = sanitizeFilename(file.fileName);
        const url = await auditedPresignDownload({
          readSessionAuthority: ownerSyntheticSessionAuthorityReader,
          tx,
          recordAuditEvent,
          resourceType: AUDIT_RESOURCE_TYPE.DATA_EXPORT,
          resourceId: params.exportId,
          userId: user.id,
          source: callerDownloadSource(session),
          s3Key: dataExportObjectKey({
            organizationId,
            exportId: params.exportId,
            attempt: file.attempt,
            fileName,
          }),
          expiresInSeconds,
          fileName,
          metadata: { file: body.file },
          organizationId,
          workspaceId: null,
          s3Keyspace: "exports",
        });
        return {
          type: "granted",
          url,
          fileName,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          urlExpiresAt: new Date(
            now.getTime() + expiresInSeconds * 1000,
          ).toISOString(),
        } as const;
      }),
    );
    switch (granted.type) {
      case "not_found":
        return Result.err(
          new HandlerError({ status: 404, message: "Export not found" }),
        );
      case "unavailable":
        return Result.err(
          new HandlerError({
            status: 409,
            message: UNAVAILABLE_MESSAGE[granted.status],
          }),
        );
      case "no_such_part":
        return Result.err(
          new HandlerError({ status: 404, message: "No such part" }),
        );
      case "granted":
        return Result.ok({
          url: granted.url,
          fileName: granted.fileName,
          sizeBytes: granted.sizeBytes,
          sha256: granted.sha256,
          urlExpiresAt: granted.urlExpiresAt,
        });
      default:
        granted satisfies never;
        return panic("Unhandled download grant");
    }
  },
);

declareAggregateMutation(downloadDataExport, {
  type: "independent",
  reason:
    "Creates a temporary download link and records its audit event; it changes no matter or export source rows.",
});

export default downloadDataExport;
