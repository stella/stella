import { panic, Result } from "better-result";

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
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";
import { joinFieldsForAnonymization } from "@/api/mcp/field-markers";
import type { AnonymizedFieldBoundaryError } from "@/api/mcp/field-markers";

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
type AnonymizationCatalogSource =
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

export type AnonymizedTextFields = {
  entityCount: number;
  /** One entry per input field, in input order. */
  fields: string[];
  /** Placeholder → original. Empty for fully-redacted (non-reversible) operators. */
  redactionMap: Map<string, string>;
};

/**
 * Anonymize `fields` in one pipeline call. Output whose field structure did
 * not survive the pipeline is an `AnonymizedFieldBoundaryError`; callers must
 * refuse it and forward none of the fields.
 */
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
}): Promise<Result<AnonymizedTextFields, AnonymizedFieldBoundaryError>> => {
  if (fields.every((field) => field.length === 0)) {
    return Result.ok({
      entityCount: 0,
      fields,
      redactionMap: new Map<string, string>(),
    });
  }

  const context = providedContext ?? dependencies.createPipelineContext();
  const { excludedCanonicals, gazetteerEntries } =
    await resolveAnonymizationCatalogs({
      catalogs,
      dependencies,
      organizationId,
      workspaceId,
    });
  const joined = joinFieldsForAnonymization({
    fields,
    reservedValues: [
      ...arrayOrEmpty(forcedSensitiveValues),
      ...gazetteerEntries.flatMap((entry) => [
        entry.canonical,
        ...entry.variants,
      ]),
    ],
  });
  if (Result.isError(joined)) {
    return Result.err(joined.error);
  }
  const dictionaries = await dependencies.loadNameDictionaries();

  const result = await runChatAnonPipeline({
    runtime: dependencies,
    dictionaries,
    text: joined.value.text,
    workspaceId,
    forcedSensitiveValues,
    gazetteerEntries,
    excludedCanonicals,
    context,
  });

  // Fail closed: when the field boundaries did not come back intact, no field
  // is returned, so callers forward nothing.
  const redactedFields = joined.value.split(result.redactedText);
  if (Result.isError(redactedFields)) {
    return Result.err(redactedFields.error);
  }

  return Result.ok({
    entityCount: result.entityCount,
    fields: redactedFields.value,
    redactionMap: result.redactionMap,
  });
};
