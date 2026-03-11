import { and, eq } from "drizzle-orm";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import { contacts } from "@/api/db/schema";
import {
  bankAccountSchema,
  billingAddressSchema,
  contactAddressSchema,
  contactEmailSchema,
  contactPhoneSchema,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

export const updateContactBodySchema = t.Object({
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

type UpdateContactBody = Static<typeof updateContactBodySchema>;

type UpdateContactByIdHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  contactId: string;
  body: UpdateContactBody;
};

export const updateContactByIdHandler = async ({
  scopedDb,
  organizationId,
  contactId,
  body,
}: UpdateContactByIdHandlerProps) => {
  const [updated] = await scopedDb((tx) =>
    tx
      .update(contacts)
      .set(body)
      .where(
        and(
          eq(contacts.id, contactId),
          eq(contacts.organizationId, organizationId),
        ),
      )
      .returning({ id: contacts.id }),
  );

  if (!updated) {
    return status(404, { message: "Contact not found" });
  }

  return updated;
};
