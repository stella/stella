import { Result, type UnhandledException } from "better-result";
import type { InferOutput } from "valibot";

import type { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { SIGNED_DOSSIER_FORMATS } from "@stll/api-contract/signed-dossier-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import {
  containerMemberMimeType,
  readContainerMemberTexts,
  type ReadMemberText,
  scanContainerMember,
} from "@/api/lib/files/asic-preview-worker";
import { readEAktaDossier } from "@/api/lib/files/e-akta-dossier";
import {
  type SignedDossier,
  SignedDossierParseError,
} from "@/api/lib/files/signed-dossier";
import { signedDossierText } from "@/api/lib/files/signed-dossier-text";
import { readZepContainer } from "@/api/lib/files/zep-container";
import { PDF_MIME_TYPE } from "@/api/mime-types";

type Preview = InferOutput<typeof signedDossierPreviewSchema>;

type SignedDossierReadError =
  | SignedDossierParseError
  | FileScanFailedError
  | FileScanRejectedError
  | UnhandledException;

const readers = {
  eAkta: readEAktaDossier,
  zep: readZepContainer,
} satisfies Record<
  (typeof SIGNED_DOSSIER_FORMATS)[number]["kind"],
  (bytes: Uint8Array) => Promise<Result<SignedDossier, SignedDossierParseError>>
>;

const readSignedDossier = async (bytes: Uint8Array, mimeType: string) => {
  const format = SIGNED_DOSSIER_FORMATS.find(
    (entry) => entry.mimeType === mimeType,
  );
  return format === undefined
    ? Result.err(
        new SignedDossierParseError({
          message: "Unknown signed container type",
          reason: "invalid",
        }),
      )
    : await readers[format.kind](bytes);
};

export const extractSignedDossierPreview = async ({
  fileBytes,
  mimeType,
  maxChars,
  readText,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
  maxChars: number;
  readText: ReadMemberText;
}): Promise<Result<Preview, SignedDossierReadError>> => {
  const parsed = await readSignedDossier(fileBytes, mimeType);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const { documents, signers } = parsed.value;
  // Reserve room for every name, heading and potential clipping notice.
  const layoutChars =
    signedDossierText({
      signers,
      documents: documents.map(({ fileName }) => ({
        fileName,
        pdf: false,
        status: "truncated",
        text: "",
      })),
    }).length + documents.length;
  const texts = await readContainerMemberTexts({
    members: documents,
    maxChars: Math.max(0, maxChars - layoutChars),
    readText,
  });
  if (texts.isErr()) {
    return Result.err(texts.error);
  }
  return Result.ok({
    signers,
    documents: texts.value.map(
      ({ fileName, mimeType: type, status, text }) => ({
        fileName,
        status,
        text,
        pdf: type === PDF_MIME_TYPE,
      }),
    ),
  });
};

/** One document's bytes, when it is a PDF that passes the upload scan. */
export const extractSignedDossierPdf = async ({
  fileBytes,
  mimeType,
  document,
}: {
  fileBytes: Uint8Array;
  mimeType: string;
  document: number;
}): Promise<Result<Uint8Array | null, SignedDossierReadError>> => {
  const parsed = await readSignedDossier(fileBytes, mimeType);
  if (parsed.isErr()) {
    return Result.err(parsed.error);
  }
  const member = Number.isSafeInteger(document)
    ? parsed.value.documents[document]
    : undefined;
  if (member === undefined || member.opaque === true) {
    return Result.ok(null);
  }
  if ((await containerMemberMimeType(member.bytes)) !== PDF_MIME_TYPE) {
    return Result.ok(null);
  }
  const scanned = await scanContainerMember(member, PDF_MIME_TYPE);
  return scanned.isErr()
    ? Result.err(scanned.error)
    : Result.ok(new Uint8Array(scanned.value.bytes));
};
