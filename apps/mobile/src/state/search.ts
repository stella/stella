import { panic } from "better-result";
import type { Result } from "better-result";
import type { Href } from "expo-router";
import * as v from "valibot";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import type { GlobalSearchResultType } from "@stll/api-contract/search";

import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import { requestApi } from "@/state/api-request";
import type { ApiError } from "@/state/api-request";

/** Results across every matter the person can open, case law and chats. */
const SEARCH_PATH = "/v1/search";

/** One screen of results and a little more; the search asks for no further page. */
export const SEARCH_PAGE_SIZE = 30;

/** How long typing pauses before the field's text is searched. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * The result types the app has a screen for. A contact has none yet, so the
 * search neither offers nor lists one.
 */
const OPENABLE_TYPES = [
  "document",
  "matter",
  "task",
  "case-law",
  "chat",
  "folder",
  "message",
  "link",
] as const satisfies readonly GlobalSearchResultType[];

export type SearchResultType = (typeof OPENABLE_TYPES)[number];

const OPENABLE: ReadonlySet<string> = new Set(OPENABLE_TYPES);

const ENTITY_TYPES: ReadonlySet<string> = new Set([
  "document",
  "folder",
  "task",
  "message",
  "link",
]);

type EntityType = "document" | "folder" | "task" | "message" | "link";

const isOpenableType = (type: string): type is SearchResultType =>
  OPENABLE.has(type);

const isEntityType = (type: string): type is EntityType =>
  ENTITY_TYPES.has(type);

/**
 * One hit, with only what a row shows and opening it needs. `type` stays a
 * string: a newer server may return a type this build has never seen, and
 * such a hit is left out rather than failing the whole page.
 */
const hitSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  type: v.string(),
  title: v.nullish(v.string()),
  headline: v.nullish(v.string()),
  updatedAt: v.string(),
  entityId: v.nullish(v.string()),
  workspaceId: v.nullish(v.string()),
  workspaceName: v.nullish(v.string()),
  threadId: v.nullish(v.string()),
  decisionId: v.nullish(v.string()),
  caseNumber: v.nullish(v.string()),
  court: v.nullish(v.string()),
  decisionDate: v.nullish(v.string()),
});

/** One value of a filter, with how many results carry it. */
const bucketSchema = v.object({
  value: v.pipe(v.string(), v.minLength(1)),
  label: v.nullish(v.string()),
  count: v.number(),
});

const searchPageSchema = v.object({
  hits: v.array(hitSchema),
  /** The filters' values for this search, which the first page carries. */
  facets: v.optional(
    v.object({
      type: v.optional(v.array(bucketSchema), []),
      workspace: v.optional(v.array(bucketSchema), []),
    }),
    { type: [], workspace: [] },
  ),
});

type SearchHit = v.InferOutput<typeof hitSchema>;

type FacetBucket = v.InferOutput<typeof bucketSchema>;

/** A result the app can open, by what it is. */
export type SearchResult =
  | {
      readonly kind: "entity";
      readonly key: string;
      readonly entityKind: EntityType;
      readonly entityId: string;
      readonly workspaceId: string;
      readonly matterName: string | null;
      readonly title: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "matter";
      readonly key: string;
      readonly workspaceId: string;
      readonly title: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "chat";
      readonly key: string;
      readonly threadId: string;
      readonly matterName: string | null;
      readonly title: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: "case-law";
      readonly key: string;
      readonly decisionId: string;
      readonly caseNumber: string;
      readonly court: string;
      readonly decisionDate: string | null;
      readonly preview: string | null;
    };

/** What narrows a search: the matters and the result types picked. */
export type SearchQualifiers = {
  readonly matterIds: readonly string[];
  readonly types: readonly SearchResultType[];
};

export const NO_QUALIFIERS: SearchQualifiers = { matterIds: [], types: [] };

/** One chip under the field: a matter or a result type, picked or not. */
export type QualifierChip =
  | {
      readonly kind: "matter";
      readonly value: string;
      readonly label: string;
      readonly picked: boolean;
    }
  | {
      readonly kind: "type";
      readonly value: SearchResultType;
      readonly picked: boolean;
    };

export type SearchPage = {
  readonly results: readonly SearchResult[];
  readonly typeBuckets: readonly FacetBucket[];
  readonly matterBuckets: readonly FacetBucket[];
};

/** The text a search sends: trimmed, and no longer than the server reads. */
export const searchText = (query: string): string =>
  query.trim().slice(0, SEARCH_QUERY_MAX_LENGTH);

