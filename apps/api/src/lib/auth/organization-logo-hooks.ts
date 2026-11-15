import { APIError } from "better-auth/api";

import { ORGANIZATION_LOGO_RULES } from "@stll/auth-model";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";

// Twelve decoded bytes cover the longest header checked (WebP's
// `RIFF....WEBP`); sixteen base64 characters decode to exactly twelve.
const LOGO_HEADER_BASE64_LENGTH = 16;

/** The declared image type agrees with the first bytes of the payload. */
const logoBytesMatchDeclaredType = (logo: string): boolean => {
  const separator = logo.indexOf(";base64,");
  const mimeType = logo.slice("data:".length, separator);
  const payload = logo.slice(separator + ";base64,".length);
  // Whole four-character groups only, so a truncated payload decodes to
  // fewer bytes and fails the signature instead of throwing.
  const headerLength = Math.min(
    LOGO_HEADER_BASE64_LENGTH,
    payload.length - (payload.length % 4),
  );
  const header = Uint8Array.fromBase64(payload.slice(0, headerLength));
  return header.length > 0 && declaredMimeMatchesMagic(mimeType, header);
};

/** Better Auth consumes a refused organization write through APIError rejection. */
export const requireOrganizationLogo = (
  logo: string | null | undefined,
): void => {
  if (
    logo &&
    (logo.length > ORGANIZATION_LOGO_RULES.maxLength ||
      !ORGANIZATION_LOGO_RULES.pattern.test(logo) ||
      !logoBytesMatchDeclaredType(logo))
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "organization_logo_invalid",
      message: "Organization logos must be a small PNG, JPEG or WebP data URL.",
    });
  }
};
