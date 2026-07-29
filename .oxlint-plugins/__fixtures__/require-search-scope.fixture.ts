import { searchDocuments } from "@/api/db/schema";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";

declare const sql: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;
declare const enabled: boolean;
declare const organizationId: string;

const entityWorkspaceFilter = searchDocumentsAccessSql({});
const singleWorkspaceFilter = searchDocumentsAccessSql({});

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an unscoped private projection read is rejected
const unsafeEntity = sql`SELECT * FROM search_documents sd WHERE sd.organization_id = ${organizationId}`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves PostgreSQL-equivalent uppercase identifiers are protected
const unsafeUppercaseEntity = sql`SELECT * FROM SEARCH_DOCUMENTS sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an interpolated private schema table cannot bypass the guard
const unsafeInterpolatedEntity = sql`SELECT * FROM ${searchDocuments} sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves counts cannot omit authorization either
const unsafeChatCount = sql`SELECT count(*) FROM chat_thread_search_documents cst`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a conditional scope can fail open and is rejected
const unsafeConditionalScope = sql`
  SELECT *
  FROM search_documents sd
  WHERE true
    ${organizationId ? entityWorkspaceFilter : ""}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a nested helper reference is not accepted as composed SQL
const unsafeNestedHelper = sql`
  SELECT *
  FROM search_documents sd
  WHERE true
    ${() => searchDocumentsAccessSql}
`;

const unsafeShadowedHelper = (() => {
  // oxlint-disable-next-line no-shadow -- fixture proves this binding cannot impersonate the approved import
  const searchDocumentsAccessSql = (_scope: unknown) => "";
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a same-named local cannot impersonate the approved import
  return sql`SELECT * FROM search_documents sd WHERE true ${searchDocumentsAccessSql({})}`;
})();

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves line-comment interpolation cannot authorize a private read
const unsafeLineCommentScope = sql`
  SELECT * FROM search_documents sd -- ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves block-comment interpolation cannot authorize a private read
const unsafeBlockCommentScope = sql`
  SELECT * FROM search_documents sd /* ${entityWorkspaceFilter} */
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves nested block comments cannot hide their closing delimiter
const unsafeNestedBlockCommentScope = sql`
  SELECT * FROM search_documents sd
  /* outer /* nested */ ${entityWorkspaceFilter} */
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves dollar-quoted strings cannot authorize a private read
const unsafeDollarQuotedScope = sql`
  SELECT * FROM search_documents sd
  WHERE $guard$${entityWorkspaceFilter}$guard$ <> ''
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves PostgreSQL TABLE shorthand is also a protected read
const unsafeTableRead = sql`TABLE search_documents`;

const unsafeComposedPrivateRead = (() => {
  const privateFrom = sql`FROM search_documents sd`;
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an ordinary SQL fragment cannot hide a private projection
  return sql`SELECT * ${privateFrom}`;
})();

const unsafeConditionalPrivateFragment = (() => {
  const privateFrom = enabled
    ? sql`FROM search_documents sd`
    : sql`FROM entities e`;
  const aliasedPrivateFrom = privateFrom;
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a conditional SQL fragment cannot hide a private projection
  return sql`SELECT * ${aliasedPrivateFrom}`;
})();

const unsafeLogicalPrivateFragment = (() => {
  const privateFrom = enabled && sql`FROM search_documents sd`;
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a logical SQL fragment cannot hide a private projection
  return sql`SELECT * ${privateFrom}`;
})();

const unsafeSequencePrivateFragment = (() => {
  // oxlint-disable-next-line no-sequences -- fixture proves the final sequence expression is inspected as the composed SQL value
  const privateFrom = (enabled, sql`FROM search_documents sd`);
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a sequence SQL fragment cannot hide a private projection
  return sql`SELECT * ${privateFrom}`;
})();

const unsafeScopeInConditionalSibling = (() => {
  const privateFrom = enabled
    ? sql`FROM search_documents sd`
    : sql`FROM search_documents sd WHERE true ${entityWorkspaceFilter}`;
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves one conditional branch cannot authorize another
  return sql`SELECT * ${privateFrom}`;
})();

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves conditional table interpolation cannot hide a private projection
const unsafeConditionalInterpolatedEntity = sql`
  SELECT *
  FROM ${enabled ? searchDocuments : sql`entities`} sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a fixed scope alias cannot authorize a differently aliased private projection
