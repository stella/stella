/**
 * Encryption helpers for organization AI configuration.
 *
 * Wraps the existing per-org AES-256-GCM encryption from
 * content-encryption.ts. The OrgAIConfig is serialized to
 * JSON, encrypted, and stored as two bytea columns
 * (ciphertext + IV) in organizationSettings.
 */

import * as v from "valibot";

import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";
import { decryptContent, encryptContent } from "@/api/lib/content-encryption";
import type { EncryptedContent } from "@/api/lib/content-encryption";

const standardProviderSchema = v.picklist([
  "google",
  "openrouter",
  "openai",
  "anthropic",
]);

const modelSelectionSchema = v.strictObject({
  provider: v.picklist([
    "google",
    "openrouter",
    "openai",
    "azure_foundry",
    "anthropic",
  ]),
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
  return v.parse(orgAIConfigSchema, parsed);
};

/**
 * Mask an API key for safe display. Shows at most half
 * the key (capped at 8 chars) followed by asterisks.
 */
export const maskApiKey = (key: string): string => {
  const visibleChars = Math.min(8, Math.floor(key.length / 2));
  return `${key.slice(0, visibleChars)}${"*".repeat(16)}`;
};
