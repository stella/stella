import { entityKindEnum } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

/** Narrow an unknown value to a valid EntityKind. */
export const parseEntityKind = (value: unknown): EntityKind => {
  const s = String(value);
  const match = entityKindEnum.enumValues.find((v) => v === s);
  if (!match) {
    throw new Error(`Invalid entity kind: ${s}`);
  }
  return match;
};

export type SearchQuery = {
  query: string;
  organizationId: SafeId<"organization">;
  workspaceId?: string;
  kinds?: EntityKind[];
  cursor?: string;
  limit: number;
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
  workspaceId: string;
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
  indexEntity: (entityId: string) => Promise<void>;
  removeEntity: (entityId: string) => Promise<void>;
  rebuildIndex: (orgId: SafeId<"organization">) => Promise<void>;
};
