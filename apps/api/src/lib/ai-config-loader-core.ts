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

export const decryptOrgAIConfigRow = async ({
  decrypt,
  organizationId,
  row,
}: DecryptOrgAIConfigRowInput): Promise<OrgAIConfig | null> => {
  const ciphertext = decodeNullableByteaText(row?.aiConfigEncrypted);
  const iv = decodeNullableByteaText(row?.aiConfigIv);

  if (!ciphertext || !iv) {
    return null;
  }

  try {
    return await decrypt(organizationId, ciphertext, iv);
  } catch (error) {
    captureError(error, {
      organizationId,
      source: "loadOrgAIConfig",
    });
    throw new ConfigurationError({
      message: "Stored organization AI configuration is invalid",
      cause: error,
    });
  }
};

export type PromptCachingPreferenceRow = {
  promptCachingEnabled: boolean | null | undefined;
};

export const resolvePromptCachingPreference = (
  row: PromptCachingPreferenceRow | undefined,
): boolean => row?.promptCachingEnabled ?? true;
