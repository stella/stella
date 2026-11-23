import { Result, type UnhandledException } from "better-result";
import type { InferOutput } from "valibot";

import { FILE_PART_KINDS, filePartId } from "@stll/api-contract/file-parts";
import type { signedDossierPreviewSchema } from "@stll/api-contract/signed-dossier";
import { SIGNED_DOSSIER_FORMATS } from "@stll/api-contract/signed-dossier-formats";

import type {
  FileScanFailedError,
  FileScanRejectedError,
} from "@/api/lib/file-scan/scan-upload";
import {
  readContainerMemberTexts,
  type ReadMemberText,
} from "@/api/lib/files/asic-preview-worker";
import { readEAktaDossier } from "@/api/lib/files/e-akta-dossier";
import {
  type SignedDossier,
  SignedDossierParseError,
} from "@/api/lib/files/signed-dossier";
import { signedDossierText } from "@/api/lib/files/signed-dossier-text";
import { readXadesZepEnvelope } from "@/api/lib/files/xades-zep-envelope";
import { readZepContainer } from "@/api/lib/files/zep-container";

type Preview = InferOutput<typeof signedDossierPreviewSchema>;

export type SignedDossierReadError =
  | SignedDossierParseError
  | FileScanFailedError
  | FileScanRejectedError
  | UnhandledException;

const readers = {
  eAkta: readEAktaDossier,
  zep: readZepContainer,
  xadesZep: readXadesZepEnvelope,
} satisfies Record<
  (typeof SIGNED_DOSSIER_FORMATS)[number]["kind"],
  (
    bytes: Uint8Array,
  ) =>
    | Result<SignedDossier, SignedDossierParseError>
    | Promise<Result<SignedDossier, SignedDossierParseError>>
>;

export const readSignedDossier = async (
  bytes: Uint8Array,
  mimeType: string,
) => {
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

const documentId = (position: number) => `document-${position}`;

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
  const { receipt, documents, signers } = parsed.value;
  // Reserve room for every name, heading and potential clipping notice.
  const layoutChars =
    signedDossierText({
      receipt,
      signers,
      documents: documents.map(({ fileName }, position) => ({
        id: documentId(position),
        fileName,
        part: null,
        status: "truncated",
        text: "",
        textFormat: "plain",
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
    receipt,
    signers,
    documents: texts.value.map(
      (
        { fileName, mediaType, sizeBytes, status, text, textFormat },
        index,
      ) => ({
        id: documentId(index),
        fileName,
        status,
        text,
        textFormat,
        // A document the container keeps opaque is never delivered.
        part:
          documents[index]?.opaque === true
            ? null
            : {
                part: filePartId({ kind: FILE_PART_KINDS.document, index }),
                fileName,
                mediaType,
                sizeBytes,
              },
      }),
    ),
  });
};
