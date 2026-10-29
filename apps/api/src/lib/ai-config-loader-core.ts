import type { Result } from "better-result";

import { AI_UNAVAILABLE_REASON } from "@stll/api-contract/organization-ai-availability";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import type { OrgAIConfigReadError } from "@/api/lib/ai-config-crypto";
import type { SafeId } from "@/api/lib/branded-types";

type OrgAIConfigRow = {
  aiConfigEncrypted: string | Buffer | null | undefined;
  aiConfigIv: string | Buffer | null | undefined;
};

type DecryptOrgAIConfig = (
  organizationId: SafeId<"organization">,
  ciphertext: Buffer | null | undefined,
  iv: Buffer | null | undefined,
) => Promise<Result<OrgAIConfig, OrgAIConfigReadError>>;

export type DecryptOrgAIConfigRowInput = {
  decrypt: DecryptOrgAIConfig;
  organizationId: SafeId<"organization">;
  row: OrgAIConfigRow | undefined;
};

const decodeNullableByteaText = (value: string | Buffer | null | undefined) => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(hex, "hex");
};

/**
 * Decryption reports corruption separately from an absent configuration.
 * Runtime calls and settings editing refuse corruption: switching processors
 * or overwriting stored configuration requires a readable configuration.
 * The failure is captured once here.
 */
export type DecryptOrgAIConfigRowResult =
  | { status: "ok"; config: OrgAIConfig | null }
  | { status: "corrupt"; error: OrgAIConfigReadError };

/**
 * AI admission in the request context. Absent settings may use instance
 * defaults after organization and seat admission. A failed settings read is
 * `unreadable`: privacy preferences are unknown and AI work must be refused.
 */
export const ORG_AI_CONFIG_STATUS = {
  ok: "ok",
  unreadable: AI_UNAVAILABLE_REASON.unreadable,
  ownKeyRequired: AI_UNAVAILABLE_REASON.ownKeyRequired,
  memberAssignmentRequired: AI_UNAVAILABLE_REASON.memberAssignmentRequired,
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

  const config = await decrypt(organizationId, ciphertext, iv);
  if (config.isErr()) {
    return { status: "corrupt", error: config.error };
  }
  return { status: "ok", config: config.value };
};

export type PromptCachingPreferenceRow = {
  promptCachingEnabled: boolean | null | undefined;
};

export const resolvePromptCachingPreference = (
  row: PromptCachingPreferenceRow | undefined,
): boolean => row?.promptCachingEnabled ?? true;
