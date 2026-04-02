/**
 * Alphabet for verification codes: lowercase alphanumeric
 * excluding ambiguous characters (0, O, 1, l, I).
 * 31 chars, 10-char length = 31^10 ~ 8.2 * 10^14 combinations.
 */

const VCODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const VCODE_LENGTH = 10;

/** Rejection-sampling to avoid modulo bias (256 % 31 = 8). */
const generateCode = (): string => {
  // eslint-disable-next-line no-bitwise
  const mask = (1 << Math.ceil(Math.log2(VCODE_ALPHABET.length))) - 1;
  const result: string[] = [];
  while (result.length < VCODE_LENGTH) {
    const bytes = new Uint8Array(VCODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // eslint-disable-next-line no-bitwise
      const idx = b & mask;
      if (idx < VCODE_ALPHABET.length) {
        result.push(VCODE_ALPHABET.at(idx) ?? "");
      }
      if (result.length === VCODE_LENGTH) {
        break;
      }
    }
  }
  return result.join("");
};

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
