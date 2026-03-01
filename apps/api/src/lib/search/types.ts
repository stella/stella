import type { EntityKind } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

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

export type SearchProvider = {
  search: (query: SearchQuery) => Promise<SearchResult>;
  indexEntity: (entityId: string) => Promise<void>;
  removeEntity: (entityId: string) => Promise<void>;
  rebuildIndex: (orgId: SafeId<"organization">) => Promise<void>;
};
