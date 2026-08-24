import { panic } from "better-result";

import {
  GLOBAL_SEARCH_RESULT_TYPES,
  isEntityKind,
  type GlobalSearchResultType,
  type ResourceName,
  type ResourceRef,
} from "@stll/api-contract";
import type { DecisionIdentifiers } from "@stll/legal-ast/decision-identifier";

import type { ContactType } from "@/api/db/schema";
import type { EntityKind, FieldContent } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

/** Narrow an unknown value to a valid EntityKind. Internal callers read
 *  kinds straight off our own rows, so a miss is a broken invariant, not a
 *  user input error. */
export const parseEntityKind = (value: unknown): EntityKind => {
  if (!isEntityKind(value)) {
    panic(`Invalid entity kind: ${String(value)}`);
  }
  return value;
};

/**
 * The file the extraction pipeline reads text from for an entity's current
 * version. By default this is the first field (in field order) whose content
 * is a file. A caller that just replaced a known file property may pin that
 * property so extraction cannot silently select a sibling file instead.
 * Shared by `processExtraction` (which writes `extractedContent`) and any
 * reader that must resolve to the SAME default source file `extractedContent`
 * was produced from.
 *
 * CONTRACT: `fields` must arrive pre-sorted into a stable, deterministic
 * order -- this function does not sort. The `fields` table has no
 * `createdAt`/position column, so every caller loading this relation MUST
 * apply `orderBy: { id: "asc" }` (field ids are `Bun.randomUUIDv7()`, so
 * ascending id order is ascending creation order). Without an explicit
 * `orderBy`, Postgres/Drizzle give no ordering guarantee, and two callers
 * could observe different "first" fields for the same version.
 */
export const findExtractionFileFieldRow = <
  T extends {
    content: FieldContent;
    propertyId?: SafeId<"property"> | undefined;
  },
>(
  fields: readonly T[],
  filePropertyId?: SafeId<"property">,
): T | null => {
  for (const field of fields) {
    if (
      field.content.type === "file" &&
      (filePropertyId === undefined || field.propertyId === filePropertyId)
    ) {
      return field;
    }
  }
  return null;
};

export const findExtractionFileField = (
  fields: readonly {
    content: FieldContent;
    propertyId?: SafeId<"property"> | undefined;
  }[],
  filePropertyId?: SafeId<"property">,
): Extract<FieldContent, { type: "file" }> | null => {
  const field = findExtractionFileFieldRow(fields, filePropertyId);
  return field?.content.type === "file" ? field.content : null;
};

type SearchQueryBase = {
  query: string;
  organizationId: SafeId<"organization">;
  kinds?: EntityKind[] | undefined;
  cursor?: string | undefined;
  limit: number;
};

export type SearchQuery = SearchQueryBase &
  (
    | {
        /** Caller-visible workspace allowlist. Empty means no workspaces. */
        workspaceIds: readonly SafeId<"workspace">[];
        workspaceId?: SafeId<"workspace"> | undefined;
      }
    | {
        /** Single workspace that has already been authorized for the caller. */
        workspaceId: SafeId<"workspace">;
        workspaceIds?: undefined;
      }
  );

export const assertAuthorizedSearchScope = ({
  workspaceId,
  workspaceIds,
}: {
  workspaceId?: unknown;
  workspaceIds?: unknown;
}) => {
  if (Array.isArray(workspaceIds)) {
    return;
  }

  if (typeof workspaceId === "string" && workspaceId.length > 0) {
    return;
  }

  panic("Search queries must include an authorized workspace scope");
};

export type SearchHit = {
  entityId: string;
  workspaceId: string;
  workspaceName: string;
  kind: EntityKind;
  title: string;
  headline: string | null;
  updatedAt: string;
};

export type FacetBucket = {
  value: string;
  label?: string;
  count: number;
};

export type SearchFacets = {
  kind: FacetBucket[];
  workspace: FacetBucket[];
};

export type SearchResult = {
  hits: SearchHit[];
  facets: SearchFacets;
  totalCount: number;
  nextCursor: string | null;
};

export type ContentSearchQuery = {
  query: string;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  limit: number;
};

export type ContentSearchHit = {
  entityId: string;
  kind: EntityKind;
  title: string;
  passage: string;
};

export type ContentSearchResult = {
  hits: ContentSearchHit[];
  totalCount: number;
};

export type RemoveEntityOptions = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

export type SearchProvider = {
  search: (query: SearchQuery) => Promise<SearchResult>;
  searchContent: (query: ContentSearchQuery) => Promise<ContentSearchResult>;
  indexEntity: (entityId: SafeId<"entity">) => Promise<void>;
  removeEntity: (options: RemoveEntityOptions) => Promise<void>;
  rebuildIndex: (orgId: SafeId<"organization">) => Promise<void>;
};

export { GLOBAL_SEARCH_RESULT_TYPES };
export type { GlobalSearchResultType };

export const parseGlobalSearchResultType = (
  value: unknown,
): GlobalSearchResultType => {
  const s = String(value);
  const match = GLOBAL_SEARCH_RESULT_TYPES.find((v) => v === s);
  if (!match) {
    panic(`Invalid global search result type: ${s}`);
  }
  return match;
};

type GlobalSearchHitBase = {
  /** Stable compatibility key for existing v1 search consumers. */
  id: string;
  resourceName: ResourceName;
  type: GlobalSearchResultType;
  title: string;
  headline: string | null;
  updatedAt: string;
};

export type EntityGlobalSearchHit = GlobalSearchHitBase & {
  type: EntityKind;
  resource: ResourceRef<"entity">;
  entityId: string;
  workspaceId: string;
  workspaceName: string;
  /** Containing folder entity, null at the matter root. Lets the client
   * offer "open the location" (matter scoped into this folder) alongside
   * opening the hit itself. */
  parentId: string | null;
  lastEditedByName: string | null;
  lastEditedByImage: string | null;
  fileFieldId: string | null;
  filePropertyId: string | null;
  mimeType: string | null;
};

export type MatterGlobalSearchHit = GlobalSearchHitBase & {
  type: "matter";
  resource: ResourceRef<"workspace">;
  workspaceId: string;
  workspaceName: string;
  /** Stored workspace color token (e.g. "--option-blue"); null if unset. */
  color: string | null;
};

export type ContactGlobalSearchHit = GlobalSearchHitBase & {
  type: "contact";
  resource: ResourceRef<"contact">;
  contactId: string;
  contactType: ContactType;
};

export type CaseLawGlobalSearchHit = GlobalSearchHitBase & {
  type: "case-law";
  resource: ResourceRef<"case_law_decision">;
  decisionId: string;
  caseNumber: string;
  identifiers: DecisionIdentifiers;
  court: string;
  country: string;
  decisionDate: string | null;
};

export type ChatGlobalSearchHit = GlobalSearchHitBase & {
  type: "chat";
  resource: ResourceRef<"chat_thread">;
  threadId: string;
  /** Null for cross-workspace (global) threads. */
  workspaceId: string | null;
  workspaceName: string | null;
};

export type GlobalSearchHit =
  | EntityGlobalSearchHit
  | MatterGlobalSearchHit
  | ContactGlobalSearchHit
  | CaseLawGlobalSearchHit
  | ChatGlobalSearchHit;

export type GlobalSearchFacets = {
  type: FacetBucket[];
  workspace: FacetBucket[];
  editor: FacetBucket[];
  mimeType: FacetBucket[];
};

export type GlobalSearchResult = {
  hits: GlobalSearchHit[];
  facets: GlobalSearchFacets;
  totalCount: number;
  nextCursor: string | null;
};
