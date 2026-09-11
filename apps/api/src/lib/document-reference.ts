import {
  VERIFICATION_CODE_ALPHABET,
  VERIFICATION_CODE_LENGTH,
} from "@stll/api-contract";

/** Rejection-sampling to avoid modulo bias (256 % 31 = 8). */
const generateCode = (): string => {
  const alphabetSize = VERIFICATION_CODE_ALPHABET.length;
  // eslint-disable-next-line no-bitwise -- bit-shift builds the rejection-sampling mask
  const mask = (1 << Math.ceil(Math.log2(alphabetSize))) - 1;
  const result: string[] = [];
  while (result.length < VERIFICATION_CODE_LENGTH) {
    const bytes = new Uint8Array(VERIFICATION_CODE_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      // eslint-disable-next-line no-bitwise -- mask random byte to the alphabet bit-width
      const idx = b & mask;
      if (idx < alphabetSize) {
        result.push(VERIFICATION_CODE_ALPHABET.at(idx) ?? "");
      }
      if (result.length === VERIFICATION_CODE_LENGTH) {
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
 * Format: `{matterRef}/{docSeq}.v{version}` →
 * `{ matterReference: "2026/001", docSequence: 15, versionNumber: 3 }`
 * produces `"2026/001/015.v3"`.
 */
type DocumentReferenceParams = {
  matterReference: string;
  docSequence: number;
  versionNumber: number;
};

export const toDocumentReference = ({
  matterReference,
  docSequence,
  versionNumber,
}: DocumentReferenceParams): string => {
  const paddedSeq = String(docSequence).padStart(3, "0");
  return `${matterReference}/${paddedSeq}.v${versionNumber}`;
};
