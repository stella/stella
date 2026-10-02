import { Result } from "better-result";
import * as v from "valibot";

import { FEATURE_REGISTRY } from "@/api/lib/auth/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/auth/feature-access/registry";
import { AUTH_PROVIDER_ID_PATTERN } from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

const organizationIdSchema = v.pipe(
  v.string(),
  v.regex(AUTH_PROVIDER_ID_PATTERN),
);

const featureGrantSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("member"),
    organizationId: organizationIdSchema,
    email: v.pipe(
      v.string(),
      v.trim(),
      v.toLowerCase(),
      v.email(),
      v.check((email) => !email.includes("*")),
    ),
  }),
  v.strictObject({
    type: v.literal("organization"),
    organizationId: organizationIdSchema,
  }),
]);

export type FeatureGrant = v.InferOutput<typeof featureGrantSchema>;
export type FeatureAccessGrants = Readonly<
  Record<string, readonly FeatureGrant[]>
>;

const grantsObjectSchema = v.record(v.string(), v.array(featureGrantSchema));

export const createFeatureAccessGrantsEnvSchema = (registry: FeatureRegistry) =>
  v.optional(
    v.pipe(
      v.string(),
      v.rawTransform(({ dataset, addIssue, NEVER }) => {
        const json = Result.try((): unknown => JSON.parse(dataset.value));
        const parsed = json.isOk()
          ? v.safeParse(grantsObjectSchema, json.value)
          : null;
        if (
          parsed === null ||
          !parsed.success ||
          !json.isOk() ||
          !isRecord(json.value) ||
          Object.keys(json.value).some(
            (featureId) => !Object.hasOwn(registry, featureId),
          )
        ) {
          addIssue({
            input: "[redacted]",
            message:
              "FEATURE_ACCESS_GRANTS must be a JSON object of registered feature grants",
          });
          return NEVER;
        }
        return parsed.output;
      }),
    ),
    "{}",
  );

export const featureAccessGrantsEnvSchema =
  createFeatureAccessGrantsEnvSchema(FEATURE_REGISTRY);
