import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactMetadataSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { mergeContactMetadata } from "@/api/handlers/contacts/contact-metadata";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  reindexWorkspacesForContact,
  upsertContactSearchDocument,
} from "@/api/lib/search/index-global";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const updateContactBodySchema = t.Object({
  type: t.Optional(t.Union([t.Literal("person"), t.Literal("organization")])),
  prefix: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  firstName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  middleName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  lastName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  suffix: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  organizationName: t.Optional(t.Nullable(t.String({ maxLength: 512 }))),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 512 })),
  notes: t.Optional(t.Nullable(t.String())),
  emails: t.Optional(t.Nullable(t.Array(contactEmailSchema, { maxItems: 20 }))),
  phones: t.Optional(t.Nullable(t.Array(contactPhoneSchema, { maxItems: 20 }))),
  addresses: t.Optional(
    t.Nullable(t.Array(contactAddressSchema, { maxItems: 10 })),
  ),
  metadata: t.Optional(t.Nullable(contactMetadataSchema)),
  tags: t.Optional(t.Nullable(t.Array(t.String(), { maxItems: 50 }))),
  color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  registrationNumber: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  taxId: t.Optional(t.Nullable(t.String({ maxLength: 64 }))),
  bankAccounts: t.Optional(
    t.Nullable(t.Array(bankAccountSchema, { maxItems: 10 })),
  ),
  billingAddress: t.Optional(t.Nullable(billingAddressSchema)),
  defaultHourlyRate: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
  currency: t.Optional(t.Nullable(t.String({ minLength: 3, maxLength: 3 }))),
  paymentTermDays: t.Optional(
    t.Nullable(t.Integer({ minimum: 0, maximum: 365 })),
  ),
  originatingAttorneyId: t.Optional(t.Nullable(tUserId)),
  responsibleAttorneyId: t.Optional(t.Nullable(tUserId)),
});

const updateContactParamsSchema = t.Object({
  contactId: tSafeId("contact"),
});

const updateContactById = createSafeRootHandler(
  {
    permissions: { contact: ["update"] },
    params: updateContactParamsSchema,
    body: updateContactBodySchema,
  },
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const attorneyIds: string[] = [];
    if (body.originatingAttorneyId) {
      attorneyIds.push(body.originatingAttorneyId);
    }
    if (body.responsibleAttorneyId) {
      attorneyIds.push(body.responsibleAttorneyId);
    }

    if (attorneyIds.length > 0) {
      const uniqueAttorneyIds = [...new Set(attorneyIds)];
      const hasInvalidAttorney = yield* Result.await(
        safeDb(async (tx) => {
          for (const attorneyId of uniqueAttorneyIds) {
            const validAttorneyId = await validateOrgUserId(
              tx,
              brandPersistedUserId(attorneyId),
              session.activeOrganizationId,
            );
            if (!validAttorneyId) {
              return true;
            }
          }
          return false;
        }),
      );

      if (hasInvalidAttorney) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "User is not a member of this organization",
          }),
        );
      }
    }

    const { defaultHourlyRate, metadata, ...rest } = body;

    let metadataUpdate = {};
    if (metadata !== undefined) {
      const existingRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ metadata: contacts.metadata })
            .from(contacts)
            .where(
              and(
                eq(contacts.id, params.contactId),
                eq(contacts.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1),
        ),
      );
      const existing = existingRows.at(0);

      if (!existing) {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Contact not found",
          }),
        );
      }

      metadataUpdate = {
        metadata: mergeContactMetadata(existing.metadata, metadata),
      };
    }

    const updates = {
      ...pickDefined(rest, [
        "type",
        "prefix",
        "firstName",
        "middleName",
        "lastName",
        "suffix",
        "organizationName",
        "displayName",
        "notes",
        "emails",
        "phones",
        "addresses",
        "color",
        "tags",
        "registrationNumber",
        "taxId",
        "bankAccounts",
        "billingAddress",
        "currency",
        "paymentTermDays",
        "originatingAttorneyId",
        "responsibleAttorneyId",
      ]),
      ...metadataUpdate,
      ...(defaultHourlyRate === undefined
        ? {}
        : {
            defaultHourlyRate:
              defaultHourlyRate === null ? null : cents(defaultHourlyRate),
          }),
    };

    if (Object.keys(updates).length === 0) {
      const existingRows = yield* Result.await(
        safeDb((tx) =>
          tx
            .select({ id: contacts.id })
            .from(contacts)
            .where(
              and(
                eq(contacts.id, params.contactId),
                eq(contacts.organizationId, session.activeOrganizationId),
              ),
            )
            .limit(1),
        ),
      );
      const existing = existingRows.at(0);

      if (!existing) {
        return Result.err(
          new HandlerError({ status: 404, message: "Contact not found" }),
        );
      }

      return Result.ok(existing);
    }

    const updatedRows = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(contacts)
          .set(updates)
          .where(
            and(
              eq(contacts.id, params.contactId),
              eq(contacts.organizationId, session.activeOrganizationId),
            ),
          )
          .returning({ id: contacts.id });

        if (rows.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
            resourceId: params.contactId,
            workspaceId: null,
            changes: { fields: { old: null, new: Object.keys(updates) } },
          });
        }

        return rows;
      }),
    );
    const updated = updatedRows.at(0);

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Contact not found" }),
      );
    }

    Promise.all([
      upsertContactSearchDocument(params.contactId),
      reindexWorkspacesForContact(params.contactId),
    ]).catch(captureError);

    return Result.ok(updated);
  },
);

export default updateContactById;
