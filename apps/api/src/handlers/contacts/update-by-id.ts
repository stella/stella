import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tUuid } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { cents } from "@/api/lib/money";
import { pickDefined } from "@/api/lib/pick-defined";

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
  originatingAttorneyId: t.Optional(t.Nullable(t.String())),
  responsibleAttorneyId: t.Optional(t.Nullable(t.String())),
});

const updateContactParamsSchema = t.Object({
  contactId: tUuid,
});

const updateContactById = createSafeRootHandler(
  {
    permissions: { contact: ["update"] },
    params: updateContactParamsSchema,
    body: updateContactBodySchema,
  },
  async function* ({ safeDb, session, params, body }) {
    const { defaultHourlyRate, ...rest } = body;
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
        "tags",
        "color",
        "registrationNumber",
        "taxId",
        "bankAccounts",
        "billingAddress",
        "currency",
        "paymentTermDays",
        "originatingAttorneyId",
        "responsibleAttorneyId",
      ]),
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
      safeDb((tx) =>
        tx
          .update(contacts)
          .set(updates)
          .where(
            and(
              eq(contacts.id, params.contactId),
              eq(contacts.organizationId, session.activeOrganizationId),
            ),
          )
          .returning({ id: contacts.id }),
      ),
    );
    const updated = updatedRows.at(0);

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Contact not found" }),
      );
    }

    return Result.ok(updated);
  },
);

export default updateContactById;
