import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import { normalizeForExclusion } from "@stll/anonymize-chat/normalization";

import { fetchPrintPdf } from "@/components/pdf/peek/peek-pdf-print";
import { PDF_MIME_TYPE } from "@/consts";
import { anonymizeChatTextInWorker } from "@/lib/anonymize/anonymize-chat-worker-client";
import { ClientOperationError } from "@/lib/errors/client";
import { rasterizeAnonymizedPdf } from "@/lib/pdf/anonymized-export";
import {
  buildAnonymizedExportMasks,
  extractAnonymizedExportText,
} from "@/lib/pdf/anonymized-export.logic";
import { downloadFile } from "@/lib/utils";
import { anonymizationAllowlistOptions } from "@/lib/workspaces/queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/lib/workspaces/queries/anonymization-terms";

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
      const [buffer, vocabulary, allowlist, { PDF }] = await Promise.all([
        fetchPrintPdf({ workspaceId, fieldId }),
        queryClient.query(anonymizationTermsOptions(workspaceId)),
        queryClient.query(
          anonymizationAllowlistOptions({ workspaceId, entityId }),
        ),
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
      const excludedCanonicals = allowlist.entries.map(
        ({ canonical }) => canonical,
      );
      const detected = await anonymizeChatTextInWorker({
        workspaceId,
        text: extraction.text,
        excludedCanonicals,
      });
      const excluded = new Set(excludedCanonicals.map(normalizeForExclusion));
      const terms = detected.pairs.map(({ original }) => original);
      for (const entry of vocabulary.entries) {
        if (
          entry.enabled &&
          !excluded.has(normalizeForExclusion(entry.canonical))
        ) {
          terms.push(entry.canonical, ...entry.variants);
        }
      }
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
  }).then(Result.flatten);
