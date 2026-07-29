import { sql } from "drizzle-orm";

import { searchDocuments } from "@/api/db/schema";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";

declare const enabled: boolean;
declare const organizationId: string;
declare const pickFirst: (...values: unknown[]) => unknown;

const entityWorkspaceFilter = searchDocumentsAccessSql({});
const privateSearchTable = searchDocuments;
const singleWorkspaceFilter = searchDocumentsAccessSql({});

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an unscoped private projection read is rejected
const unsafeEntity = sql`SELECT * FROM search_documents sd WHERE sd.organization_id = ${organizationId}`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves PostgreSQL-equivalent uppercase identifiers are protected
const unsafeUppercaseEntity = sql`SELECT * FROM SEARCH_DOCUMENTS sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves schema qualification cannot hide a private projection
const unsafeQualifiedEntity = sql`SELECT * FROM public.search_documents sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves quoted identifiers cannot hide a private projection
const unsafeQuotedEntity = sql`
  SELECT * FROM "public"."search_documents" AS "sd"
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves comma-form relations cannot hide a private projection
const unsafeCommaFormEntity = sql`
  SELECT *
  FROM entities e, search_documents sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves comma-form interpolated relations cannot hide a private projection
const unsafeCommaFormInterpolatedEntity = sql`
  SELECT *
  FROM entities e, ${searchDocuments} sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an interpolated private schema table cannot bypass the guard
const unsafeInterpolatedEntity = sql`SELECT * FROM ${searchDocuments} sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a const alias cannot hide an interpolated private schema table
const unsafeAliasedInterpolatedEntity = sql`
  SELECT * FROM ${privateSearchTable} sd
`;

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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves PostgreSQL ONLY cannot hide a private projection
const unsafeOnlyEntity = sql`SELECT * FROM ONLY search_documents sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves ONLY with a qualified relation cannot hide a private projection
const unsafeQualifiedOnlyEntity = sql`
  SELECT * FROM ONLY public.search_documents sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves ONLY with quoted identifiers cannot hide a private projection
const unsafeQuotedOnlyEntity = sql`
  SELECT * FROM ONLY "public"."search_documents" AS "sd"
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves ONLY before an interpolated relation cannot hide a private projection
const unsafeOnlyInterpolatedEntity = sql`
  SELECT * FROM ONLY ${searchDocuments} sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves comma-form ONLY interpolation cannot hide a private projection
const unsafeCommaOnlyInterpolatedEntity = sql`
  SELECT *
  FROM entities e, ONLY ${searchDocuments} sd
`;

const unsafeComposedPrivateRead = (() => {
  const privateFrom = sql`FROM search_documents sd`;
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an ordinary SQL fragment cannot hide a private projection
  return sql`SELECT * ${privateFrom}`;
})();

const unsafeJoinedPrivateFragment = (() => {
  const privateFragments = [sql`FROM search_documents sd`];
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves call-composed SQL fragments cannot hide a private projection
  return sql`SELECT * ${sql.join(privateFragments)}`;
})();

const unsafeSplitJoinedPrivateFragment = (() => {
  const privateFragments = [sql`FROM search_`, sql`documents sd`];
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves no-separator sql.join preserves exact runtime text
  return sql`SELECT * ${sql.join(privateFragments)}`;
})();

const unsafeJoinedMultiBranch = (() => {
  const branches = [
    sql`* FROM search_documents sd`,
    sql`* FROM entities sd WHERE true ${entityWorkspaceFilter}`,
  ];
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a sql.join separator preserves query branch boundaries
  return sql`SELECT ${sql.join(branches, sql` UNION ALL SELECT `)}`;
})();

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves sql.raw cannot bypass private projection detection
const unsafeRawEntity = sql.raw("SELECT * FROM search_documents sd");

const rawEntityTemplate = `SELECT * FROM search_documents sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves const-bound static template literals cannot bypass sql.raw inspection
const unsafeRawTemplateEntity = sql.raw(rawEntityTemplate);

const privateRawRelation = sql.raw("search_documents");

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves raw relation fragments preserve SQL lexical continuity
const unsafeRawRelationFragment = sql`
  SELECT * FROM ${privateRawRelation} sd
