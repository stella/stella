import { Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

import type { ContainerMember } from "@/api/lib/files/asic-preview-worker";
import type { XadesSigner } from "@/api/lib/files/xades-signers";

export class SignedDossierParseError extends TaggedError(
  "SignedDossierParseError",
)<{
  message: string;
  reason: "invalid" | "limit";
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

export const invalidDossier = (message: string) =>
  Result.err(new SignedDossierParseError({ message, reason: "invalid" }));

export const dossierLimit = (message: string) =>
  Result.err(new SignedDossierParseError({ message, reason: "limit" }));

/** Like the ZIP reader's entry count, so neither form holds more documents. */
export const MAX_DOSSIER_DOCUMENTS = 1000;
export const MAX_DOSSIER_SIGNATURES = 1000;
const MAX_DOCUMENT_NAME_LENGTH = 255;

/** A parsed container: its documents in order and its stated signers. */
export type SignedDossier = {
  /** A delivery receipt acknowledges a dossier rather than being one. */
  receipt: boolean;
  documents: ContainerMember[];
  signers: XadesSigner[];
};

/**
 * A document's display name from a stated title, kept to one bounded line. A
 * missing title becomes the document's position, with its stated extension.
 */
export const dossierDocumentName = (
  title: string | undefined,
  position: number,
  extension?: string,
) => {
  const line = Array.from(title ?? "", (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? " " : character;
  })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_DOCUMENT_NAME_LENGTH);
  const suffix =
    extension !== undefined && /^[a-z0-9]{1,8}$/iu.test(extension)
      ? `.${extension.toLowerCase()}`
      : "";
  if (!line) {
    return `document-${position + 1}${suffix}`;
  }
  return suffix && !line.toLowerCase().endsWith(suffix)
    ? `${line}${suffix}`
    : line;
};