const unsafeWrongProjectionAlias = sql`
  SELECT private_sd.*
  FROM search_documents private_sd
  JOIN workspaces sd ON sd.id = private_sd.workspace_id
  WHERE true ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves every UNION branch needs its own verified scope
const unsafeMultiBranch = sql`
  SELECT * FROM search_documents sd
  WHERE true ${entityWorkspaceFilter} ${singleWorkspaceFilter}
  UNION ALL
  SELECT * FROM search_documents sd WHERE true
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a later UNION branch cannot authorize an earlier private read
const unsafeScopeInLaterBranch = sql`
  SELECT * FROM search_documents sd
  UNION ALL
  SELECT sd.* FROM entities sd WHERE true ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a later statement cannot authorize an earlier private read
const unsafeScopeInLaterStatement = sql`
  SELECT * FROM search_documents sd;
  SELECT sd.* FROM entities sd WHERE true ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an outer-join ON predicate cannot authorize protected left-side rows
const unsafeScopeInOuterJoin = sql`
  SELECT sd.*
  FROM search_documents sd
  LEFT JOIN entities e ON true ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves aggregate FILTER predicates do not constrain projected rows
const unsafeScopeInAggregateFilter = sql`
  SELECT json_agg(sd.title)
  FROM search_documents sd
  ORDER BY count(*) FILTER (WHERE true ${entityWorkspaceFilter})
