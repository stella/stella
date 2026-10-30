import { Result } from "better-result";
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
  /** The folder it sits in, or none at the matter's top level. */
  parentId: v.nullish(v.string()),
  /** The one column asked for: the documents column, whose file names the type. */
  fields: v.optional(
    v.array(
      v.object({
        propertyId: v.string(),
        content: v.nullish(
          v.looseObject({
            type: v.string(),
            mimeType: v.optional(v.string()),
            fileName: v.optional(v.string()),
          }),
        ),
      }),
    ),
    [],
  ),
});

const entityPageSchema = v.object({
  items: v.array(entityRowSchema),
  nextCursor: v.nullable(v.string()),
});

type EntityRow = v.InferOutput<typeof entityRowSchema>;

/**
 * A row as the screen shows it: a document carries its file's format
 * ("PDF", "DOCX"), read from the matter's documents column.
 */
export type MatterEntity = Omit<EntityRow, "fields"> & {
  readonly fileType?: string | undefined;
};

/** Formats named by their media type; any other is named by its extension. */
const FILE_TYPE_OF_MIME: Readonly<Record<string, string>> = {
  "application/pdf": "PDF",
  "application/msword": "DOC",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "DOCX",
  "application/vnd.ms-excel": "XLS",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
  "application/vnd.ms-powerpoint": "PPT",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PPTX",
  "application/rtf": "RTF",
  "text/plain": "TXT",
  "text/csv": "CSV",
  "message/rfc822": "EML",
  "application/vnd.ms-outlook": "MSG",
};

/**
 * A file's format as a short tag: the known name of its media type, else
 * its name's extension in capitals, else none. Formats are not translated.
 */
export const fileTypeOf = (
  mimeType: string | undefined,
  fileName: string | undefined,
): string | undefined => {
  const media = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const known = media === undefined ? undefined : FILE_TYPE_OF_MIME[media];
  if (known !== undefined) {
    return known;
  }
  const extension = fileName?.match(/\.([a-z0-9]{1,5})$/iu)?.[1];
  return extension?.toUpperCase();
};

const toMatterEntity = (
  { fields, ...row }: EntityRow,
  fileFieldId: string | null,
): MatterEntity => {
  const file =
    fileFieldId === null
      ? undefined
      : fields.find((field) => field.propertyId === fileFieldId)?.content;
  const fileType =
    file?.type === "file"
      ? fileTypeOf(file.mimeType, file.fileName)
      : undefined;
  return fileType === undefined ? row : { ...row, fileType };
};

export type KnownEntityKind = "folder" | "document" | "task";

/** The kinds this build can name; any other kind is shown without one. */
export const isKnownEntityKind = (kind: string): kind is KnownEntityKind =>
  kind === "folder" || kind === "document" || kind === "task";

export type EntityPage = {
  readonly items: MatterEntity[];
  readonly nextCursor: string | null;
};

/**
 * One page of a matter's documents, folders and tasks, in the matter's own
 * order. Chat messages and links are entities too, but not this screen's.
 */
