import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
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
import { contactTypeSchema } from "@/api/handlers/contacts/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tMinorUnitAmount, tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  enqueueContactSearchRepairs,
  flushContactSearchRepairs,
} from "@/api/lib/search/projection-repair-queue";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";

const updateContactBodySchema = t.Object({
  type: t.Optional(contactTypeSchema),
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
  defaultHourlyRate: t.Optional(t.Nullable(tMinorUnitAmount(0))),
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

export type UpdateContactHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  contactId: SafeId<"contact">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateContactBodySchema>;
};

// Shared contact-update logic reused by the HTTP handler and the
// `save_contact` MCP tool, so both emit identical audit events and
// search-index writes.
export const updateContactHandler = async function* ({
  safeDb,
  organizationId,
  contactId,
  recordAuditEvent,
  body,
}: UpdateContactHandlerProps) {
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
          // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- bounded: at most two attorney ids per request, deduplicated
          const validAttorneyId = await validateOrgUserId(
            tx,
            brandPersistedUserId(attorneyId),
            organizationId,
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
              eq(contacts.id, contactId),
              eq(contacts.organizationId, organizationId),
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
              eq(contacts.id, contactId),
              eq(contacts.organizationId, organizationId),
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
            eq(contacts.id, contactId),
            eq(contacts.organizationId, organizationId),
          ),
        )
        .returning({ id: contacts.id });

      if (rows.length > 0) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
          resourceId: contactId,
          workspaceId: null,
          changes: { fields: { old: null, new: Object.keys(updates) } },
        });
        await enqueueContactSearchRepairs(tx, [contactId]);
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

  flushContactSearchRepairs([contactId]).catch(captureError);

  return Result.ok(updated);
};

const updateContactById = createSafeRootHandler(
  {
    description:
      "Change a contact in the organization address book, writing only the " +
      "fields you pass and clearing a nullable one when you pass null. " +
      "metadata is merged into the stored object rather than replacing it. " +
      "An attorney id that is not a member of the organization is refused, " +
      "and an unknown contact is a 404.",
    permissions: { contact: ["update"] },
    mcp: { type: "covered", by: "save_contact" },
    params: updateContactParamsSchema,
    body: updateContactBodySchema,
  },
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    return yield* updateContactHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      contactId: params.contactId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateContactById;
