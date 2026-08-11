import { Result } from "better-result";
import { t } from "elysia";

import { CONTACT_IMPORT_SCHEMA_VERSION } from "@stll/api-contract";

import { contactImportRequests, contacts } from "@/api/db/schema";
import {
  hasContactCapacity,
  lockContactCapacity,
} from "@/api/handlers/contacts/contact-capacity";
import {
  parseContactImportDocument,
  parseContactImportMappingText,
  previewContactImport,
} from "@/api/handlers/contacts/contact-import-file";
import { insertContactSearchProjections } from "@/api/handlers/contacts/contact-search-projection";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditEvent } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";

const importBodySchema = t.Object({
  file: t.File({ maxSize: FILE_SIZE_LIMITS.dataImport }),
  importRequestId: tSafeId("contactImportRequest"),
  mapping: t.String(),
});

const fingerprintImport = (contactsToImport: readonly unknown[]): string =>
  new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        version: CONTACT_IMPORT_SCHEMA_VERSION,
        contacts: contactsToImport,
      }),
    )
    .digest("hex");

const config = {
  permissions: { contact: ["create"] },
  mcp: { type: "internal", reason: "upload_mechanics" },
  body: importBodySchema,
} satisfies HandlerConfig;

const importContacts = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    body: { file, importRequestId, mapping: mappingText },
    recordAuditEvent,
  }) {
    const text = await file.text();
    const document = yield* parseContactImportDocument(text);
    const mapping = yield* parseContactImportMappingText(mappingText);
    const preview = yield* previewContactImport({ document, mapping });

    if (preview.rows.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "No contacts to import" }),
      );
    }
    if (preview.errorCount > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Contact import contains invalid rows",
        }),
      );
    }

    const candidates = preview.rows.map(({ contact }) => contact);
    const requestFingerprint = fingerprintImport(candidates);
    const result = yield* Result.await(
      safeDb(async (tx) => {
        await lockContactCapacity(tx, session.activeOrganizationId);

        const existing = await tx.query.contactImportRequests.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
            userId: { eq: user.id },
            idempotencyKey: { eq: importRequestId },
          },
        });
        if (existing) {
          if (existing.requestFingerprint !== requestFingerprint) {
            return { status: "conflict" as const };
          }
          return {
            status: "replayed" as const,
            result: existing.result,
          };
        }

        const hasCapacity = await hasContactCapacity({
          tx,
          organizationId: session.activeOrganizationId,
          incomingCount: candidates.length,
          capacityLocked: true,
        });
        if (!hasCapacity) {
          return { status: "limit-reached" as const };
        }

        const values = candidates.map(
          ({
            type,
            displayName,
            prefix,
            firstName,
            middleName,
            lastName,
            suffix,
            organizationName,
            notes,
            emails,
            phones,
            addresses,
            tags,
            registrationNumber,
            taxId,
          }) => ({
            id: createSafeId<"contact">(),
            organizationId: session.activeOrganizationId,
            createdBy: user.id,
            type,
            displayName,
            prefix,
            firstName,
            middleName,
            lastName,
            suffix,
            organizationName,
            notes,
            emails,
            phones,
            addresses,
            tags,
            registrationNumber,
            taxId,
          }),
        );
        const created = await tx.insert(contacts).values(values).returning();
        const auditEvents = created.map((contact): AuditEvent => ({
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
          resourceId: contact.id,
          workspaceId: null,
          changes: {
            created: {
              old: null,
              new: {
                type: contact.type,
                displayName: contact.displayName,
              },
            },
          },
          metadata: { source: "import", importRequestId },
        }));
        await recordAuditEvent(tx, auditEvents);
        await insertContactSearchProjections(tx, created);

        const importResult = {
          created: created.length,
        };
        await tx.insert(contactImportRequests).values({
          id: createSafeId<"contactImportRequest">(),
          organizationId: session.activeOrganizationId,
          userId: user.id,
          idempotencyKey: importRequestId,
          requestFingerprint,
          result: importResult,
        });

        return { status: "created" as const, result: importResult };
      }),
    );

    if (result.status === "conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Import request was already used for different contacts",
        }),
      );
    }
    if (result.status === "limit-reached") {
      return Result.err(
        new HandlerError({ status: 400, message: "Contacts limit reached" }),
      );
    }

    return Result.ok({
      ...result.result,
      replayed: result.status === "replayed",
    });
  },
);

export default importContacts;