/**
 * The body of a search for `query` under `qualifiers`. The route reads every
 * filter list, so the ones the app does not offer go empty.
 */
export const searchRequestBody = (
  query: string,
  qualifiers: SearchQualifiers,
) => ({
  query: searchText(query),
  workspaceIds: [...qualifiers.matterIds],
  types: [...qualifiers.types],
  kinds: [],
  editedByUserIds: [],
  mimeTypes: [],
  limit: SEARCH_PAGE_SIZE,
});

const MARK_TAG = /<\/?mark>/gu;

const HTML_ENTITIES = new Map([
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#x27;", "'"],
  ["&#39;", "'"],
  ["&amp;", "&"],
]);

/**
 * A headline as plain text. The server escapes it as HTML and marks the
 * matched words with `<mark>`; a row shows neither.
 */
export const plainHeadline = (headline: string): string =>
  headline
    .replaceAll(MARK_TAG, "")
    .replaceAll(
      /&(?:lt|gt|quot|amp|#x27|#39);/gu,
      (entity) => HTML_ENTITIES.get(entity) ?? entity,
    );

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== "";

/** A hit as a result the app can open, or null for one it cannot. */
const toSearchResult = (hit: SearchHit): SearchResult | null => {
  const title = hit.title ?? "";
  const { updatedAt } = hit;
  if (isEntityType(hit.type)) {
    return present(hit.entityId) && present(hit.workspaceId)
      ? {
          kind: "entity",
          key: hit.id,
          entityKind: hit.type,
          entityId: hit.entityId,
          workspaceId: hit.workspaceId,
          matterName: hit.workspaceName ?? null,
          title,
          updatedAt,
        }
      : null;
  }
  if (hit.type === "matter") {
    return present(hit.workspaceId)
      ? {
          kind: "matter",
          key: hit.id,
          workspaceId: hit.workspaceId,
          title,
          updatedAt,
        }
      : null;
  }
  if (hit.type === "chat") {
    return present(hit.threadId)
      ? {
          kind: "chat",
          key: hit.id,
          threadId: hit.threadId,
          matterName: hit.workspaceName ?? null,
          title,
          updatedAt,
        }
      : null;
  }
  if (hit.type === "case-law") {
    return present(hit.decisionId)
      ? {
          kind: "case-law",
          key: hit.id,
          decisionId: hit.decisionId,
          caseNumber: present(hit.caseNumber) ? hit.caseNumber : title,
          court: hit.court ?? "",
          decisionDate: hit.decisionDate ?? null,
          preview: present(hit.headline) ? plainHeadline(hit.headline) : null,
        }
      : null;
  }
  return null;
};

/** Where a result opens: the screen the app already has for its kind. */
export const searchResultRoute = (result: SearchResult): Href => {
  switch (result.kind) {
    case "entity": {
      const { entityId, workspaceId } = result;
      if (result.entityKind === "document") {
        return {
          pathname: "/document/[workspaceId]/[entityId]",
          params: {
            entityId,
            workspaceId,
            ...(result.title === "" ? {} : { name: result.title }),
          },
        };
      }
      // A folder opens its matter at the top level, where the folder unfolds
      // in place; the matter screen takes no folder to open at.
      if (result.entityKind === "folder") {
        return {
          pathname: "/matter/[workspaceId]",
          params: {
            workspaceId,
            ...(result.matterName === null ? {} : { name: result.matterName }),
          },
        };
      }
      return {
        pathname: "/matter/[workspaceId]/[entityId]",
        params: { entityId, workspaceId },
      };
    }
    case "matter":
      return {
        pathname: "/matter/[workspaceId]",
        params: {
          workspaceId: result.workspaceId,
          ...(result.title === "" ? {} : { name: result.title }),
        },
      };
    case "chat":
      return {
        pathname: "/thread/[threadId]",
        params: { threadId: result.threadId },
      };
    case "case-law":
      return {
        pathname: "/law/[decisionId]",
        params: {
          caseNumber: result.caseNumber,
          decisionId: result.decisionId,
        },
      };
    default:
      result satisfies never;
      return panic("Unhandled search result kind");
  }
};

/**
 * The chips a search offers: the picked ones first, so a filter in force
 * never scrolls out of sight, then the result types and the matters its
 * results fall in, the types the app cannot open left out.
 */
export const qualifierChips = (
  page: Pick<SearchPage, "matterBuckets" | "typeBuckets"> | null,
  qualifiers: SearchQualifiers,
  /** The names of the picked matters, which a later page may not list. */
  matterNames: ReadonlyMap<string, string>,
): QualifierChip[] => {
  const pickedTypes = new Set<string>(qualifiers.types);
  const pickedMatters = new Set(qualifiers.matterIds);
  const picked: QualifierChip[] = [
    ...qualifiers.types.map(
      (value) => ({ kind: "type", value, picked: true }) as const,
    ),
    ...qualifiers.matterIds.map(
      (value) =>
        ({
          kind: "matter",
          value,
          label: matterNames.get(value) ?? value,
          picked: true,
        }) as const,
    ),
  ];
  const types = (page?.typeBuckets ?? []).flatMap(({ value }) =>
    isOpenableType(value) && !pickedTypes.has(value)
      ? [{ kind: "type", value, picked: false } as const]
      : [],
  );
  const matters = (page?.matterBuckets ?? []).flatMap(({ label, value }) =>
    pickedMatters.has(value) || !present(label)
      ? []
      : [{ kind: "matter", value, label, picked: false } as const],
  );
  return [...picked, ...types, ...matters];
};

/** The qualifiers with `chip` picked, or put back if it was. */
export const toggleQualifier = (
  qualifiers: SearchQualifiers,
  chip: QualifierChip,
): SearchQualifiers => {
  if (chip.kind === "type") {
    return {
      ...qualifiers,
      types: qualifiers.types.includes(chip.value)
        ? qualifiers.types.filter((type) => type !== chip.value)
        : [...qualifiers.types, chip.value],
    };
  }
  return {
    ...qualifiers,
    matterIds: qualifiers.matterIds.includes(chip.value)
      ? qualifiers.matterIds.filter((id) => id !== chip.value)
      : [...qualifiers.matterIds, chip.value],
  };
};

/** The first page of results for `query` under `qualifiers`. */
export const searchStella = async ({
  fetch,
  qualifiers,
  query,
  source,
}: {
  readonly fetch: Fetch;
  readonly qualifiers: SearchQualifiers;
  readonly query: string;
  readonly source: AccessTokenSource;
}): Promise<Result<SearchPage, ApiError>> => {
  const answer = await requestApi({
    body: searchRequestBody(query, qualifiers),
    fetch,
    path: SEARCH_PATH,
    schema: searchPageSchema,
    source,
  });
  return answer.map((page) => ({
    results: page.hits.flatMap((hit) => toSearchResult(hit) ?? []),
    typeBuckets: page.facets.type,
    matterBuckets: page.facets.workspace,
  }));
};

/**
 * What the results area shows. Every search started takes the next ticket,
 * and an answer counts only while its ticket is the latest, so a slow
 * answer to an older query never replaces a newer one.
 */
export type SearchView =
  | { readonly status: "idle"; readonly ticket: number }
  | {
      readonly status: "loading";
      readonly ticket: number;
      /** The results on screen while the next ones load. */
      readonly previous: SearchPage | null;
    }
  | {
      readonly status: "loaded";
      readonly ticket: number;
      readonly page: SearchPage;
    }
  | {
      readonly status: "failed";
      readonly ticket: number;
      readonly error: ApiError;
    };

type SearchEvent =
  | { readonly type: "start"; readonly ticket: number }
  | {
      readonly type: "answer";
      readonly ticket: number;
      readonly result: Result<SearchPage, ApiError>;
    }
  | { readonly type: "reset"; readonly ticket: number };

export const IDLE_SEARCH: SearchView = { status: "idle", ticket: 0 };

/** The page a view shows, loaded or still on screen while the next loads. */
export const shownPage = (view: SearchView): SearchPage | null => {
  if (view.status === "loaded") {
    return view.page;
  }
  return view.status === "loading" ? view.previous : null;
};

/** The results area after `event`; an answer to a superseded search changes nothing. */
export const searchViewReducer = (
  view: SearchView,
  event: SearchEvent,
): SearchView => {
  switch (event.type) {
    case "start":
      return {
        status: "loading",
        ticket: event.ticket,
        previous: shownPage(view),
      };
    case "reset":
      return { status: "idle", ticket: event.ticket };
    case "answer":
      if (event.ticket !== view.ticket || view.status !== "loading") {
        return view;
      }
      return event.result.isOk()
        ? { status: "loaded", ticket: event.ticket, page: event.result.value }
        : { status: "failed", ticket: event.ticket, error: event.result.error };
    default:
      event satisfies never;
      return panic("Unhandled search event");
  }
};
