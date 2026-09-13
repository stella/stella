import {
  createNativePipelineFromConfig,
  createPipelineContext,
  loadNativeAnonymizeBinding,
  type NativePipelineEntity,
  type PipelineConfig,
} from "@stll/anonymize";
import { buildChatAnonPipelineConfig } from "@stll/anonymize-chat";
import { loadNameDictionaries } from "@stll/anonymize-data";
import type { PdfRasterDetection } from "@stll/anonymize-pdf";

import type { ScopedDb } from "@/api/db/safe-db";
import { loadAnonymizationAllowlistCanonicals } from "@/api/lib/anonymization-allowlist";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { SafeId } from "@/api/lib/branded-types";
import type { DocumentOcrPage } from "@/api/lib/document-processing-contract";
import { pdfAnonymizationObservation } from "@/api/lib/pdf-anonymization/observation";

let dictionariesPromise: Promise<
  NonNullable<PipelineConfig["dictionaries"]>
> | null = null;
let detectionQueue: Promise<void> = Promise.resolve();

const getDictionaries = async () => {
  dictionariesPromise ??= loadNameDictionaries();
  return await dictionariesPromise;
};

const normalizeCanonical = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/gu, " ").trim();

export const selectPdfAnonymizationDetections = ({
  entities,
  excludedCanonicals,
}: {
  entities: readonly NativePipelineEntity[];
  excludedCanonicals: readonly string[];
}): PdfRasterDetection[] => {
  const excluded = new Set(excludedCanonicals.map(normalizeCanonical));
  return entities
    .filter(({ text }) => !excluded.has(normalizeCanonical(text)))
    .map(({ start, end }) => ({ start, end }));
};

const runSerialized = async <T>(task: () => Promise<T>): Promise<T> => {
  const run = detectionQueue.then(task, task);
  detectionQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return await run;
};

export const detectPdfAnonymizationPages = async ({
  entityId,
  organizationId,
  pages,
  scopedDb,
  workspaceId,
}: {
  entityId: SafeId<"entity">;
  organizationId: SafeId<"organization">;
  pages: readonly DocumentOcrPage[];
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
}): Promise<readonly PdfRasterDetection[][]> => {
  const [gazetteerEntries, excludedCanonicals, dictionaries] =
    await Promise.all([
      loadAnonymizationGazetteerEntries({
        organizationId,
        scope: { type: "workspace", workspaceId },
        scopedDb,
      }),
      loadAnonymizationAllowlistCanonicals({
        organizationId,
        scopeId: workspaceId,
        entityId,
        scopedDb,
      }),
      getDictionaries(),
    ]);

  return await runSerialized(async () => {
    const context = createPipelineContext();
    const config = {
      ...buildChatAnonPipelineConfig({
        hasGazetteer: gazetteerEntries.length > 0,
        workspaceId,
      }),
      dictionaries,
    };
    const pipeline = await createNativePipelineFromConfig({
      binding: loadNativeAnonymizeBinding(),
      config,
      context,
      gazetteerEntries,
    });
    return pages.map((page, pageIndex) => {
      const observation = pdfAnonymizationObservation({ page, pageIndex });
      return selectPdfAnonymizationDetections({
        entities: pipeline.redactText(observation.text).resolvedEntities,
        excludedCanonicals,
      });
    });
  });
};
