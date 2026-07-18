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

import { normalizeOrgAIConfig, type OrgAIConfig } from "@/api/lib/ai-config";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import type { EncryptedContent } from "@/api/lib/content-encryption";

const standardProviderSchema = v.picklist(TANSTACK_AI_PROVIDERS);

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

/** Validate the decrypted JSON matches OrgAIConfig shape. */
const orgAIConfigSchema = v.strictObject({
  providers: v.pipe(v.array(providerSchema), v.minLength(1)),
  overrideModels: v.strictObject({
    fast: modelSelectionSchema,
    chat: modelSelectionSchema,
    reasoning: modelSelectionSchema,
    pdf: modelSelectionSchema,
  }),
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

/**
 * Mask an API key for safe display. Reveals a prefix of at most 8 chars
 * (enough to identify which key a long, real credential is) but never more
 * than a quarter of the key's length, so a short or misconfigured key can
 * never expose a meaningful portion of the secret. A genuine 32+ char key
 * shows its 8-char prefix; a 16-char key shows only 4 (a quarter, not the
 * half the earlier `floor(length / 2)` rule would have leaked).
 */
export const maskApiKey = (key: string): string => {
  const visibleChars = Math.min(8, Math.floor(key.length / 4));
  return `${key.slice(0, visibleChars)}${"*".repeat(16)}`;
};
