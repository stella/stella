import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";
import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";
import { panic } from "better-result";

import type { ScopedDb } from "@/api/db";
import { loadAnonymizationGazetteerEntries } from "@/api/lib/anonymization-blacklist";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

const buildPipelineConfig = ({
  gazetteerEntries,
  workspaceId,
}: {
  gazetteerEntries: GazetteerEntry[];
  workspaceId: string;
}): PipelineConfig => ({
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: gazetteerEntries.length > 0,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  enableLegalForms: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});

const splitRedactedFields = ({
  markers,
  redactedText,
}: {
  markers: string[];
  redactedText: string;
}): string[] => {
  const fields: string[] = [];
  let searchStart = 0;

  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker === undefined) {
      panic(`Missing anonymized field marker at index ${index}`);
    }

    const markerStart = redactedText.indexOf(marker, searchStart);
    if (markerStart === -1) {
      panic(`Missing anonymized field marker at index ${index}`);
    }

    const nextMarker = markers[index + 1];
    const contentStart = markerStart + marker.length;
    const contentEnd =
      nextMarker === undefined
        ? redactedText.length
        : redactedText.indexOf(nextMarker, contentStart);

    if (contentEnd === -1) {
      panic(`Missing anonymized field boundary at index ${index}`);
    }

    fields.push(redactedText.slice(contentStart, contentEnd));
    searchStart = contentEnd;
  }

  return fields;
};

export const anonymizeTextFields = async ({
  fields,
  organizationId,
  scopedDb,
  workspaceId,
}: {
  fields: string[];
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  workspaceId: string;
}) => {
  if (fields.every((field) => field.length === 0)) {
    return {
      entityCount: 0,
      fields,
    };
  }

  const context = createPipelineContext();
  const markers = buildFieldMarkers({
    fieldCount: fields.length,
    fields,
  });
  const combinedText = fields
    .map((field, index) => `${markers[index]}${field}`)
    .join("");

  const gazetteerEntries = await loadAnonymizationGazetteerEntries({
    organizationId,
    scopedDb,
  });

  const entities = await runPipeline({
    fullText: combinedText,
    config: buildPipelineConfig({ gazetteerEntries, workspaceId }),
    gazetteerEntries,
    context,
  });
  const result = redactText(
    combinedText,
    entities,
    DEFAULT_OPERATOR_CONFIG,
    context,
  );

  return {
    entityCount: result.entityCount,
    fields: splitRedactedFields({
      markers,
      redactedText: result.redactedText,
    }),
  };
};
