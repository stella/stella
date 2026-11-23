import { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import {
  ASIC_FILE_KINDS,
  E_INVOICE_KINDS,
  SIGNED_DOSSIER_KINDS,
  STRUCTURED_DOCUMENT_KINDS,
  ZIP_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";

import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  readAsicPreview,
  readSignedDossierPreview,
  readStructuredDocumentPreview,
  readZipArchivePreview,
} from "@/api/lib/files/archive-preview";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import { cadesDocumentText } from "@/api/lib/files/cades-document-text";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import { readEInvoicePreview } from "@/api/lib/files/e-invoice-preview";
import { xmlDocumentPreviewText } from "@/api/lib/files/e-invoice-text";
import type { LegalFileReadOptions } from "@/api/lib/files/legal-file-source";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";
import { signedDossierText } from "@/api/lib/files/signed-dossier-text";
import { zipArchiveText } from "@/api/lib/files/zip-archive-text";
import { LIMITS } from "@/api/lib/limits";

type LegalContentReader = (options: LegalFileReadOptions) => Promise<
  Result<
    {
      text: string;
      attachments: { entityId: SafeId<"entity">; position: number }[];
    },
    HandlerError
  >
>;

const readAsicContent: LegalContentReader = async (options) => {
  const read = await readLegalFilePreview(
    options,
    ASIC_FILE_KINDS,
    readAsicPreview,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return Result.ok({ text: asicDocumentText(read.value), attachments: [] });
};

const readSignedDossierContent: LegalContentReader = async (options) => {
  const read = await readLegalFilePreview(
    options,
    SIGNED_DOSSIER_KINDS,
    readSignedDossierPreview,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return Result.ok({ text: signedDossierText(read.value), attachments: [] });
};

const readStructuredDocumentContent: LegalContentReader = async (options) => {
  const read = await readLegalFilePreview(
    options,
    STRUCTURED_DOCUMENT_KINDS,
    readStructuredDocumentPreview,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  const { text, truncated } = read.value;
  return Result.ok({
    text: truncated ? `${text}\nDocument text was truncated.` : text,
    attachments: [],
  });
};

const readEInvoiceContent: LegalContentReader = async (options) => {
  const read = await readLegalFilePreview(
    options,
    E_INVOICE_KINDS,
    readEInvoicePreview,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return Result.ok({
    text: xmlDocumentPreviewText(read.value),
    attachments: [],
  });
};

const readZipArchiveContent: LegalContentReader = async (options) => {
  const read = await readLegalFilePreview(
    options,
    [ZIP_FILE_FORMAT.kind],
    readZipArchivePreview,
  );
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return Result.ok({
    text: zipArchiveText({
      files: read.value.files,
      maxChars: LIMITS.extractedContentMaxChars,
    }),
    attachments: [],
  });
};

export const LEGAL_FILE_READERS = {
  isdoc: readEInvoiceContent,
  isdocx: readEInvoiceContent,
  xml: readEInvoiceContent,
  ofd: readStructuredDocumentContent,
  uyap: readStructuredDocumentContent,
  asicE: readAsicContent,
  asicS: readAsicContent,
  eAkta: readSignedDossierContent,
  zep: readSignedDossierContent,
  xadesZep: readSignedDossierContent,
  zip: readZipArchiveContent,
  cades: async (options) => {
    const read = await readLegalFilePreview(
      options,
      ["cades"],
      readCadesPreview,
    );
    if (read.isErr()) {
      return Result.err(read.error);
    }
    return Result.ok({ text: cadesDocumentText(read.value), attachments: [] });
  },
  dataBox: async (options) => {
    const read = await readDataBoxFile(options);
    if (read.isErr()) {
      return Result.err(read.error);
    }
    const file = read.value;
    return Result.ok({
      text: file.text,
      attachments:
        file.kind === "message"
          ? file.files.flatMap(({ entityId }, index) =>
              entityId === null ? [] : [{ position: index + 1, entityId }],
            )
          : [],
    });
  },
} satisfies Record<LegalFileFormatKind, LegalContentReader>;
