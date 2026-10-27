import type { OrgAIConfig } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";

type OrgAIConfigRow = {
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
 * Decryption reports corruption separately from an absent configuration.
 * Runtime provider resolution may use the instance fallback; settings editing
 * refuses the corrupt outcome so stored configuration cannot be overwritten.
 * Both paths capture the failure once here.
 */
export type DecryptOrgAIConfigRowResult =
  | { status: "ok"; config: OrgAIConfig | null }
  | { status: "corrupt"; error: unknown };

/**
 * AI admission in the request context. Absent settings may use instance
 * defaults after organization and seat admission. A failed settings read is
 * `unreadable`: privacy preferences are unknown and AI work must be refused.
 */
export const ORG_AI_CONFIG_STATUS = {
  ok: "ok",
  unreadable: "unreadable",
  ownKeyRequired: "own_key_required",
  memberAssignmentRequired: "member_assignment_required",
} as const;

export type OrgAIConfigStatus =
  (typeof ORG_AI_CONFIG_STATUS)[keyof typeof ORG_AI_CONFIG_STATUS];

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
  // config": report it as corrupt so each caller can choose its policy.
  if (!ciphertext || !iv) {
    const error = new Error(
      "organization AI config row has ciphertext or IV but not both",
    );
    captureError(
      error,
      handlerErrorContext("aiConfig.validateEncryptionFields", {
        organizationId,
        source: "loadOrgAIConfig",
      }),
    );
    return { status: "corrupt", error };
  }

  try {
    const config = await decrypt(organizationId, ciphertext, iv);
    return { status: "ok", config };
  } catch (error) {
    captureError(
      error,
      handlerErrorContext("aiConfig.decrypt", {
        organizationId,
        source: "loadOrgAIConfig",
      }),
    );
    return { status: "corrupt", error };
  }
};

export type PromptCachingPreferenceRow = {
  promptCachingEnabled: boolean | null | undefined;
};

export const resolvePromptCachingPreference = (
  row: PromptCachingPreferenceRow | undefined,
): boolean => row?.promptCachingEnabled ?? true;
