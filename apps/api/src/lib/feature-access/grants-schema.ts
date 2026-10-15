import { Result } from "better-result";
import * as v from "valibot";

import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";
import type { FeatureRegistry } from "@/api/lib/feature-access/registry";
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

// Validate entries so prototype-named keys receive the same shape checks.
const grantsEntriesSchema = v.array(
  v.tuple([v.string(), v.array(featureGrantSchema)]),
);

export const createFeatureAccessGrantsEnvSchema = (registry: FeatureRegistry) =>
  v.optional(
    v.pipe(
      v.string(),
      v.rawTransform(({ dataset, addIssue, NEVER }) => {
        const json = Result.try((): unknown => JSON.parse(dataset.value));
        const parsed =
          json.isOk() && isRecord(json.value)
            ? v.safeParse(grantsEntriesSchema, Object.entries(json.value))
            : null;
        if (parsed === null || !parsed.success) {
          addIssue({
            input: "[redacted]",
            message:
              "API_FEATURE_ACCESS_GRANTS must be a JSON object of feature grants",
          });
          return NEVER;
        }
        const entries = parsed.output;
        const knownEntries = entries.filter(([featureId]) =>
          Object.hasOwn(registry, featureId),
        );
        return {
          grants: Object.fromEntries(knownEntries),
          unknownGrantCount: entries.length - knownEntries.length,
        };
      }),
    ),
    "{}",
  );

export const featureAccessGrantsEnvSchema =
  createFeatureAccessGrantsEnvSchema(FEATURE_REGISTRY);
