import { panic } from "better-result";

import { entityKindEnum } from "@/api/db/schema";
import type { EntityKind } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

/** Narrow an unknown value to a valid EntityKind. */
export const parseEntityKind = (value: unknown): EntityKind => {
  const s = String(value);
  const match = entityKindEnum.enumValues.find((v) => v === s);
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
