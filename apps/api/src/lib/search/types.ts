import { panic } from "better-result";

import { ENTITY_KINDS } from "@/api/db/schema";
import type { ContactType } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

/** Narrow an unknown value to a valid EntityKind. */
export const parseEntityKind = (value: unknown): EntityKind => {
  const s = String(value);
  const match = ENTITY_KINDS.find((v) => v === s);
  if (!match) {
    panic(`Invalid entity kind: ${s}`);
  }
  return match;
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

export type SearchProvider = {
  search: (query: SearchQuery) => Promise<SearchResult>;
  searchContent: (query: ContentSearchQuery) => Promise<ContentSearchResult>;
  indexEntity: (entityId: SafeId<"entity">) => Promise<void>;
  removeEntity: (entityId: SafeId<"entity">) => Promise<void>;
  rebuildIndex: (orgId: SafeId<"organization">) => Promise<void>;
};

export const GLOBAL_SEARCH_RESULT_TYPES = [
  "matter",
  "contact",
  "case-law",
  ...ENTITY_KINDS,
] as const;

export type GlobalSearchResultType =
  (typeof GLOBAL_SEARCH_RESULT_TYPES)[number];

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
  id: string;
  type: GlobalSearchResultType;
  title: string;
  headline: string | null;
  updatedAt: string;
};

export type EntityGlobalSearchHit = GlobalSearchHitBase & {
  type: EntityKind;
  entityId: string;
  workspaceId: string;
  workspaceName: string;
  lastEditedByName: string | null;
  lastEditedByImage: string | null;
  mimeType: string | null;
};

export type MatterGlobalSearchHit = GlobalSearchHitBase & {
  type: "matter";
  workspaceId: string;
  workspaceName: string;
  /** Stored workspace color token (e.g. "--option-blue"); null if unset. */
  color: string | null;
};

export type ContactGlobalSearchHit = GlobalSearchHitBase & {
  type: "contact";
  contactId: string;
  contactType: ContactType;
};

export type CaseLawGlobalSearchHit = GlobalSearchHitBase & {
  type: "case-law";
  decisionId: string;
  caseNumber: string;
  court: string;
  country: string;
  decisionDate: string | null;
};

export type GlobalSearchHit =
  | EntityGlobalSearchHit
  | MatterGlobalSearchHit
  | ContactGlobalSearchHit
  | CaseLawGlobalSearchHit;

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
