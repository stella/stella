import { Result, panic } from "better-result";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { CONTACT_IMPORT_TAX_ID_SCHEMES } from "@stll/api-contract";

import {
  contactImportRequests,
  contacts,
  type ContactImportReceiptResult,
} from "@/api/db/schema";
import { lockContactCapacity } from "@/api/handlers/contacts/contact-capacity";
import {
  classifyBrazilianTaxId,
  fingerprintContactImport,
} from "@/api/handlers/contacts/contact-import-receipt";
import {
  contactImportCandidateSchema,
  taxIdSchemeSchema,
} from "@/api/handlers/contacts/contact-import-schema";
import { normalizeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { AuditEvent } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  enqueueContactSearchRepairs,
  flushContactSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";

// The reviewed row plus the caller-generated id. The field set itself lives in
// `contact-import-schema.ts`, shared with the validate handler.
const importContactRowSchema = t.Composite([
  t.Object({ id: tSafeId("contact") }),
  contactImportCandidateSchema,
]);

type ImportContactRow = Static<typeof importContactRowSchema>;

const importContactsBodySchema = t.Object({
  importRequestId: tSafeId("contactImportRequest"),
  taxIdScheme: taxIdSchemeSchema,
  rows: t.Array(importContactRowSchema, {
    maxItems: LIMITS.contactsImportRowsMax,
  }),
});

type ImportSkipReason =
  | "duplicate_contact_id"
  | "duplicate_tax_id"
  | "invalid_tax_id"
  | "contacts_limit_reached";

type ImportResultRow =
  | { index: number; status: "created"; contactId: SafeId<"contact"> }
  | { index: number; status: "skipped"; reason: ImportSkipReason };

type ClassifiedImportRow = {
  index: number;
  row: ImportContactRow;
  /** Normalized digits under `br_cpf_cnpj`; null when no scheme dedupes. */
  dedupeTaxId: string | null;
  taxId: string | undefined;
};

type TaxIdScheme = (typeof CONTACT_IMPORT_TAX_ID_SCHEMES)[number];

type TaxIdResolution =
  | { status: "ok"; taxId: string | undefined; dedupeTaxId: string | null }
  | { status: "invalid" };

const resolveTaxId = (
  scheme: TaxIdScheme,
  row: ImportContactRow,
): TaxIdResolution => {
  switch (scheme) {
    case "none":
      return { status: "ok", taxId: row.taxId, dedupeTaxId: null };
    case "br_cpf_cnpj": {
      if (row.taxId === undefined) {
        return { status: "invalid" };
      }
      const classification = classifyBrazilianTaxId(row.taxId);
      if (!classification || classification.type !== row.type) {
        return { status: "invalid" };
      }
      return {
        status: "ok",
        taxId: classification.digits,
        dedupeTaxId: classification.digits,
      };
    }
    default: {
      const exhaustive: never = scheme;
      return exhaustive;
    }
  }
};

const config = {
  description:
    "Import a reviewed batch of up to 500 contacts into the organization " +
    "address book. Supply a caller-generated importRequestId: replaying it " +
    "with the same rows returns the original result, while changing the rows " +
    "is rejected. taxIdScheme selects tax-id validation (none, or " +
    "br_cpf_cnpj checksums with duplicate detection). Invalid, duplicate, " +
    "and over-limit rows are skipped; all accepted rows commit atomically.",
  permissions: { contact: ["create"] },
  mcp: { type: "covered", by: "save_contact" },
  body: importContactsBodySchema,
} satisfies HandlerConfig;

const importContacts = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const requestFingerprint = fingerprintContactImport([
      body.taxIdScheme,
      ...body.rows,
    ]);

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockContactCapacity(tx, organizationId);

        const existingRequest = await tx.query.contactImportRequests.findFirst({
          where: {
            organizationId: { eq: organizationId },
            userId: { eq: user.id },
            idempotencyKey: { eq: body.importRequestId },
          },
        });
        if (existingRequest) {
          if (existingRequest.requestFingerprint !== requestFingerprint) {
            return { status: "conflict" as const };
          }
          return {
            status: "replayed" as const,
            result: existingRequest.result,
          };
        }

        const classifiedRows: ClassifiedImportRow[] = [];
        const resultByIndex = new Map<number, ImportResultRow>();
        const seenContactIds = new Set<SafeId<"contact">>();
        const seenTaxIds = new Set<string>();

        for (const [index, row] of body.rows.entries()) {
          const resolution = resolveTaxId(body.taxIdScheme, row);
          if (resolution.status === "invalid") {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: "invalid_tax_id",
            });
            continue;
          }
          if (seenContactIds.has(row.id)) {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: "duplicate_contact_id",
            });
            continue;
          }
          if (
            resolution.dedupeTaxId !== null &&
            seenTaxIds.has(resolution.dedupeTaxId)
          ) {
            resultByIndex.set(index, {
              index,
              status: "skipped",
              reason: "duplicate_tax_id",
            });
            continue;
          }

          seenContactIds.add(row.id);
          if (resolution.dedupeTaxId !== null) {
            seenTaxIds.add(resolution.dedupeTaxId);
          }
          classifiedRows.push({
            index,
            row,
            dedupeTaxId: resolution.dedupeTaxId,
            taxId: resolution.taxId,
          });
        }

        const candidateIds = classifiedRows.map(({ row }) => row.id);
        const existingIds =
          candidateIds.length === 0
            ? []
            : await tx
                .select({ id: contacts.id })
                .from(contacts)
                .where(inArray(contacts.id, candidateIds));
        const existingIdSet = new Set(existingIds.map(({ id }) => id));

        const candidateTaxIds = classifiedRows.flatMap(({ dedupeTaxId }) =>
          dedupeTaxId === null ? [] : [dedupeTaxId],
        );
        const normalizedTaxId = sql<string>`regexp_replace(${contacts.taxId}, '\\D', '', 'g')`;
        const existingTaxIds =
          candidateTaxIds.length === 0
            ? []
            : await tx
                .select({ taxId: normalizedTaxId })
                .from(contacts)
                .where(
                  and(
                    eq(contacts.organizationId, organizationId),
                    isNotNull(contacts.taxId),
                    inArray(normalizedTaxId, candidateTaxIds),
                  ),
                );
        const existingTaxIdSet = new Set(
          existingTaxIds.map(({ taxId }) => taxId),
        );

        const countRow = (
          await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(contacts)
            .where(eq(contacts.organizationId, organizationId))
        ).at(0);
        const total =
          countRow?.total ?? panic("Contact count query returned no row");
        let remainingCapacity = Math.max(0, LIMITS.contactsCount - total);

        const rowsToInsert: ClassifiedImportRow[] = [];
        for (const candidate of classifiedRows) {
          if (existingIdSet.has(candidate.row.id)) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "duplicate_contact_id",
            });
            continue;
          }
          if (
            candidate.dedupeTaxId !== null &&
            existingTaxIdSet.has(candidate.dedupeTaxId)
          ) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "duplicate_tax_id",
            });
            continue;
          }
          if (remainingCapacity === 0) {
            resultByIndex.set(candidate.index, {
              index: candidate.index,
              status: "skipped",
              reason: "contacts_limit_reached",
            });
            continue;
          }

          rowsToInsert.push(candidate);
          remainingCapacity -= 1;
        }

        const created =
          rowsToInsert.length === 0
            ? []
            : await tx
                .insert(contacts)
                .values(
                  rowsToInsert.map(({ row, taxId }) => ({
                    id: row.id,
                    organizationId,
                    createdBy: user.id,
                    type: row.type,
                    displayName: row.displayName,
                    prefix: row.prefix,
                    firstName: row.firstName,
                    middleName: row.middleName,
                    lastName: row.lastName,
                    suffix: row.suffix,
                    organizationName:
                      row.organizationName ??
                      (row.type === "organization"
                        ? row.displayName
                        : undefined),
                    notes: row.notes,
                    emails: row.emails,
                    phones: row.phones,
                    addresses: row.addresses,
                    tags: row.tags,
                    registrationNumber: row.registrationNumber,
                    taxId,
                    metadata: normalizeContactMetadata(row.metadata),
                  })),
                )
                .onConflictDoNothing()
                .returning();
        const createdById = new Map(created.map((row) => [row.id, row]));

        for (const candidate of rowsToInsert) {
          const createdRow = createdById.get(candidate.row.id);
          resultByIndex.set(
            candidate.index,
            createdRow
              ? {
                  index: candidate.index,
                  status: "created",
                  contactId: createdRow.id,
                }
              : {
                  index: candidate.index,
                  status: "skipped",
                  reason: "duplicate_contact_id",
                },
          );
        }

        if (created.length > 0) {
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
            metadata: {
              source: "import",
              importRequestId: body.importRequestId,
            },
          }));
          await recordAuditEvent(tx, auditEvents);
          await enqueueContactSearchRepairs(
            tx,
            created.map(({ id }) => id),
          );
        }

        const result = {
          results: body.rows.map((_, index) => {
            const rowResult = resultByIndex.get(index);
            if (!rowResult) {
              panic("Contact import result is incomplete");
            }
            return rowResult;
          }),
        } satisfies ContactImportReceiptResult;

        await tx.insert(contactImportRequests).values({
          id: createSafeId<"contactImportRequest">(),
          organizationId,
          userId: user.id,
          idempotencyKey: body.importRequestId,
          requestFingerprint,
          result,
        });

        return { status: "created" as const, result };
      }),
    );

    if (outcome.status === "conflict") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Import request was already used for different contacts",
        }),
      );
    }

    const createdContactIds = outcome.result.results.flatMap((result) =>
      result.status === "created" ? [result.contactId] : [],
    );
    if (createdContactIds.length > 0) {
      flushContactSearchRepairs(createdContactIds).catch(captureError);
    }

    return Result.ok({
      ...outcome.result,
      replayed: outcome.status === "replayed",
    });
  },
);

export default importContacts;
