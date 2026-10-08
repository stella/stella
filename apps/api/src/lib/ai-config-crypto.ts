/**
 * Encryption helpers for organization AI configuration.
 *
 * Wraps the existing per-org AES-256-GCM encryption from
 * content-encryption.ts. The OrgAIConfig is serialized to
 * JSON, encrypted, and stored as two bytea columns
 * (ciphertext + IV) in organizationSettings.
 */

import * as v from "valibot";

import { TANSTACK_AI_PROVIDERS } from "@stll/ai-catalog";

import {
  DECISION_MODEL_PROVIDERS,
  normalizeOrgAIConfig,
  type OrgAIConfig,
} from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import type { EncryptedContent } from "@/api/lib/content-encryption";

const standardProviderSchema = v.picklist(
  TANSTACK_AI_PROVIDERS.filter((provider) => provider !== "anthropic"),
);

const modelSelectionProviderValues = [
  ...TANSTACK_AI_PROVIDERS,
  "azure_foundry",
  "huggingface",
] as const;

const modelSelectionSchema = v.strictObject({
  provider: v.picklist(modelSelectionProviderValues),
  modelId: v.pipe(v.string(), v.minLength(1)),
});

const providerSchema = v.variant("provider", [
  v.strictObject({
    provider: v.literal("anthropic"),
    apiKey: v.pipe(v.string(), v.minLength(1)),
    anthropicWorkspaceId: v.optional(
      v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    ),
    region: v.optional(v.picklist(["eu", "global", "ch"])),
  }),
  v.strictObject({
    provider: standardProviderSchema,
    apiKey: v.pipe(v.string(), v.minLength(1)),
    region: v.optional(v.picklist(["eu", "global", "ch"])),
  }),
  v.strictObject({
    provider: v.literal("azure_foundry"),
    apiKey: v.pipe(v.string(), v.minLength(1)),
    baseURL: v.pipe(v.string(), v.url()),
    apiVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
  v.strictObject({
    provider: v.literal("huggingface"),
    apiKey: v.pipe(v.string(), v.minLength(1)),
    baseURL: v.pipe(v.string(), v.url()),
  }),
]);

const decisionModelSchema = v.strictObject({
  provider: v.picklist(DECISION_MODEL_PROVIDERS),
  apiKey: v.pipe(v.string(), v.minLength(1)),
  modelId: v.pipe(v.string(), v.minLength(1)),
});

/** Validate the decrypted JSON matches OrgAIConfig shape. */
const orgAIConfigSchema = v.strictObject({
  providers: v.pipe(v.array(providerSchema), v.minLength(1)),
  overrideModels: v.nullable(
    v.strictObject({
      fast: v.optional(modelSelectionSchema),
      chat: v.optional(modelSelectionSchema),
      reasoning: v.optional(modelSelectionSchema),
      pdf: v.optional(modelSelectionSchema),
    }),
  ),
  // A blob written before the decision model existed has no key for it and
  // reads as "none", the same state clearing the setting writes.
  decision: v.optional(v.nullable(decisionModelSchema), null),
});
const parseOrgAIConfig = v.safeParser(orgAIConfigSchema);

export const isOrgAIConfig = (value: unknown): value is OrgAIConfig =>
  parseOrgAIConfig(value).success;

/**
 * Encrypt an OrgAIConfig for storage.
 *
 * Returns ciphertext + IV to be stored in the
 * aiConfigEncrypted / aiConfigIv columns.
 */
export const encryptAIConfig = async (
  organizationId: SafeId<"organization">,
  config: OrgAIConfig,
): Promise<EncryptedContent> =>
  await encryptContent(organizationId, JSON.stringify(config));

/**
 * Decrypt an OrgAIConfig from storage.
 *
 * Validates the decrypted JSON against the expected schema
 * to guard against corruption or tampering.
 */
export const decryptAIConfig = async (
  organizationId: SafeId<"organization">,
  ciphertext: Buffer,
  iv: Buffer,
): Promise<OrgAIConfig> => {
  const json = await decryptContent(organizationId, ciphertext, iv);
  const parsed: unknown = JSON.parse(json);
  return normalizeOrgAIConfig(v.parse(orgAIConfigSchema, parsed));
};

/** Reveal only a recognized provider prefix and the final four characters. */
export const maskApiKey = (key: string): string => {
  if (key.length < 16) {
    return "****";
  }
  const prefix =
    /^(sk-ant-(?:api\d+|usr)-|sk-or-v1-|sk-proj-|sk-svcacct-|sk-|AIza|ABSK|hf_)/u
      .exec(key)
      ?.at(0) ?? "";
  return `${prefix}****${key.slice(-4)}`;
};
