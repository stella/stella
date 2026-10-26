import * as v from "valibot";

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

export const contactTypeSchema = v.union([
  v.literal(CONTACT_TYPE_SCHEMA_VALUES[0]),
  v.literal(CONTACT_TYPE_SCHEMA_VALUES[1]),
]);

export const createContactTypeSchema = v.pipe(
  v.picklist(CONTACT_TYPE_SCHEMA_VALUES),
  v.description("Contact kind; required when creating"),
);
