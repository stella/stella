import { Result } from "better-result";

import {
  type LegalFileFormatKind,
  SIGNATURE_FILE_KINDS,
  type SignatureFileFormatKind,
} from "@stll/api-contract/legal-file-formats";
import type { SignaturePreview } from "@stll/api-contract/signature";

import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  type LegalFileReadOptions,
  loadLegalFileSource,
} from "@/api/lib/files/legal-file-source";
import { findSignedFiles } from "@/api/lib/files/signature-pairing";
import {
  readSignaturePdf,
  readSignatureWorkerReply,
  signatureUnreadable,
} from "@/api/lib/files/signature-preview";
import type { SignatureWorkerReply } from "@/api/lib/files/signature-preview-protocol";

type SignatureRead = Extract<SignaturePreview, { type: "signature" }>;

const isSignatureKind = (
  kind: LegalFileFormatKind,
): kind is SignatureFileFormatKind =>
  SIGNATURE_FILE_KINDS.some((signatureKind) => signatureKind === kind);

const NOT_SIGNATURE = { type: "notSignature" } as const;

const previewOf = (
  { standard, packaging, signers, references, document }: SignatureWorkerReply,
  signedFiles: SignatureRead["signedFiles"],
): SignatureRead => ({
  type: "signature",
  standard,
  packaging,
  signers,
  statedFileNames: [
    ...new Set(
      references.flatMap(({ fileName }) =>
        fileName === null ? [] : [fileName],
      ),
    ),
  ],
  signedFiles,
  document,
});

/**
 * One signature file as its reader sees it, with the documents in the same
 * matter it appears to sign. A `.sig` or `.xml` file whose bytes are not a
 * signature answers `notSignature`, and nothing is delivered or audited.
 */
export const readSignatureFile = async (
  options: LegalFileReadOptions,
): Promise<
  Result<
    | { preview: SignatureRead; reply: SignatureWorkerReply }
    | typeof NOT_SIGNATURE,
    HandlerError
  >
> => {
  const loaded = await loadLegalFileSource(options, SIGNATURE_FILE_KINDS);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, mimeType, kind, sniffed, entityId, fileName, deliver } =
    loaded.value;
  if (!isSignatureKind(kind)) {
    return Result.err(signatureUnreadable());
  }
  const reply = await readSignatureWorkerReply(
    source.withMimeType(mimeType),
    kind,
  );
  if (reply.isErr()) {
    return Result.err(reply.error);
  }
  if (reply.value === null) {
    return sniffed
      ? Result.ok(NOT_SIGNATURE)
      : Result.err(signatureUnreadable());
  }
  const signature = reply.value;
  const signedFiles =
    signature.packaging === "detached"
      ? await findSignedFiles({
          scopedDb: options.scopedDb,
          workspaceId: options.workspaceId,
          organizationId: options.organizationId,
          signatureEntityId: entityId,
          signatureFileName: fileName,
          references: signature.references,
        })
      : [];
  const preview = previewOf(signature, signedFiles);
  return await deliver(() => Result.ok({ preview, reply: signature }));
};

/** The PDF an enveloping signature carries. */
export const readSignatureFilePdf = async (
  options: LegalFileReadOptions,
): Promise<Result<Uint8Array, HandlerError>> => {
  const loaded = await loadLegalFileSource(options, SIGNATURE_FILE_KINDS);
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { source, mimeType, kind, deliver } = loaded.value;
  if (!isSignatureKind(kind)) {
    return Result.err(signatureUnreadable());
  }
  const pdf = await readSignaturePdf(source.withMimeType(mimeType), kind);
  if (pdf.isErr()) {
    return Result.err(pdf.error);
  }
  return await deliver(() => pdf);
};
