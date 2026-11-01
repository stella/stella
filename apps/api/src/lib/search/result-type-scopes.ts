import type { McpOAuthScope } from "@stll/api-contract";

import {
  GLOBAL_SEARCH_RESULT_TYPES,
  type GlobalSearchResultType,
} from "@/api/lib/search/types";

/**
 * The scope an access token needs to see each search result type. Total over
 * the result types, so a new type cannot ship without deciding which consent
 * covers it. A chat hit carries the caller's own assistant thread title and
 * an excerpt of its messages, which every chat route holds at `stella:chat`;
 * the other types are matter, contact and public-law content `stella:read`
 * already opens.
 */
const GLOBAL_SEARCH_RESULT_TYPE_SCOPE = {
  matter: "stella:read",
  contact: "stella:read",
  "case-law": "stella:read",
  document: "stella:read",
  folder: "stella:read",
  task: "stella:read",
  message: "stella:read",
  link: "stella:read",
  chat: "stella:chat",
} as const satisfies Record<GlobalSearchResultType, McpOAuthScope>;

/**
 * The result types a caller may see. A browser session (no scopes) sees every
 * type; an access token, over REST or MCP, sees the types its scopes reach.
 */
export const permittedSearchResultTypes = (
  grantedScopes: readonly string[] | undefined,
): readonly GlobalSearchResultType[] =>
  grantedScopes === undefined
    ? GLOBAL_SEARCH_RESULT_TYPES
    : GLOBAL_SEARCH_RESULT_TYPES.filter((type) =>
        grantedScopes.includes(GLOBAL_SEARCH_RESULT_TYPE_SCOPE[type]),
      );
