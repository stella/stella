import { Result } from "better-result";

import type { LegalFileFormatKind } from "@stll/api-contract/legal-file-formats";
import { ASIC_FILE_KINDS } from "@stll/api-contract/legal-file-formats";

import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asicDocumentText } from "@/api/lib/files/asic-document-text";
import { readAsicPreview } from "@/api/lib/files/asic-preview";
import { cadesDocumentText } from "@/api/lib/files/cades-document-text";
import { readCadesPreview } from "@/api/lib/files/cades-preview";
import type { LegalFileReadOptions } from "@/api/lib/files/legal-file-source";
import { readDataBoxFile } from "@/api/lib/files/read-data-box-file";
import { readLegalFilePreview } from "@/api/lib/files/read-legal-file-preview";

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

export const LEGAL_FILE_READERS = {
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
