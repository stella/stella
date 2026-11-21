import { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import {
  ASIC_FILE_KINDS,
  STRUCTURED_DOCUMENT_KINDS,
} from "@stll/api-contract/legal-file-formats";

import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  readAsicPreview,
  readStructuredDocumentPreview,
} from "@/api/lib/files/archive-preview";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import { cadesDocumentText } from "@/api/lib/files/cades-document-text";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import type { LegalFileReadOptions } from "@/api/lib/files/legal-file-source";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";
import { readSignatureFile } from "@/api/lib/files/read-signature-file";
import { signatureDocumentText } from "@/api/lib/files/signature-document-text";

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

/**
 * A signature file's text, or null for a `.sig` or `.xml` file whose bytes
 * are not a signature: that file is read the way it would be otherwise.
 */
const readSignatureContent = async (
  options: LegalFileReadOptions,
): Promise<
  Result<
    {
      text: string;
      attachments: { entityId: SafeId<"entity">; position: number }[];
    } | null,
    HandlerError
  >
> => {
  const read = await readSignatureFile(options);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  if ("type" in read.value) {
    return Result.ok(null);
  }
  const { preview, reply } = read.value;
  return Result.ok({
    text: signatureDocumentText(reply, preview.signedFiles),
    attachments: [],
  });
};

const readNamedSignatureContent: LegalContentReader = async (options) => {
  const read = await readSignatureContent(options);
  if (read.isErr()) {
    return Result.err(read.error);
  }
  return Result.ok(read.value ?? { text: "", attachments: [] });
};

export const LEGAL_FILE_READERS = {
  ofd: readStructuredDocumentContent,
  uyap: readStructuredDocumentContent,
  asicE: readAsicContent,
  asicS: readAsicContent,
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
  cadesDetached: readNamedSignatureContent,
  xades: readNamedSignatureContent,
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
