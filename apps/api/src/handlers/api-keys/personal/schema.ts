import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { machineApiKeyNameSchema } from "@/api/handlers/api-keys/mint";
import { paginationCursorSchema, uniqueItems } from "@/api/lib/custom-schema";
import {
  API_KEY_POLICY,
  PERSONAL_API_KEY_AUDIENCES,
  PERSONAL_API_KEY_SCOPES,
} from "@/api/lib/machine-api-key-config";

export const personalApiKeyExpirySchema = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(API_KEY_POLICY.personal.minDays),
    v.maxValue(API_KEY_POLICY.personal.maxDays),
  ),
);
export const personalApiKeyBodySchema = v.object({
  name: machineApiKeyNameSchema,
  scopes: v.optional(
    v.pipe(
      v.array(v.picklist([...PERSONAL_API_KEY_SCOPES])),
      v.minLength(1),
      v.maxLength(PERSONAL_API_KEY_SCOPES.length),
      uniqueItems(),
    ),
  ),
  audience: v.optional(
    v.union([
      v.literal(PERSONAL_API_KEY_AUDIENCES[0]),
      v.literal(PERSONAL_API_KEY_AUDIENCES[1]),
    ]),
  ),
  expiresInDays: personalApiKeyExpirySchema,
});
export const personalApiKeyIdBodySchema = v.object({
  keyId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});
export const personalApiKeyListQuerySchema = v.object({
  limit: v.optional(
    numberFromString(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

type PersonalAudience = (typeof PERSONAL_API_KEY_AUDIENCES)[number];
type SchemaAudience = NonNullable<
  v.InferOutput<typeof personalApiKeyBodySchema>["audience"]
>;
true satisfies Exclude<PersonalAudience, SchemaAudience> extends never
  ? true
  : never;
true satisfies Exclude<SchemaAudience, PersonalAudience> extends never
  ? true
  : never;
