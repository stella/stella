import { panic } from "better-result";

import {
  DEFAULT_ENTITY_LABELS,
  DEFAULT_OPERATOR_CONFIG,
} from "@stll/anonymize-wasm";
import type {
  Entity,
  GazetteerEntry,
  PipelineConfig,
  PipelineContext,
  RedactionResult,
} from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

export type AnonymizeTextFieldsInput = {
  fields: string[];
  gazetteerEntries?: GazetteerEntry[] | undefined;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  workspaceId: string;
};

export type AnonymizeTextFieldsDependencies = {
  createPipelineContext: () => PipelineContext;
  loadAnonymizationGazetteerEntries: (input: {
    organizationId: SafeId<"organization">;
    scopedDb: ScopedDb;
  }) => Promise<GazetteerEntry[]>;
  loadNameDictionaries: () => Promise<
    NonNullable<PipelineConfig["dictionaries"]>
  >;
  redactText: (
    fullText: string,
    entities: Entity[],
    operatorConfig: typeof DEFAULT_OPERATOR_CONFIG,
    context: PipelineContext,
  ) => RedactionResult;
  runPipeline: (input: {
    fullText: string;
    config: PipelineConfig;
    gazetteerEntries: GazetteerEntry[];
    context: PipelineContext;
  }) => Promise<Entity[]>;
};

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

export const anonymizeTextFieldsWithDependencies = async ({
  dependencies,
  fields,
  gazetteerEntries,
  organizationId,
  scopedDb,
  workspaceId,
}: AnonymizeTextFieldsInput & {
  dependencies: AnonymizeTextFieldsDependencies;
}) => {
  if (fields.every((field) => field.length === 0)) {
    return {
      entityCount: 0,
      fields,
      redactionMap: new Map<string, string>(),
    };
  }

  const context = dependencies.createPipelineContext();
  const markers = buildFieldMarkers({
    fieldCount: fields.length,
    fields,
  });
  const combinedText = fields
    .map((field, index) => `${markers[index]}${field}`)
    .join("");

  const entries =
    gazetteerEntries ??
    (await dependencies.loadAnonymizationGazetteerEntries({
      organizationId,
      scopedDb,
    }));
  const dictionaries = await dependencies.loadNameDictionaries();

  const entities = await dependencies.runPipeline({
    fullText: combinedText,
    config: {
      ...buildPipelineConfig({ gazetteerEntries: entries, workspaceId }),
      dictionaries,
    },
    gazetteerEntries: entries,
    context,
  });
  const result = dependencies.redactText(
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
    /** Placeholder → original. Empty for fully-redacted (non-reversible) operators. */
    redactionMap: result.redactionMap,
  };
};
