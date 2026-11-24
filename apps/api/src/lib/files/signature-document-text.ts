import type {
  SignaturePreview,
  SignedFileBinding,
} from "@stll/api-contract/signature";

import type { SignatureWorkerReply } from "@/api/lib/files/signature-preview-protocol";

type SignedFile = Extract<
  SignaturePreview,
  { type: "signature" }
>["signedFiles"][number];

const STANDARD_NAMES = { cades: "CAdES", xades: "XAdES" } as const;

const BINDING_NOTES = {
  digestMatches:
    "its stored bytes match the digest the signature states; this binds the bytes, it does not verify the signature",
  digestDiffers:
    "its stored bytes do not match the digest the signature states",
  notCompared: "matched by file name; its bytes were not compared",
} as const satisfies Record<SignedFileBinding, string>;

/** Searchable and agent-readable text for one signature file. */
export const signatureDocumentText = (
  { standard, packaging, signers, references, document }: SignatureWorkerReply,
  signedFiles: readonly SignedFile[] = [],
): string => {
  const statedNames = references.flatMap(({ fileName }) =>
    fileName === null ? [] : [fileName],
  );
  return [
    `${STANDARD_NAMES[standard]} signature, ${packaging}. Signatures are unverified.`,
    ...signers.map(
      ({ name, signedAt }, index) =>
        `Signer ${index + 1}: ${name ?? "Unknown signer"}${signedAt ? `, signing time stated as ${signedAt}` : ""}`,
    ),
    ...(statedNames.length > 0 ? [`Signs: ${statedNames.join(", ")}`] : []),
    ...signedFiles.map(
      ({ fileName, binding }) =>
        `Document in this matter: ${fileName} (${BINDING_NOTES[binding]})`,
    ),
    ...(document === null
      ? []
      : ["", document.text || "Signed document text unavailable."]),
  ].join("\n");
};
