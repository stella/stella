import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics";
import type { SafeId } from "@/api/lib/branded-types";
import { ConfigurationError } from "@/api/lib/errors/tagged-errors";

export type OrgAIConfigRow = {
  aiConfigEncrypted: string | null | undefined;
  aiConfigIv: string | null | undefined;
};

type DecryptOrgAIConfig = (
  organizationId: SafeId<"organization">,
  ciphertext: Buffer,
  iv: Buffer,
) => Promise<OrgAIConfig>;

export type DecryptOrgAIConfigRowInput = {
  decrypt: DecryptOrgAIConfig;
  organizationId: SafeId<"organization">;
  row: OrgAIConfigRow | undefined;
};

const decodeNullableByteaText = (value: string | null | undefined) => {
  if (!value) {
    return null;
  }
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(hex, "hex");
};

/**
 * Discriminated outcome of a decrypt attempt. `corrupt` is deliberately not
 * an exception here: callers that only need best-effort config (the shared
 * per-request auth resolve, which every authenticated request runs through)
 * must be able to degrade to `null` without a throw ever reaching them.
 * Callers that are about to use the config for an actual AI call should use
 * {@link decryptOrgAIConfigRowOrThrow} instead, which turns `corrupt` into a
 * typed `ConfigurationError`. The failure is captured once, here, regardless
 * of which path the caller takes.
 */
export type DecryptOrgAIConfigRowResult =
  | { status: "ok"; config: OrgAIConfig | null }
  | { status: "corrupt"; error: unknown };

export const decryptOrgAIConfigRow = async ({
  decrypt,
  organizationId,
  row,
}: DecryptOrgAIConfigRowInput): Promise<DecryptOrgAIConfigRowResult> => {
  const ciphertext = decodeNullableByteaText(row?.aiConfigEncrypted);
  const iv = decodeNullableByteaText(row?.aiConfigIv);

  if (!ciphertext && !iv) {
    return { status: "ok", config: null };
  }

  // Exactly one of ciphertext/IV present is a malformed row, not "no
  // config": report it as corrupt so AI-invoking callers fail closed
  // instead of silently falling back to the default provider.
  if (!ciphertext || !iv) {
    const error = new Error(
      "organization AI config row has ciphertext or IV but not both",
    );
    captureError(error, {
      organizationId,
      source: "loadOrgAIConfig",
    });
    return { status: "corrupt", error };
  }

  try {
    const config = await decrypt(organizationId, ciphertext, iv);
    return { status: "ok", config };
  } catch (error) {
    captureError(error, {
      organizationId,
      source: "loadOrgAIConfig",
    });
    return { status: "corrupt", error };
  }
};

/**
 * Use only from paths that are about to act on the org's AI config (issue an
 * AI request, pick a provider/model). Silently treating a corrupt row as "no
 * config" there could mis-route or mis-bill, so this surfaces a typed
 * {@link ConfigurationError} instead. Do not use this from shared
 * per-request context builders (auth resolve, MCP capability context) — a
 * corrupted row must not fail every request for the org; use
 * {@link decryptOrgAIConfigRow} and degrade to `null` there instead.
 */
export const decryptOrgAIConfigRowOrThrow = async (
  input: DecryptOrgAIConfigRowInput,
): Promise<OrgAIConfig | null> => {
  const result = await decryptOrgAIConfigRow(input);
  if (result.status === "corrupt") {
    throw new ConfigurationError({
      message: "Stored organization AI configuration is invalid",
      cause: result.error,
    });
  }
  return result.config;
};

export type PromptCachingPreferenceRow = {
  promptCachingEnabled: boolean | null | undefined;
};

export const resolvePromptCachingPreference = (
  row: PromptCachingPreferenceRow | undefined,
): boolean => row?.promptCachingEnabled ?? true;
