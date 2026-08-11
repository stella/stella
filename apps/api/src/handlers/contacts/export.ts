import { Result } from "better-result";
import { asc, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  CONTACT_IMPORT_FIELDS,
  CONTACT_IMPORT_SCHEMA_VERSION,
} from "@stll/api-contract";

import { contacts } from "@/api/db/schema";
import { contactToPortableImport } from "@/api/handlers/contacts/contact-import-export";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
} from "@/api/lib/audit-log";
import { escapeCSV } from "@/api/lib/csv";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { secureDocumentResponse } from "@/api/lib/secure-document-response";

const exportQuerySchema = t.Object({
  format: t.Optional(t.Union([t.Literal("csv"), t.Literal("json")])),
});

const CONTACT_EXPORT_BYTE_LIMIT = 25 * 1024 * 1024;

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "contact_directory" },
  access: "read",
  query: exportQuerySchema,
} satisfies HandlerConfig;

type ContactExportFormat = "csv" | "json";

const serializeContactExport = (
  portable: ReturnType<typeof contactToPortableImport>[],
  format: ContactExportFormat,
) => {
  if (format === "json") {
    return {
      body: JSON.stringify({
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        contacts: portable,
      }),
      contentType: "application/json",
      fileName: "contacts-export.json",
    };
  }

  const csvRows = [CONTACT_IMPORT_FIELDS.join(",")];
  for (const contact of portable) {
    csvRows.push(
      CONTACT_IMPORT_FIELDS.map((field) => escapeCSV(contact[field])).join(","),
    );
  }
  return {
    body: csvRows.join("\n"),
    contentType: "text/csv; charset=utf-8",
    fileName: "contacts-export.csv",
  };
};

const exportContacts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, query, recordAuditEvent }) {
    const format = query.format ?? "csv";
    const exportResult = yield* Result.await(
      safeDb(async (tx) => {
        const contactsToExport = await tx
          .select({
            type: contacts.type,
            displayName: contacts.displayName,
            prefix: contacts.prefix,
            firstName: contacts.firstName,
            middleName: contacts.middleName,
            lastName: contacts.lastName,
            suffix: contacts.suffix,
            organizationName: contacts.organizationName,
            emails: contacts.emails,
            phones: contacts.phones,
            addresses: contacts.addresses,
            notes: contacts.notes,
            tags: contacts.tags,
            registrationNumber: contacts.registrationNumber,
            taxId: contacts.taxId,
          })
          .from(contacts)
          .where(eq(contacts.organizationId, session.activeOrganizationId))
          .orderBy(asc(contacts.displayName), asc(contacts.id))
          .limit(LIMITS.contactsCount + 1);
        if (contactsToExport.length > LIMITS.contactsCount) {
          return { status: "too-many" as const };
        }
        const document = serializeContactExport(
          contactsToExport.map(contactToPortableImport),
          format,
        );
        if (
          Buffer.byteLength(document.body, "utf-8") > CONTACT_EXPORT_BYTE_LIMIT
        ) {
          return { status: "too-large" as const };
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DOWNLOAD,
          resourceType: AUDIT_RESOURCE_TYPE.CONTACT_DIRECTORY,
          resourceId: CONTACT_DIRECTORY_AUDIT_RESOURCE_ID,
        });
        return { status: "ready" as const, document };
      }),
    );
    if (exportResult.status === "too-large") {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Contact export exceeds the download size limit",
        }),
      );
    }
    if (exportResult.status === "too-many") {
      return Result.err(
        new HandlerError({
          status: 413,
          message: "Contact export exceeds the row limit",
        }),
      );
    }

    return Result.ok(
      secureDocumentResponse({
        body: exportResult.document.body,
        contentType: exportResult.document.contentType,
        disposition: "attachment",
        fileName: sanitizeFilename(exportResult.document.fileName),
      }),
    );
  },
);

export default exportContacts;
