import { customAlphabet } from "nanoid";

/**
 * Alphabet for verification codes: lowercase alphanumeric
 * excluding ambiguous characters (0, O, 1, l, I).
 * 31 chars, 10-char length = 31^10 ~ 8.2 * 10^14 combinations.
 */
// biome-ignore lint/security/noSecrets: character set, not a secret
const VCODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const VCODE_LENGTH = 10;

const generateCode = customAlphabet(VCODE_ALPHABET, VCODE_LENGTH);

/**
 * Generate a globally unique, unguessable verification code.
 * Stored without prefix; the `stl:` prefix is added in the
 * DOCX footer only.
 */
export const generateVerificationCode = (): string => generateCode();

/**
 * Build a frozen document reference stamp.
 *
 * Format: `{matterRef}/{docSeq}.v{version}`
 *
 * Examples:
 * - `toDocumentReference("2026/001", 15, 3)` → `"2026/001/015.v3"`
 * - `toDocumentReference("CORP-001", 3, 1)` → `"CORP-001/003.v1"`
 * - `toDocumentReference("001", 42, 2)` → `"001/042.v2"`
 */
export const toDocumentReference = (
  matterReference: string,
  docSequence: number,
  versionNumber: number,
): string => {
  const paddedSeq = String(docSequence).padStart(3, "0");
  return `${matterReference}/${paddedSeq}.v${versionNumber}`;
};
