import { panic } from "better-result";

import type {
  GazetteerEntry,
  NativeAnonymizeBinding,
  PipelineConfig,
  PipelineContext,
  PreparedNativePipeline,
} from "@stll/anonymize";
import { runChatAnonPipeline } from "@stll/anonymize-chat";
import type { ChatAnonRuntime } from "@stll/anonymize-chat";

import type { ScopedDb } from "@/api/db/safe-db";
import type { AnonymizationGazetteerScope } from "@/api/lib/anonymization-blacklist";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { buildFieldMarkers } from "@/api/mcp/field-markers";

/**
 * Where one call's deny-list and allowlist come from.
 *
 * `database` reads both catalogs for this call's workspace through
 * `scopedDb`. `preloaded` carries them already resolved and holds no database
 * handle at all, which is how a caller anonymizing several workspaces reads
 * both catalogs once for the whole set instead of twice per workspace.
 *
 * The branches are exclusive by construction: a preloaded call cannot fall
 * back to a per-call read, and a database-backed call cannot supply half a
 * catalog and silently redact against the other half's default.
 */
export type AnonymizationCatalogSource =
  | {
      type: "database";
      /**
       * Document the text belongs to, when the caller knows it (MCP
       * search results, file-aware tool outputs). When set, the
       * allowlist loader pulls doc-scoped ignores in addition to the
       * workspace + org tiers, so a "ignore on this file" override
       * applies to server anonymization too — not just the inspector
       * overlay. Chat boundaries leave this undefined.
       */
      entityId?: SafeId<"entity"> | undefined;
      scopedDb: ScopedDb;
    }
  | {
      type: "preloaded";
      /** Canonicals the user has flagged as false positives. */
      excludedCanonicals: readonly string[];
      gazetteerEntries: GazetteerEntry[];
    };

export type AnonymizeTextFieldsInput = {
  catalogs: AnonymizationCatalogSource;
  /**
   * Optional shared `PipelineContext`. It caches prepared native
   * pipeline packages, but native placeholder numbering still starts
   * fresh per redaction call. Chat boundaries rewrite placeholders
   * after each call before merging them into their cumulative map.
   * Omitted callers (one-shot anonymizations) get a fresh context.
   */
  context?: PipelineContext | undefined;
  fields: string[];
  /** Exact identifiers or terms that must be redacted in this batch. */
  forcedSensitiveValues?: readonly string[] | undefined;
  organizationId: SafeId<"organization">;
  workspaceId: string;
};

export type AnonymizeTextFieldsDependencies = ChatAnonRuntime<
  NativeAnonymizeBinding,
  PipelineContext,
  PreparedNativePipeline
> & {
  loadAnonymizationGazetteerEntries: (input: {
    organizationId: SafeId<"organization">;
    scope: AnonymizationGazetteerScope;
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

type ResolvedAnonymizationCatalogs = {
  excludedCanonicals: readonly string[];
  gazetteerEntries: GazetteerEntry[];
};

const resolveAnonymizationCatalogs = async ({
  catalogs,
  dependencies,
  organizationId,
  workspaceId,
}: {
  catalogs: AnonymizationCatalogSource;
  dependencies: AnonymizeTextFieldsDependencies;
  organizationId: SafeId<"organization">;
  workspaceId: string;
}): Promise<ResolvedAnonymizationCatalogs> => {
  switch (catalogs.type) {
    case "preloaded":
      return {
        excludedCanonicals: catalogs.excludedCanonicals,
        gazetteerEntries: catalogs.gazetteerEntries,
      };
    case "database": {
      const entries = await dependencies.loadAnonymizationGazetteerEntries({
        organizationId,
        scope:
          workspaceId === organizationId
            ? { type: "organization" }
            : {
                type: "workspace",
                workspaceId: brandPersistedWorkspaceId(workspaceId),
              },
        scopedDb: catalogs.scopedDb,
      });
      const allowlist = await dependencies.loadAnonymizationAllowlistCanonicals(
        {
          organizationId,
          scopeId: workspaceId,
          entityId: catalogs.entityId,
          scopedDb: catalogs.scopedDb,
        },
      );
      return { excludedCanonicals: allowlist, gazetteerEntries: entries };
    }
    default: {
      catalogs satisfies never;
      return panic(
        `Unhandled anonymization catalog source: ${String(catalogs)}`,
      );
    }
  }
};

export const anonymizeTextFieldsWithDependencies = async ({
  catalogs,
  dependencies,
  fields,
  forcedSensitiveValues,
  organizationId,
  workspaceId,
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

  const { excludedCanonicals, gazetteerEntries } =
    await resolveAnonymizationCatalogs({
      catalogs,
      dependencies,
      organizationId,
      workspaceId,
    });
  const dictionaries = await dependencies.loadNameDictionaries();

  const result = await runChatAnonPipeline({
    runtime: dependencies,
    dictionaries,
    text: combinedText,
    workspaceId,
    forcedSensitiveValues,
    gazetteerEntries,
    excludedCanonicals,
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
