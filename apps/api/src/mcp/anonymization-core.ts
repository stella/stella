import { panic } from "better-result";

import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonRuntime } from "@stll/anonymize-chat";
import type {
  GazetteerEntry,
  PipelineConfig,
  PipelineContext,
} from "@stll/anonymize-wasm";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

export type AnonymizeTextFieldsInput = {
  fields: string[];
  gazetteerEntries?: GazetteerEntry[] | undefined;
  /**
   * Canonicals the user has flagged as false positives. The
   * dependency loader fills this in from the allowlist table
   * when omitted, so callers that already resolved the list
   * (test seams, batch jobs) can pass it directly.
   */
  excludedCanonicals?: readonly string[] | undefined;
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
  workspaceId: string;
  /**
   * Document the text belongs to, when the caller knows it (MCP
   * search results, file-aware tool outputs). When set, the
   * allowlist loader pulls doc-scoped ignores in addition to the
   * workspace + org tiers, so a "ignore on this file" override
   * applies to server anonymization too — not just the inspector
   * overlay. Chat boundaries leave this undefined.
   */
  entityId?: SafeId<"entity"> | undefined;
  /**
   * Optional shared `PipelineContext`. When set, the placeholder
   * counter continues across calls so independent batches don't
   * collide on `[PERSON_1]`. Chat boundaries pass the same context
   * for every user-message / tool-output / system-prompt pass so
   * the cumulative redaction map stays internally consistent.
   * Omitted callers (one-shot anonymizations) get a fresh context.
   */
  context?: PipelineContext | undefined;
};

export type AnonymizeTextFieldsDependencies = ChatAnonRuntime & {
  loadAnonymizationGazetteerEntries: (input: {
    organizationId: SafeId<"organization">;
    scopedDb: ScopedDb;
  }) => Promise<GazetteerEntry[]>;
  loadAnonymizationAllowlistCanonicals: (input: {
    organizationId: SafeId<"organization">;
    /**
     * Plain string (rather than SafeId) so the production chat
     * boundary, which historically falls back to the thread id
     * when no workspace is active, can pass its anonymization
     * scope through unchanged. The loader brands the value
     * before issuing the workspace-scoped query.
     */
    scopeId?: string | undefined;
    entityId?: SafeId<"entity"> | undefined;
    scopedDb: ScopedDb;
  }) => Promise<string[]>;
  loadNameDictionaries: () => Promise<
    NonNullable<PipelineConfig["dictionaries"]>
  >;
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

export const anonymizeTextFieldsWithDependencies = async ({
  dependencies,
  fields,
  gazetteerEntries,
  excludedCanonicals,
  organizationId,
  scopedDb,
  workspaceId,
  entityId,
  context: providedContext,
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

  const context = providedContext ?? dependencies.createPipelineContext();
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
  const allowlist =
    excludedCanonicals ??
    (await dependencies.loadAnonymizationAllowlistCanonicals({
      organizationId,
      scopeId: workspaceId,
      entityId,
      scopedDb,
    }));
  const dictionaries = await dependencies.loadNameDictionaries();

  const result = await runChatAnonPipeline({
    runtime: dependencies,
    dictionaries,
    text: combinedText,
    workspaceId,
    gazetteerEntries: entries,
    excludedCanonicals: allowlist,
    context,
  });

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