`;

const relationNameStringLiteral = sql`
  SELECT 'FROM search_documents sd'
`;
const relationNameLineComment = sql`
  SELECT 1
  -- FROM search_documents sd
`;
const relationNameBlockComment = sql`
  SELECT 1 /* FROM search_documents sd */
`;
const relationNameDollarQuote = sql`
  SELECT $note$FROM search_documents sd$note$
`;
const distinctQuotedRelation = sql`
  SELECT * FROM "SEARCH_DOCUMENTS" sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves opaque helpers expose each SQL-bearing argument as an alternative
const unsafeOpaqueHelperCall = sql`
  SELECT *
  ${pickFirst(
    sql`FROM search_documents sd`,
    sql`WHERE true ${entityWorkspaceFilter}`,
  )}
`;

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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a parenthesized joined-table expression cannot hide a private projection
const unsafeParenthesizedJoinedEntity = sql`
  SELECT *
  FROM (search_documents sd CROSS JOIN entities e) joined_entities
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves nested parenthesized joined-table expressions cannot hide a private projection
const unsafeNestedParenthesizedJoinedEntity = sql`
  SELECT *
  FROM ((search_documents sd CROSS JOIN entities e)) joined_entities
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves interpolated tables leading parenthesized joins remain protected
const unsafeParenthesizedJoinedInterpolatedEntity = sql`
  SELECT *
  FROM (${searchDocuments} sd CROSS JOIN entities e) joined_entities
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a scope inside CASE is not a dominating query predicate
const unsafeScopeInCaseCondition = sql`
  SELECT * FROM search_documents sd
  WHERE CASE
    WHEN true ${entityWorkspaceFilter} THEN false
    ELSE true
  END
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a function argument is not a dominating query predicate
const unsafeScopeInFunctionArgument = sql`
  SELECT * FROM search_documents sd
  WHERE coalesce(true, true ${entityWorkspaceFilter})
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves false Boolean membership cannot invert an approved scope
const unsafeScopeInFalseMembership = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IN (FALSE)
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves NOT IN true cannot invert an approved scope
const unsafeScopeNotInTrueMembership = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) NOT IN (TRUE)
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

const scopedAliasedInterpolatedEntity = sql`
  SELECT *
  FROM ${privateSearchTable} sd
  WHERE true ${entityWorkspaceFilter}
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

const scopedAfterFunctionArgument = sql`
  SELECT * FROM search_documents sd
  WHERE coalesce(false, false) ${entityWorkspaceFilter}
`;

const scopedAfterNestedQuery = sql`
  SELECT * FROM search_documents sd
  WHERE EXISTS (SELECT 1) ${entityWorkspaceFilter}
`;

const scopedTestedAsTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IS TRUE
`;

const scopedInTrueMembership = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) IN (TRUE)
`;

const scopedNotInFalseMembership = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) NOT IN (FALSE)
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

const scopedJoinedPrivateFragment = (() => {
  const fragments = [
    sql`FROM search_documents sd `,
    sql`WHERE true `,
    entityWorkspaceFilter,
  ];
  return sql`SELECT * ${sql.join(fragments)}`;
})();

const scopedParenthesizedJoinedEntity = sql`
  SELECT *
  FROM (search_documents sd CROSS JOIN entities e) joined_entities
  WHERE true ${entityWorkspaceFilter}
`;

const scopedParenthesizedJoinedInterpolatedEntity = sql`
  SELECT *
  FROM (${searchDocuments} sd CROSS JOIN entities e) joined_entities
  WHERE true ${entityWorkspaceFilter}
`;

const scopedJoinedMultiBranch = (() => {
  const branches = [
    sql`* FROM search_documents sd WHERE true ${entityWorkspaceFilter}`,
    sql`* FROM search_documents sd WHERE true ${singleWorkspaceFilter}`,
  ];
  return sql`SELECT ${sql.join(branches, sql` UNION ALL SELECT `)}`;
})();

const scopedRawJoinedMultiBranch = (() => {
  const branches = [
    sql`* FROM search_documents sd WHERE true ${entityWorkspaceFilter}`,
    sql`* FROM search_documents sd WHERE true ${singleWorkspaceFilter}`,
  ];
  return sql`SELECT ${sql.join(branches, sql.raw(" UNION ALL SELECT "))}`;
})();

