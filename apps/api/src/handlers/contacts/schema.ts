import { t } from "elysia";

import { CONTACT_TYPES, type ContactType } from "@stll/api-contract";

const CONTACT_TYPE_SCHEMA_VALUES = [
  CONTACT_TYPES[0],
  CONTACT_TYPES[1],
] as const satisfies readonly ContactType[];

type MissingContactTypeSchemaValue = Exclude<
  ContactType,
  (typeof CONTACT_TYPE_SCHEMA_VALUES)[number]
>;

true satisfies MissingContactTypeSchemaValue extends never ? true : never;

// Keep the literal union: `t.Optional(t.UnionEnum(...))` coerces an absent
// query value to the enum's first member in the current Elysia version.
export const contactTypeSchema = t.Union([
  t.Literal(CONTACT_TYPE_SCHEMA_VALUES[0]),
  t.Literal(CONTACT_TYPE_SCHEMA_VALUES[1]),
]);

export const createContactTypeSchema = t.UnionEnum(CONTACT_TYPE_SCHEMA_VALUES, {
  description: "Contact kind; required when creating",
});
