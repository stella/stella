import type { Result } from "better-result";
import * as v from "valibot";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** Enough rows to fill a phone screen twice; the rest arrive on "load more". */
export const ENTITY_PAGE_SIZE = 50;

const entitiesPath = (workspaceId: string) =>
  `/v1/entities/${encodeURIComponent(workspaceId)}/query`;

export const entityPath = (workspaceId: string, entityId: string) =>
  `/v1/entities/${encodeURIComponent(workspaceId)}/entity/${encodeURIComponent(entityId)}`;

/**
 * Only what a row shows. `kind` stays a string: a newer server may list a
 * kind this build has never seen, and such a row is left out rather than
 * failing the whole page.
 */
const entityRowSchema = v.object({
  entityId: v.pipe(v.string(), v.minLength(1)),
  kind: v.string(),
  name: v.nullable(v.string()),
  createdAt: v.string(),
  updatedAt: v.nullish(v.string()),
  status: v.nullish(v.string()),
  createdBy: v.nullish(v.string()),
});

const entityPageSchema = v.object({
  items: v.array(entityRowSchema),
  nextCursor: v.nullable(v.string()),
});

export type MatterEntity = v.InferOutput<typeof entityRowSchema>;

export type KnownEntityKind = "folder" | "document" | "task";

/** The kinds this build can name; any other kind is shown without one. */
export const isKnownEntityKind = (kind: string): kind is KnownEntityKind =>
  kind === "folder" || kind === "document" || kind === "task";

export type EntityPage = v.InferOutput<typeof entityPageSchema>;

/**
 * One page of a matter's documents, folders and tasks, in the matter's own
 * order. Chat messages and links are entities too, but not this screen's.
 */
export const listMatterEntities = async ({
  fetch,
  source,
  workspaceId,
  cursor,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly workspaceId: string;
  readonly cursor: string | null;
}): Promise<Result<EntityPage, ApiError>> =>
  await requestApi({
    fetch,
    source,
    path: entitiesPath(workspaceId),
    schema: entityPageSchema,
    body: {
      limit: ENTITY_PAGE_SIZE,
      excludedKinds: ["message", "link"],
      // No property columns: the rows show built-in fields only.
      fieldMode: "visible",
      fieldIds: [],
      ...(cursor === null ? {} : { cursor }),
    },
  });

/** Pages joined in order; a row a later page repeats keeps its first place. */
export const appendEntityPage = (
  loaded: readonly MatterEntity[],
  page: EntityPage,
): MatterEntity[] => {
  const seen = new Set(loaded.map((entity) => entity.entityId));
  return [
    ...loaded,
    ...page.items.filter((entity) => !seen.has(entity.entityId)),
  ];
};

/**
 * What the matter screen holds: every row loaded so far, where the next page
 * starts, and why the last request failed, if it did. A failed "load more"
 * keeps the rows already shown.
 */
export type EntitiesLoad = {
  readonly loadedAt: number;
  readonly entities: readonly MatterEntity[];
  readonly nextCursor: string | null;
  readonly error: ApiError | null;
};

export const EMPTY_ENTITIES_LOAD: EntitiesLoad = {
  loadedAt: 0,
  entities: [],
  nextCursor: null,
  error: null,
};

/** The load after one more page request answered with `result`. */
export const applyEntityPage = (
  previous: EntitiesLoad,
  result: Result<EntityPage, ApiError>,
  loadedAt: number,
): EntitiesLoad =>
  result.isOk()
    ? {
        loadedAt,
        entities: appendEntityPage(previous.entities, result.value),
        nextCursor: result.value.nextCursor,
        error: null,
      }
    : { ...previous, loadedAt, error: result.error };

export type EntitySectionKey = "documents" | "tasks";

export type EntitySection = {
  readonly key: EntitySectionKey;
  readonly data: MatterEntity[];
};

const SECTION_OF_KIND: Readonly<Record<string, EntitySectionKey>> = {
  folder: "documents",
  document: "documents",
  task: "tasks",
};

/**
 * Documents (folders first) then tasks, each in the order the server listed
 * them. Empty sections are left out; kinds this build does not know are too.
 */
export const entitySections = (
  entities: readonly MatterEntity[],
): EntitySection[] => {
  const folders: MatterEntity[] = [];
  const documents: MatterEntity[] = [];
  const tasks: MatterEntity[] = [];
  for (const entity of entities) {
    const section = SECTION_OF_KIND[entity.kind];
    if (section === "tasks") {
      tasks.push(entity);
    } else if (section === "documents") {
      (entity.kind === "folder" ? folders : documents).push(entity);
    }
  }
  return [
    { key: "documents" as const, data: [...folders, ...documents] },
    { key: "tasks" as const, data: tasks },
  ].filter((section) => section.data.length > 0);
};