const scopedOpaquePrivateFragment = sql`
  SELECT *
  ${pickFirst(sql`FROM search_documents sd`)}
  WHERE true ${entityWorkspaceFilter}
`;

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

const writeOnlyEntityProjection = sql`
  INSERT INTO search_documents (entity_id)
  SELECT id FROM entities
`;

const writeOnlyInterpolatedEntityProjection = sql`
  INSERT INTO ${searchDocuments} (entity_id)
  SELECT id FROM entities
`;

// Public case law is intentionally organization-independent.
const publicCaseLaw = sql`SELECT * FROM case_law_search_documents clsd`;

void [
  unsafeEntity,
  unsafeUppercaseEntity,
  unsafeQualifiedEntity,
  unsafeQuotedEntity,
  unsafeCommaFormEntity,
  unsafeCommaFormInterpolatedEntity,
  unsafeInterpolatedEntity,
  unsafeAliasedInterpolatedEntity,
  unsafeChatCount,
  unsafeConditionalScope,
  unsafeNestedHelper,
  unsafeShadowedHelper,
  unsafeLineCommentScope,
  unsafeBlockCommentScope,
  unsafeNestedBlockCommentScope,
  unsafeDollarQuotedScope,
  unsafeTableRead,
  unsafeOnlyEntity,
  unsafeQualifiedOnlyEntity,
  unsafeQuotedOnlyEntity,
  unsafeOnlyInterpolatedEntity,
  unsafeCommaOnlyInterpolatedEntity,
  unsafeComposedPrivateRead,
  unsafeJoinedPrivateFragment,
  unsafeSplitJoinedPrivateFragment,
  unsafeJoinedMultiBranch,
  unsafeRawEntity,
  unsafeRawTemplateEntity,
  unsafeRawRelationFragment,
  relationNameStringLiteral,
  relationNameLineComment,
  relationNameBlockComment,
  relationNameDollarQuote,
  distinctQuotedRelation,
  unsafeOpaqueHelperCall,
  unsafeConditionalPrivateFragment,
  unsafeLogicalPrivateFragment,
  unsafeSequencePrivateFragment,
  unsafeScopeInConditionalSibling,
  unsafeConditionalInterpolatedEntity,
  unsafeParenthesizedJoinedEntity,
  unsafeNestedParenthesizedJoinedEntity,
  unsafeParenthesizedJoinedInterpolatedEntity,
  unsafeWrongProjectionAlias,
  unsafeMultiBranch,
  unsafeScopeInLaterBranch,
  unsafeScopeInLaterStatement,
  unsafeScopeInOuterJoin,
  unsafeScopeInAggregateFilter,
  unsafeComposedAggregateFilterScope,
  unsafeScopeInOrBranch,
  unsafeScopeInCaseCondition,
  unsafeScopeInFunctionArgument,
  unsafeScopeTestedAsFalse,
  unsafeScopeComparedToFalse,
  unsafeScopeDistinctFromTrue,
  unsafeScopeInFalseMembership,
  unsafeScopeNotInTrueMembership,
  unsafeScopeInNestedQuery,
  unsafeScopeInSiblingQuery,
  scopedEntity,
  scopedSingleWorkspace,
  scopedInterpolatedEntity,
  scopedAliasedInterpolatedEntity,
  scopedExplicitAlias,
  scopedAfterLineComment,
  scopedAfterDollarQuote,
  scopedParenthesizedFilter,
  scopedAfterFunctionArgument,
  scopedAfterNestedQuery,
  scopedTestedAsTrue,
  scopedInTrueMembership,
  scopedNotInFalseMembership,
  scopedNestedPrivateRead,
  scopedComposedRead,
  scopedJoinedPrivateFragment,
  scopedParenthesizedJoinedEntity,
  scopedParenthesizedJoinedInterpolatedEntity,
  scopedJoinedMultiBranch,
  scopedRawJoinedMultiBranch,
  scopedOpaquePrivateFragment,
  scopedConditionalPrivateFragment,
  scopedMultiBranch,
  scopedMatter,
  scopedContact,
  scopedChat,
  writeOnlyEntityProjection,
  writeOnlyInterpolatedEntityProjection,
  publicCaseLaw,
];