export const listMatterEntities = async ({
  fetch,
  source,
  workspaceId,
  cursor,
  fileFieldId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly workspaceId: string;
  readonly cursor: string | null;
  /** The matter's documents column, when known: the one column asked for. */
  readonly fileFieldId: string | null;
}): Promise<Result<EntityPage, ApiError>> =>
  await Result.gen(async function* () {
    const page = yield* Result.await(
      requestApi({
        fetch,
        source,
        path: entitiesPath(workspaceId),
        schema: entityPageSchema,
        body: {
          limit: ENTITY_PAGE_SIZE,
          excludedKinds: ["message", "link"],
          // The built-in fields, and the documents column for each file's type.
          fieldMode: "visible",
          fieldIds: fileFieldId === null ? [] : [fileFieldId],
          ...(cursor === null ? {} : { cursor }),
        },
      }),
    );
    return Result.ok({
      items: page.items.map((row) => toMatterEntity(row, fileFieldId)),
      nextCursor: page.nextCursor,
    });
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

type EntitySectionKey = "documents" | "tasks";

/**
 * One row of a section. A document or folder sits `depth` folders below the
 * matter's top level; a folder says whether it is open.
 */
type EntityTreeRow =
  | {
      readonly type: "folder";
      readonly entity: MatterEntity;
      readonly depth: number;
      readonly open: boolean;
    }
  | {
      readonly type: "item";
      readonly entity: MatterEntity;
      readonly depth: number;
    };

export type EntitySection = {
  readonly key: EntitySectionKey;
  readonly data: EntityTreeRow[];
};

const SECTION_OF_KIND: Readonly<Record<string, EntitySectionKey>> = {
  folder: "documents",
  document: "documents",
  task: "tasks",
};

/**
 * Documents as the web's tree: at each level folders first, then documents,
 * each in the order the server listed them, and an open folder's contents
 * under it. A row whose folder is not loaded (yet) sits at the top level, so
 * paging never hides a document. Tasks follow, flat. Empty sections are left
 * out; kinds this build does not know are too.
 */
export const entitySections = (
  entities: readonly MatterEntity[],
  openFolders: ReadonlySet<string>,
): EntitySection[] => {
  const tasks: EntityTreeRow[] = [];
  const documents: MatterEntity[] = [];
  for (const entity of entities) {
    const section = SECTION_OF_KIND[entity.kind];
    if (section === "tasks") {
      tasks.push({ type: "item", entity, depth: 0 });
    } else if (section === "documents") {
      documents.push(entity);
    }
  }
  const folderIds = new Set(
    documents
      .filter((entity) => entity.kind === "folder")
      .map((entity) => entity.entityId),
  );
  const childrenOf = new Map<string | null, MatterEntity[]>();
  for (const entity of documents) {
    const parent =
      entity.parentId !== null &&
      entity.parentId !== undefined &&
      entity.parentId !== entity.entityId &&
      folderIds.has(entity.parentId)
        ? entity.parentId
        : null;
    const siblings = childrenOf.get(parent) ?? [];
    siblings.push(entity);
    childrenOf.set(parent, siblings);
  }
  // Folders that name each other as parents are reached from nowhere; they
  // move to the top level so no row is ever hidden.
  const reachable = new Set<string>();
  const reach = (parent: string | null) => {
    for (const entity of childrenOf.get(parent) ?? []) {
      if (!reachable.has(entity.entityId)) {
        reachable.add(entity.entityId);
        reach(entity.entityId);
      }
    }
  };
  reach(null);
  for (const entity of documents) {
    if (!reachable.has(entity.entityId)) {
      const roots = childrenOf.get(null) ?? [];
      roots.push(entity);
      childrenOf.set(null, roots);
      reachable.add(entity.entityId);
      reach(entity.entityId);
    }
  }
  const tree: EntityTreeRow[] = [];
  // A folder is listed once even if the data names a cycle of parents.
  const listed = new Set<string>();
  const addLevel = (parent: string | null, depth: number) => {
    const siblings = childrenOf.get(parent) ?? [];
    const ordered = [
      ...siblings.filter((entity) => entity.kind === "folder"),
      ...siblings.filter((entity) => entity.kind !== "folder"),
    ];
    for (const entity of ordered) {
      if (listed.has(entity.entityId)) {
        continue;
      }
      listed.add(entity.entityId);
      if (entity.kind !== "folder") {
        tree.push({ type: "item", entity, depth });
        continue;
      }
      const open = openFolders.has(entity.entityId);
      tree.push({ type: "folder", entity, depth, open });
      if (open) {
        addLevel(entity.entityId, depth + 1);
      }
    }
  };
  addLevel(null, 0);
  return [
    { key: "documents" as const, data: tree },
    { key: "tasks" as const, data: tasks },
  ].filter((section) => section.data.length > 0);
};
