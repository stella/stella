import { useQuery, type QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";

import { useInspectorAnonymizationStore } from "@/components/inspector/inspector-anonymization-store";
import {
  createPipelineRunRegistry,
  type PipelineRun,
} from "@/components/inspector/pipeline-run-registry.logic";
import { fetchPrintPdf } from "@/components/pdf/peek/peek-pdf-print";
import { getAnalytics } from "@/lib/analytics/provider";
import {
  findFileAnonymizationMatches,
  normalizeWhitespaceWithOffsets,
} from "@/lib/anonymize/file-anonymization-matches.logic";
import { detectFileAnonymizationTerms } from "@/lib/anonymize/file-anonymization-policy";
import { extractPDFText } from "@/lib/anonymize/pdf-coords";
import { ClientOperationError } from "@/lib/errors/client";
import {
  allocateEntityOverlayId,
  clearAnonymizationForField,
  commitAnonymizationForField,
} from "@/lib/pdf/anonymization-cache";
import { buildPerPage, getEntitySpans } from "@/lib/pdf/anonymization-helpers";
import type {
  EntityOverlay,
  FileAnonymization,
} from "@/lib/pdf/anonymization-types";
import { loadLibPdf } from "@/lib/pdf/libpdf-loader";
import { anonymizationAllowlistOptions } from "@/lib/workspaces/queries/anonymization-allowlist";
import { anonymizationTermsOptions } from "@/lib/workspaces/queries/anonymization-terms";

const pipelineRuns = createPipelineRunRegistry();
const anonymizePdf = async ({
  workspaceId,
  fieldId,
  entityId,
  queryClient,
}: {
  workspaceId: string;
  fieldId: string;
  entityId: string | null;
  queryClient: QueryClient;
}): Promise<void> => {
  const run = pipelineRuns.start(fieldId);
  // Tell the inspector facet a producer is in flight so
  // it shows "Detecting entities…" while the wasm pipeline
  // runs. Mirrored on every terminal exit below.
  useInspectorAnonymizationStore
    .getState()
    .markAnonymizationPipelineStarted(fieldId);
  const result = await Result.tryPromise(async () => {
    await runPipelineAndCommit({
      workspaceId,
      fieldId,
      entityId,
      queryClient,
      run,
    });
  });
  if (pipelineRuns.canCommit(fieldId, run)) {
    if (Result.isError(result)) {
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineFailed(fieldId);
    } else {
      useInspectorAnonymizationStore
        .getState()
        .markAnonymizationPipelineRan(fieldId);
    }
  }
  // Release ownership before propagating an error. A cancelled run cannot
  // overwrite a successor's status, and no failure can leave this field locked.
  pipelineRuns.finish(fieldId, run);
  if (Result.isError(result)) {
    await Promise.reject(result.error);
  }
};

export const useFileAnonymizationPipeline = ({
  enabled,
  fieldId,
  mimeType,
  workspaceId,
  entityId,
}: {
  enabled: boolean;
  fieldId: string;
  mimeType?: string | undefined;
  workspaceId: string;
  entityId: string | null;
}): void => {
  const retry = useInspectorAnonymizationStore(
    (state) => state.anonymizationRetryByFieldId[fieldId] ?? 0,
  );
  const pipelineStatus = useInspectorAnonymizationStore(
    (state) => state.anonymizationPipelineStatusByFieldId[fieldId] ?? "idle",
  );
  const normalizedMimeType = mimeType ?? null;
  const vocabularyQuery = useQuery({
    ...anonymizationTermsOptions(workspaceId),
    enabled,
  });
  const allowlistQuery = useQuery({
    ...anonymizationAllowlistOptions({ workspaceId, entityId }),
    enabled,
  });
  useQuery({
    enabled:
      enabled &&
      pipelineStatus !== "error" &&
      !vocabularyQuery.isPending &&
      !allowlistQuery.isPending,
    queryFn: async ({ client: queryClient }) => {
      const result = await Result.tryPromise(async () => {
        await anonymizePdf({
          workspaceId,
          fieldId,
          entityId,
          queryClient,
        });
      });
      if (Result.isError(result)) {
        getAnalytics().captureError(result.error);
        await Promise.reject(result.error);
      }
      return "complete" as const;
    },
    queryKey: [
      "file-anonymization",
      {
        fieldId,
        entityId,
        mimeType: normalizedMimeType,
        retry,
        workspaceId,
        vocabulary: vocabularyQuery.data,
        exclusions: allowlistQuery.data,
      },
    ],
    staleTime: Infinity,
    retryOnMount: false,
    retry: false,
  });
};

const runPipelineAndCommit = async ({
  workspaceId,
  fieldId,
  entityId,
  queryClient,
  run,
}: {
  workspaceId: string;
  fieldId: string;
  entityId: string | null;
  queryClient: QueryClient;
  run: PipelineRun;
}): Promise<void> => {
  const [buffer, { PDF }] = await Promise.all([
    fetchPrintPdf({ workspaceId, fieldId }),
    loadLibPdf(),
  ]);
  const pdf = await PDF.load(new Uint8Array(buffer));
  const { text, spans: charSpans } = extractPDFText(pdf);
  if (!text.trim()) {
    await Promise.reject(
      new ClientOperationError({
        action: "anonymizePdf",
        message: "The file has no readable text to anonymize",
      }),
    );
    return;
  }
  const terms = await detectFileAnonymizationTerms({
    text,
    workspaceId,
    entityId,
    queryClient,
  });
  const normalizedText = normalizeWhitespaceWithOffsets(text);
  const overlayEntities: EntityOverlay[] = [];
  const seenRanges = new Set<string>();
  for (const term of terms) {
    for (const { start, end } of findFileAnonymizationMatches(
      normalizedText,
      term.text,
    )) {
      const key = `${start}:${end}`;
      if (seenRanges.has(key)) {
        continue;
      }
      seenRanges.add(key);
      const spans = getEntitySpans({
        charSpans,
        entityStart: start,
        entityEnd: end,
      });
      if (spans.length === 0) {
        continue;
      }
      overlayEntities.push({
        id: allocateEntityOverlayId(),
        label: term.label,
        text: term.text,
        spans,
      });
    }
  }

  if (!pipelineRuns.canCommit(fieldId, run)) {
    return;
  }

  const perPage = buildPerPage(overlayEntities);

  const data: FileAnonymization = {
    entities: overlayEntities,
    perPage,
    extractedText: text,
    charSpans,
  };

  commitAnonymizationForField(fieldId, data);
  // Mirror the detection result into the inspector
  // matches store. The DOCX path publishes via Folio's
  // plugin on every transaction; the PDF path runs
  // once-per-document, so we publish here for the
  // count badge. The "started/ran" lifecycle bookkeeping
  // lives in the wrapping `anonymizePdf` so the facet
  // exits the "Detecting…" state on errors too.
  const countByCanonical = new Map<string, number>();
  const labelByCanonical = new Map<string, string>();
  let totalMatches = 0;
  for (const overlay of overlayEntities) {
    const canonical = overlay.text;
    countByCanonical.set(canonical, (countByCanonical.get(canonical) ?? 0) + 1);
    if (!labelByCanonical.has(canonical)) {
      labelByCanonical.set(canonical, overlay.label);
    }
    totalMatches += 1;
  }
  useInspectorAnonymizationStore
    .getState()
    .publishAnonymizationMatches(fieldId, {
      totalMatches,
      countByCanonical,
      labelByCanonical,
    });
};

export const clearAnonymization = (fieldId: string): void => {
  pipelineRuns.cancel(fieldId);
  clearAnonymizationForField(fieldId);
  // Also drop the matches-store entry for this field so
  // the inspector facet stops showing a stale count when
  // the user navigates away mid-detection. Idempotent for
  // fields that were never published.
  useInspectorAnonymizationStore.getState().clearAnonymizationMatches(fieldId);
};