`;

const aggregateFilterStart = sql`ORDER BY count(*) FILTER (WHERE true`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves aggregate FILTER context survives composed fragments
const unsafeComposedAggregateFilterScope = sql`
  SELECT json_agg(sd.title)
  FROM search_documents sd
  ${aggregateFilterStart} ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a scope beneath OR is not a dominating conjunct
const unsafeScopeInOrBranch = sql`
  SELECT * FROM search_documents sd
  WHERE true OR (false ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a postfix false test cannot invert an approved scope
const unsafeScopeTestedAsFalse = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IS FALSE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a prefix false comparison cannot invert an approved scope
const unsafeScopeComparedToFalse = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE = (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a distinctness test cannot invert an approved scope
const unsafeScopeDistinctFromTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IS DISTINCT FROM TRUE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a nested query cannot authorize an outer private read through an alias shadow
const unsafeScopeInNestedQuery = sql`
  SELECT sd.*
  FROM search_documents sd
  WHERE EXISTS (
    SELECT 1 FROM entities sd WHERE true ${entityWorkspaceFilter}
  )
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a sibling nested query cannot authorize an earlier private read at the same parenthesis depth
const unsafeScopeInSiblingQuery = sql`
  SELECT EXISTS (
    SELECT 1 FROM search_documents sd
  ) OR EXISTS (
    SELECT 1 FROM entities sd WHERE true ${entityWorkspaceFilter}
  )
`;

const scopedEntity = sql`
  SELECT *
  FROM search_documents sd
  WHERE sd.organization_id = ${organizationId}
    ${entityWorkspaceFilter}
`;

const scopedSingleWorkspace = sql`
  SELECT *
  FROM search_documents sd
  WHERE true
    ${singleWorkspaceFilter}
`;

const scopedInterpolatedEntity = sql`
  SELECT * FROM ${searchDocuments} sd WHERE true ${entityWorkspaceFilter}
`;

const scopedExplicitAlias = sql`
  SELECT * FROM search_documents AS sd WHERE true ${entityWorkspaceFilter}
`;

const scopedAfterLineComment = sql`
  SELECT * FROM search_documents sd
  -- explanatory comment
  WHERE true ${entityWorkspaceFilter}
`;

const scopedAfterDollarQuote = sql`
  SELECT * FROM search_documents sd
  WHERE $note$literal$note$ <> '' ${entityWorkspaceFilter}
`;

const scopedParenthesizedFilter = sql`
  SELECT * FROM search_documents sd
  WHERE (true AND (${entityWorkspaceFilter}))
`;

const scopedTestedAsTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IS TRUE
`;

const scopedNestedPrivateRead = sql`
  SELECT EXISTS (
    SELECT 1
    FROM search_documents sd
    WHERE true ${entityWorkspaceFilter}
  )
`;

const scopedComposedRead = (() => {
  const privateFrom = sql`FROM search_documents sd`;
  const scopedWhere = sql`WHERE true ${entityWorkspaceFilter}`;
  return sql`SELECT * ${privateFrom} ${scopedWhere}`;
})();

const scopedConditionalPrivateFragment = (() => {
  const privateFrom = enabled
    ? sql`FROM search_documents sd`
    : sql`FROM search_documents AS sd`;
  return sql`SELECT * ${privateFrom} WHERE true ${entityWorkspaceFilter}`;
})();

const scopedMultiBranch = sql`
  SELECT * FROM search_documents sd WHERE true ${entityWorkspaceFilter}
  UNION ALL
  SELECT * FROM search_documents sd WHERE true ${singleWorkspaceFilter}
`;

const scopedMatter = sql`
  SELECT *
  FROM workspace_search_documents wsd
  WHERE true
    ${workspaceSearchDocumentsAccessSql({})}
`;

const scopedContact = sql`
  SELECT *
  FROM contact_search_documents csd
  WHERE true
    ${contactWorkspaceAccessSql({})}
`;

const scopedChat = sql`
  SELECT *
  FROM chat_thread_search_documents cst
  WHERE ${chatThreadScopeSql({})}
`;

// Public case law is intentionally organization-independent.
const publicCaseLaw = sql`SELECT * FROM case_law_search_documents clsd`;

void [
  unsafeEntity,
  unsafeUppercaseEntity,
  unsafeInterpolatedEntity,
  unsafeChatCount,
  unsafeConditionalScope,
  unsafeNestedHelper,
  unsafeShadowedHelper,
  unsafeLineCommentScope,
  unsafeBlockCommentScope,
  unsafeNestedBlockCommentScope,
  unsafeDollarQuotedScope,
  unsafeTableRead,
  unsafeComposedPrivateRead,
  unsafeConditionalPrivateFragment,
  unsafeLogicalPrivateFragment,
  unsafeSequencePrivateFragment,
  unsafeScopeInConditionalSibling,
  unsafeConditionalInterpolatedEntity,
  unsafeWrongProjectionAlias,
  unsafeMultiBranch,
  unsafeScopeInLaterBranch,
  unsafeScopeInLaterStatement,
  unsafeScopeInOuterJoin,
  unsafeScopeInAggregateFilter,
  unsafeComposedAggregateFilterScope,
  unsafeScopeInOrBranch,
  unsafeScopeTestedAsFalse,
  unsafeScopeComparedToFalse,
  unsafeScopeDistinctFromTrue,
  unsafeScopeInNestedQuery,
  unsafeScopeInSiblingQuery,
  scopedEntity,
  scopedSingleWorkspace,
  scopedInterpolatedEntity,
  scopedExplicitAlias,
  scopedAfterLineComment,
  scopedAfterDollarQuote,
  scopedParenthesizedFilter,
  scopedTestedAsTrue,
  scopedNestedPrivateRead,
  scopedComposedRead,
  scopedConditionalPrivateFragment,
  scopedMultiBranch,
  scopedMatter,
  scopedContact,
  scopedChat,
  publicCaseLaw,
];
