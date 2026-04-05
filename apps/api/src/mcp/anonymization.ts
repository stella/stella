import {
  createPipelineContext,
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
  redactText,
  runPipeline,
} from "@stll/anonymize-wasm";
import type { GazetteerEntry, PipelineConfig } from "@stll/anonymize-wasm";
import { panic } from "better-result";

const EMPTY_GAZETTEER_ENTRIES: GazetteerEntry[] = [];
const FIELD_MARKER_PREFIX = "[[[__stella_mcp_anonymized_field_";
const FIELD_MARKER_SUFFIX = "__]]]";
const MAX_MARKER_NAMESPACE_ATTEMPTS = 4;

const buildPipelineConfig = (workspaceId: string): PipelineConfig => ({
  threshold: 0.4,
  enableTriggerPhrases: true,
  enableRegex: true,
  enableNameCorpus: true,
  enableDenyList: false,
  enableGazetteer: false,
  enableNer: false,
  enableConfidenceBoost: false,
  enableCoreference: true,
  labels: [...DEFAULT_ENTITY_LABELS],
  workspaceId,
});

const getFieldMarker = ({
  index,
  markerNamespace,
}: {
  index: number;
  markerNamespace: string;
}) => `${FIELD_MARKER_PREFIX}${markerNamespace}_${index}${FIELD_MARKER_SUFFIX}`;

const buildFieldMarkers = ({
  fieldCount,
  fields,
}: {
  fieldCount: number;
  fields: string[];
}) => {
  for (let attempt = 0; attempt < MAX_MARKER_NAMESPACE_ATTEMPTS; attempt += 1) {
    const markerNamespace = crypto.randomUUID();
    const markers = Array.from({ length: fieldCount }, (_, index) =>
      getFieldMarker({
        index,
        markerNamespace,
      }),
    );
    const hasCollision = markers.some((marker) =>
      fields.some((field) => field.includes(marker)),
    );

    if (!hasCollision) {
      return markers;
    }
  }

  panic("Unable to generate collision-free anonymized field markers");
};

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
  workspaceId,
}: {
  fields: string[];
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

  const entities = await runPipeline({
    fullText: combinedText,
    config: buildPipelineConfig(workspaceId),
    gazetteerEntries: EMPTY_GAZETTEER_ENTRIES,
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
