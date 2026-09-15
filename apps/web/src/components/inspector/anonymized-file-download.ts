import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import { fetchPrintPdf } from "@/components/pdf/peek/peek-pdf-print";
import { PDF_MIME_TYPE } from "@/consts";
import { detectFileAnonymizationTerms } from "@/lib/anonymize/file-anonymization-policy";
import { ClientOperationError } from "@/lib/errors/client";
import { rasterizeAnonymizedPdf } from "@/lib/pdf/anonymized-export";
import {
  buildAnonymizedExportMasks,
  extractAnonymizedExportText,
} from "@/lib/pdf/anonymized-export.logic";
import { downloadFile } from "@/lib/utils";

type DownloadAnonymizedFileOptions = {
  workspaceId: string;
  fieldId: string;
  entityId: string | null;
  queryClient: QueryClient;
};

export const downloadAnonymizedFile = async ({
  workspaceId,
  fieldId,
  entityId,
  queryClient,
}: DownloadAnonymizedFileOptions) =>
  await Result.tryPromise({
    try: async () => {
      const [buffer, { PDF }] = await Promise.all([
        fetchPrintPdf({ workspaceId, fieldId }),
        import("@libpdf/core"),
      ]);
      const source = await PDF.load(new Uint8Array(buffer));
      const extraction = extractAnonymizedExportText(source.getPages());
      if (!extraction.text.trim()) {
        return Result.err(
          new ClientOperationError({
            action: "anonymized-export",
            message: "The file has no readable text to anonymize",
          }),
        );
      }
      const detectedTerms = await detectFileAnonymizationTerms({
        text: extraction.text,
        workspaceId,
        entityId,
        queryClient,
      });
      const terms = detectedTerms.map(({ text }) => text);
      const masks = buildAnonymizedExportMasks({ extraction, terms });
      if (masks.isErr()) {
        return masks;
      }
      const exported = await rasterizeAnonymizedPdf(buffer, masks.value);
      if (exported.isErr()) {
        return exported;
      }
      downloadFile(
        new Blob([Uint8Array.from(exported.value)], { type: PDF_MIME_TYPE }),
        "anonymized.pdf",
      );
      return Result.ok();
    },
    catch: (cause) =>
      new ClientOperationError({
        action: "anonymized-export",
        message: "The anonymized PDF could not be prepared",
        cause,
      }),
  }).then((result) => (result.isErr() ? result : result.value));
