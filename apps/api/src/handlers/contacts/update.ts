import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { currencyMinorUnitDigits } from "@stll/money";

import type { Transaction } from "@/api/db/root";
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
import {
  dateOfBirthFromColumns,
  dateOfBirthToColumns,
  validatePersonDetails,
} from "@/api/handlers/contacts/person-details";
import { contactTypeSchema } from "@/api/handlers/contacts/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { dateOfBirthSchema } from "@/api/lib/business-registries/date-of-birth";
import { nationalityCodesSchema } from "@/api/lib/business-registries/nationality-codes";
import { tMinorUnitAmount, tSafeId, tUserId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushContactSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueContactSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { lockOrgUserIdsForAssignment } from "@/api/lib/validated-org-user-id";

const updateContactBodySchema = t.Object({
  type: t.Optional(contactTypeSchema),
  prefix: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  firstName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  middleName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  lastName: t.Optional(t.Nullable(t.String({ maxLength: 256 }))),
  suffix: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  dateOfBirth: t.Optional(t.Nullable(dateOfBirthSchema)),
  nationalityCodes: t.Optional(t.Nullable(nationalityCodesSchema)),
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

type ContactRateUpdatesOptions = {
  tx: Transaction;
  contactId: SafeId<"contact">;
  organizationId: SafeId<"organization">;
  sourceCurrency: string | null;
  storedRate: number | null;
  currency: string | null | undefined;
  defaultHourlyRate: number | null | undefined;
};

const contactRateUpdates = async ({
  tx,
  contactId,
  organizationId,
  sourceCurrency,
  storedRate,
  currency,
  defaultHourlyRate,
}: ContactRateUpdatesOptions) => {
  if (defaultHourlyRate !== undefined) {
    return Result.ok({
      defaultHourlyRate:
        defaultHourlyRate === null ? null : cents(defaultHourlyRate),
    });
  }
  const exponentShift =
    storedRate !== null &&
    sourceCurrency &&
    currency &&
    currency !== sourceCurrency
      ? currencyMinorUnitDigits(currency) -
        currencyMinorUnitDigits(sourceCurrency)
      : 0;

  // Numeric arithmetic preserves integer precision before the API's safe
  // number boundary; refuse the entire update before any field is written.
  if (exponentShift > 0) {
    const beyondRange = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
          sql`ABS(ROUND(${contacts.defaultHourlyRate} * power(10::numeric, ${exponentShift}))) > ${Number.MAX_SAFE_INTEGER}`,
        ),
      )
      .limit(1);
    if (beyondRange.length > 0) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Currency change would put the contact rate out of range",
        }),
      );
    }
  }

  if (exponentShift === 0) {
    return Result.ok({ defaultHourlyRate: undefined });
  }
  return Result.ok({
    defaultHourlyRate: sql`ROUND(${contacts.defaultHourlyRate} * power(10::numeric, ${exponentShift}))::bigint`,
  });
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
  const attorneyIds = [body.originatingAttorneyId, body.responsibleAttorneyId]
    .filter((id) => id !== undefined && id !== null)
    .filter((id) => id.length > 0);

  const {
    defaultHourlyRate,
    metadata,
    dateOfBirth,
    nationalityCodes,
    ...rest
  } = body;

  const outcome = yield* Result.await(
    safeDb(async (tx) => {
      const validAttorneyIds = await lockOrgUserIdsForAssignment({
        tx,
        userIds: attorneyIds.map(brandPersistedUserId),
        organizationId,
      });
      if (!validAttorneyIds) {
        return {
          kind: "invalid" as const,
          error: new HandlerError({
            status: 400,
            message: "User is not a member of this organization",
          }),
        };
      }
      const existingRows = await tx
        .select({
          id: contacts.id,
          type: contacts.type,
          metadata: contacts.metadata,
          currency: contacts.currency,
          defaultHourlyRate: contacts.defaultHourlyRate,
          dateOfBirthYear: contacts.dateOfBirthYear,
          dateOfBirthMonth: contacts.dateOfBirthMonth,
          dateOfBirthDay: contacts.dateOfBirthDay,
          nationalityCodes: contacts.nationalityCodes,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.organizationId, organizationId),
          ),
        )
        .limit(1)
        .for("update");
      const existing = existingRows.at(0);
      if (!existing) {
        return { kind: "not_found" as const };
      }

      const error = validatePersonDetails({
        type: body.type ?? existing.type,
        dateOfBirth:
          dateOfBirth === undefined
            ? dateOfBirthFromColumns(existing)
            : dateOfBirth,
        nationalityCodes:
          nationalityCodes === undefined
            ? existing.nationalityCodes
            : nationalityCodes,
      });
      if (error) {
        return { kind: "invalid" as const, error };
      }

      const rateUpdates = await contactRateUpdates({
        tx,
        contactId,
        organizationId,
        sourceCurrency: existing.currency,
        storedRate: existing.defaultHourlyRate,
        currency: body.currency,
        defaultHourlyRate,
      });
      if (rateUpdates.isErr()) {
        return { kind: "invalid" as const, error: rateUpdates.error };
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
        ...(metadata === undefined
          ? {}
          : { metadata: mergeContactMetadata(existing.metadata, metadata) }),
        ...(dateOfBirth === undefined ? {} : dateOfBirthToColumns(dateOfBirth)),
        ...(nationalityCodes === undefined
          ? {}
          : {
              nationalityCodes: Array.isArray(nationalityCodes)
                ? nationalityCodes
                : [],
            }),
        ...pickDefined(rateUpdates.value, ["defaultHourlyRate"]),
      };
      if (Object.keys(updates).length === 0) {
        return {
          kind: "updated" as const,
          row: { id: existing.id },
          changed: false,
        };
      }

      const rows = await tx
        .update(contacts)
        .set({
          type: updates.type,
          prefix: updates.prefix,
          firstName: updates.firstName,
          middleName: updates.middleName,
          lastName: updates.lastName,
          suffix: updates.suffix,
          organizationName: updates.organizationName,
          displayName: updates.displayName,
          notes: updates.notes,
          emails: updates.emails,
          phones: updates.phones,
          addresses: updates.addresses,
          color: updates.color,
          tags: updates.tags,
          registrationNumber: updates.registrationNumber,
          taxId: updates.taxId,
          bankAccounts: updates.bankAccounts,
          billingAddress: updates.billingAddress,
          currency: updates.currency,
          paymentTermDays: updates.paymentTermDays,
          originatingAttorneyId: updates.originatingAttorneyId,
          responsibleAttorneyId: updates.responsibleAttorneyId,
          metadata: updates.metadata,
          dateOfBirthYear: updates.dateOfBirthYear,
          dateOfBirthMonth: updates.dateOfBirthMonth,
          dateOfBirthDay: updates.dateOfBirthDay,
          nationalityCodes: updates.nationalityCodes,
          defaultHourlyRate: updates.defaultHourlyRate,
        })
        .where(
          and(
            eq(contacts.id, contactId),
            eq(contacts.organizationId, organizationId),
          ),
        )
        .returning({ id: contacts.id });
      const row = rows.at(0);
      if (!row) {
        return { kind: "not_found" as const };
      }

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CONTACT,
        resourceId: contactId,
        workspaceId: null,
        changes: { fields: { old: null, new: Object.keys(updates) } },
      });
      await enqueueContactSearchRepairs(tx, [contactId]);
      return { kind: "updated" as const, row, changed: true };
    }),
  );

  if (outcome.kind === "not_found") {
    return Result.err(
      new HandlerError({ status: 404, message: "Contact not found" }),
    );
  }
  if (outcome.kind === "invalid") {
    return Result.err(outcome.error);
  }
  if (!outcome.changed) {
    return Result.ok(outcome.row);
  }

  flushContactSearchRepairs([contactId]).catch(captureError);

  return Result.ok(outcome.row);
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
    accountAccess: ACCOUNT_ACCESS.sandbox,
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
