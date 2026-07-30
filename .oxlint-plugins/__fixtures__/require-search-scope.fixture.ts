import { load } from "cheerio";
import * as drizzle from "drizzle-orm";
import { sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import {
  entities,
  searchDocumentPreviewPassages,
  searchDocuments,
} from "@/api/db/schema";
import { redistributableCaseLawSource as importedOpaqueRelationFragment } from "@/api/lib/case-law/redistribution";
import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  searchDocumentsAccessSql,
  workspaceSearchDocumentsAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";

declare const enabled: boolean;
declare const organizationId: string;
declare const pickFirst: (...values: unknown[]) => unknown;

const opaqueFragment = <Value>({ fragment }: { fragment: Value }) => fragment;
const drizzleSqlAlias = sql;

const entityWorkspaceFilter = searchDocumentsAccessSql({});
const privateSearchTable = searchDocuments;
const singleWorkspaceFilter = searchDocumentsAccessSql({});

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an unscoped private projection read is rejected
const unsafeEntity = sql`SELECT * FROM search_documents sd WHERE sd.organization_id = ${organizationId}`;

const _unsafeDocumentPassage =
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves document preview passages are private projections
  sql`SELECT * FROM search_document_preview_passages passage`;

const _unsafeWorkspacePassage =
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves workspace preview passages are private projections
  sql`SELECT * FROM workspace_search_document_preview_passages passage`;

const _unsafeContactPassage =
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves contact preview passages are private projections
  sql`SELECT * FROM contact_search_document_preview_passages passage`;

const _unsafeChatPassage =
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves chat preview passages are private projections
  sql`SELECT * FROM chat_thread_search_preview_passages passage`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves rootDb query builders cannot read private projections outside the SQL scope guard
const unsafeBuilderEntity = rootDb.select().from(searchDocuments);

const _unsafeJoinedEntity = rootDb
  .select()
  .from(entities)
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves rootDb joins cannot introduce an unscoped private projection
  .innerJoin(searchDocuments, sql`true`);

const _unsafePreviewPassage = rootDb
  .select()
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves preview-passage projections receive the same rootDb builder protection
  .from(searchDocumentPreviewPassages);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves rootDb relational reads cannot bypass the private projection scope guard
const _unsafeRelationalEntity = rootDb.query.searchDocuments.findFirst();

const _unsafeComputedRelationalEntity =
  // oxlint-disable-next-line require-search-scope/require-search-scope, typescript/dot-notation -- fixture proves computed rootDb relational reads cannot bypass the private projection scope guard
  rootDb.query["searchDocuments"].findMany({ limit: 1 });

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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves UPDATE FROM reads cannot omit authorization
const unsafeUpdateFromEntity = sql`
  UPDATE entities e
  SET title = sd.title
  FROM search_documents sd
  WHERE e.id = sd.entity_id
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves interpolated UPDATE FROM reads cannot omit authorization
const unsafeInterpolatedUpdateFromEntity = sql`
  UPDATE entities e
  SET title = sd.title
  FROM ${searchDocuments} sd
  WHERE e.id = sd.entity_id
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves DELETE USING reads cannot omit authorization
const unsafeDeleteUsingEntity = sql`
  DELETE FROM entities e
  USING search_documents sd
  WHERE e.id = sd.entity_id
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves interpolated DELETE USING reads cannot omit authorization
const unsafeInterpolatedDeleteUsingEntity = sql`
  DELETE FROM entities e
  USING ${searchDocuments} sd
  WHERE e.id = sd.entity_id
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves insert-only MERGE actions cannot read an unscoped private source
const unsafeMergeUsingEntity = sql`
  MERGE INTO entities e
  USING search_documents sd
  ON false
  WHEN NOT MATCHED THEN
    INSERT (id) VALUES (sd.entity_id)
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves MERGE ON cannot authorize source rows used by WHEN NOT MATCHED
const unsafeMergeOnScopeEntity = sql`
  MERGE INTO entities e
  USING search_documents sd
  ON e.id = sd.entity_id
    AND true ${entityWorkspaceFilter}
  WHEN NOT MATCHED THEN
    INSERT (id) VALUES (sd.entity_id)
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a scope outside a nested MERGE cannot authorize its source query
const unsafeNestedMergeSource = sql`
  WITH merged_entities AS (
    MERGE INTO entities e
    USING search_documents sd
    ON e.id = sd.entity_id
    WHEN MATCHED THEN
      UPDATE SET title = sd.title
  )
  SELECT * FROM merged_entities me
  WHERE true ${entityWorkspaceFilter}
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves cooked escape text can comment out an authorization scope
const unsafeEscapedLineCommentScope = sql`
  SELECT * FROM search_documents sd
  WHERE true \x2d\x2d ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves SQL templates without a cooked runtime value are rejected
const unsafeUnavailableCookedSql = sql`
  SELECT * FROM search_documents sd
  WHERE true \unicode ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a const alias of the approved SQL tag also fails closed
const unsafeUnavailableCookedSqlAlias = drizzleSqlAlias`\unicode`;

const nonSqlUnavailableCooked = String.raw`\unicode`;
const nonSqlPrivateText = String.raw`SELECT * FROM search_documents sd`;
const nonSqlNestedPrivateText = sql`
  SELECT ${String.raw`FROM search_documents sd`}
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves ordinary PostgreSQL strings do not backslash-escape their closing quote
const unsafeOrdinaryBackslashQuote = sql`
  SELECT '\\' AS slash
  FROM search_documents sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves PostgreSQL escape strings retain backslash-quote escaping
const unsafeEscapeStringRead = sql`
  SELECT E'masked \\' quote' AS note
  FROM search_documents sd
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

const privateFromHelper = () => sql`FROM search_documents sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a local zero-argument helper cannot hide a private projection
const unsafeLocalHelperPrivateRead = sql`SELECT * ${privateFromHelper()}`;

const privateFromHelperAlias = privateFromHelper;
const privateFromHelperAliasChain = privateFromHelperAlias;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves recursively const-aliased direct helpers cannot hide a private projection
const unsafeAliasedLocalHelperPrivateRead = sql`
  SELECT * ${privateFromHelperAliasChain()}
`;

const scopedFromHelper = (scope: unknown) =>
  sql`FROM search_documents sd WHERE true ${scope}`;
const scopedFromHelperAlias = scopedFromHelper;
const scopedAliasedLocalHelperRead = sql`
  SELECT * ${scopedFromHelperAlias(entityWorkspaceFilter)}
`;

// oxlint-disable-next-line arrow-body-style -- block body exercises block-return helper analysis
const privateFromBlock = () => {
  return sql`FROM search_documents sd`;
};

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves block-returning local helpers cannot hide a private projection
const unsafeBlockHelperPrivateRead = sql`SELECT * ${privateFromBlock()}`;

const fromTable = (table: unknown) => sql`FROM ${table} sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves parameterized local SQL helpers cannot hide an interpolated private table
const unsafeParameterizedHelperRead = sql`
  SELECT * ${fromTable(searchDocuments)}
`;

function declaredFromTable(table: unknown) {
  return sql`FROM ${table} sd`;
}

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves parameter substitution also applies to function declarations
const unsafeDeclaredHelperRead = sql`
  SELECT * ${declaredFromTable(searchDocuments)}
`;

const fromEitherTable = (primary: unknown, fallback: unknown) =>
  enabled ? sql`FROM ${primary} sd` : sql`FROM ${fallback}`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves dynamic argument branches and multiple parameters are inspected independently
const unsafeBranchedParameterizedHelperRead = sql`
  SELECT *
  ${fromEitherTable(
    enabled ? searchDocuments : sql`entities`,
    sql`workspaces w`,
  )}
`;

const memberSqlHelpers = {
  fromPrivate() {
    return sql`FROM search_documents sd`;
  },
  fromScoped(scope: unknown) {
    return sql`FROM search_documents sd WHERE true ${scope}`;
  },
};

const computedPrivateHelperDefinitionKey = "fromPrivate";
const computedPrivateHelperDefinitionKeyAlias =
  computedPrivateHelperDefinitionKey;
const computedDefinitionSqlHelpers = {
  [computedPrivateHelperDefinitionKeyAlias]() {
    return sql`FROM search_documents sd`;
  },
  scoped(scope: unknown) {
    return sql`FROM search_documents sd WHERE true ${scope}`;
  },
};

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a const-computed object definition key cannot hide a private helper
const unsafeComputedDefinitionMemberHelperRead = sql`
  SELECT * ${computedDefinitionSqlHelpers.fromPrivate()}
`;

const scopedComputedDefinitionMemberHelperRead = sql`
  SELECT *
  ${computedDefinitionSqlHelpers.scoped(entityWorkspaceFilter)}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a statically selected object method cannot hide a private projection
const unsafeMemberHelperRead = sql`
  SELECT * ${memberSqlHelpers.fromPrivate()}
`;

const scopedMemberHelperRead = sql`
  SELECT * ${memberSqlHelpers.fromScoped(entityWorkspaceFilter)}
`;

const missingArgumentMemberSqlHelpers = {
  fromPrivate(_scope: unknown) {
    return sql`FROM search_documents sd`;
  },
  fromPublic(_scope: unknown) {
    return sql`FROM entities e`;
  },
};

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a missing unused helper argument cannot hide a private projection
const unsafeMissingArgumentMemberHelperRead = sql`
  SELECT * ${missingArgumentMemberSqlHelpers.fromPrivate()}
`;

const publicMissingArgumentMemberHelperRead = sql`
  SELECT * ${missingArgumentMemberSqlHelpers.fromPublic()}
`;

declare const dynamicMemberHelperKey: "fromPrivate" | "fromScoped";

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves every callable dynamic object member is inspected independently
const unsafeDynamicMemberHelperRead = sql`
  SELECT *
  ${memberSqlHelpers[dynamicMemberHelperKey](entityWorkspaceFilter)}
`;

const scopedDynamicMemberSqlHelpers = {
  fromEntity(scope: unknown) {
    return sql`FROM search_documents sd WHERE true ${scope}`;
  },
  fromPublic(_scope: unknown) {
    return sql`FROM entities e`;
  },
};

declare const scopedDynamicMemberHelperKey: "fromEntity" | "fromPublic";
const scopedDynamicMemberHelperRead = sql`
  SELECT *
  ${scopedDynamicMemberSqlHelpers[scopedDynamicMemberHelperKey](
    entityWorkspaceFilter,
  )}
`;

const memberFragments = {
  from: sql`FROM search_documents sd`,
  publicFrom: sql`FROM entities e`,
};

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a statically selected object fragment cannot hide a private projection
const unsafeMemberFragmentRead = sql`SELECT * ${memberFragments.from}`;

const tupleFragments = [
  sql`FROM search_documents sd`,
  sql`FROM entities e`,
] as const;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a statically selected tuple fragment cannot hide a private projection
const unsafeTupleFragmentRead = sql`SELECT * ${tupleFragments[0]}`;

const memberFragmentKey = "from";
const memberFragmentKeyAlias = memberFragmentKey;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a recursively resolved const-computed object key cannot hide a private projection
const unsafeComputedMemberFragmentRead = sql`
  SELECT * ${memberFragments[memberFragmentKeyAlias]}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope, typescript/dot-notation -- fixture proves cooked static template keys select the runtime fragment
const unsafeEscapedTemplateMemberFragmentRead = sql`SELECT * ${memberFragments[`fr\x6fm`]}`;

const tupleFragmentIndex = 0;
const tupleFragmentIndexAlias = tupleFragmentIndex;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a recursively resolved const-computed tuple index cannot hide a private projection
const unsafeComputedTupleFragmentRead = sql`
  SELECT * ${tupleFragments[tupleFragmentIndexAlias]}
`;

declare const dynamicMemberFragmentKey: "from" | "publicFrom";

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves every selectable value of a mixed dynamic object is inspected
const unsafeDynamicMemberFragmentRead = sql`
  SELECT * ${memberFragments[dynamicMemberFragmentKey]}
`;

declare const dynamicTupleFragmentIndex: 0 | 1;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves every selectable value of a mixed dynamic tuple is inspected
const unsafeDynamicTupleFragmentRead = sql`
  SELECT * ${tupleFragments[dynamicTupleFragmentIndex]}
`;

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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a root sql.join call is inspected with exact text boundaries
const unsafeRootJoinedPrivateRead = sql.join([
  sql`SELECT * FROM search_`,
  sql`documents sd`,
]);

// oxlint-disable-next-line require-search-scope/require-search-scope, typescript/no-deprecated -- fixture proves deprecated but callable sql.fromList preserves exact composition when the private relation is split across chunks
const unsafeRootFromListPrivateRead = sql.fromList([
  sql`SELECT * FROM search_`,
  sql`documents sd`,
]);

// oxlint-disable-next-line typescript/no-deprecated -- valid control for the deprecated but callable composition bypass fixture above
const scopedRootFromListPrivateRead = sql.fromList([
  sql`SELECT * FROM search_documents sd WHERE true `,
  entityWorkspaceFilter,
]);

const unsafeAppendRoot = sql`SELECT * FROM `;
const unsafeAppendAlias = unsafeAppendRoot;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a const-aliased SQL append cannot hide a private projection
const unsafeAppendedPrivateRead = unsafeAppendAlias.append(
  sql`search_documents sd`,
);

const separatedAppendPrivateRead = sql``;
separatedAppendPrivateRead.append(sql`SELECT * FROM search_`);
// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture tracks separate mutations whose combined text forms a protected relation
separatedAppendPrivateRead.append(sql`documents sd`);

const multiAppendScopedPrivateRead = sql``;
multiAppendScopedPrivateRead.append(
  sql`SELECT * FROM search_documents sd WHERE true `,
);
// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture conservatively rejects scope spread across separate mutable append statements
multiAppendScopedPrivateRead.append(entityWorkspaceFilter);

const conditionalScopeAppendPrivateRead = sql`
  SELECT * FROM search_documents sd WHERE true
`;
if (enabled) {
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture rejects a conditionally appended scope that may be absent at runtime
  conditionalScopeAppendPrivateRead.append(entityWorkspaceFilter);
}

const scopedSingleAppendPrivateRead = sql``;
scopedSingleAppendPrivateRead.append(
  sql`SELECT * FROM search_documents sd WHERE true ${entityWorkspaceFilter}`,
);

const emptyInitializedPrivateRead = sql.empty();
emptyInitializedPrivateRead.append(sql`SELECT * FROM search_`);
// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves sql.empty mutable roots cannot hide relations split across appends
emptyInitializedPrivateRead.append(sql`documents sd`);

const unrelatedAppendControl = {
  append: (fragment: unknown) => fragment,
}.append(sql`search_documents sd`);

const cheerio = load("<p>search_documents</p>");
cheerio("p").append("\n");

declare const opaqueAppendReceiver: {
  append: (fragment: unknown) => unknown;
};

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an opaque append receiver cannot hide a private relation fragment
const unsafeOpaqueReceiverPrivateAppend = opaqueAppendReceiver.append(
  sql`FROM search_documents sd`,
);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves opaque append inspection also rejects an unresolved imported relation fragment
const unsafeOpaqueReceiverImportedAppend = opaqueAppendReceiver.append(
  importedOpaqueRelationFragment,
);

const scopedOpaqueReceiverPrivateAppend = opaqueAppendReceiver.append(
  sql`FROM search_documents sd WHERE true ${entityWorkspaceFilter}`,
);

const publicOpaqueReceiverAppend = opaqueAppendReceiver.append(
  sql`FROM entities e`,
);

const unsafeOpaqueRootJoinedPrivateRead = sql.join([
  opaqueFragment({
    // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an opaque join element cannot suppress standalone fragment inspection
    fragment: sql`SELECT * FROM search_documents sd`,
  }),
]);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves sql.raw cannot bypass private projection detection
const unsafeRawEntity = sql.raw("SELECT * FROM search_documents sd");

const rawEntityTemplate = `SELECT * FROM search_documents sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves const-bound static template literals cannot bypass sql.raw inspection
const unsafeRawTemplateEntity = sql.raw(rawEntityTemplate);

const escapedRawEntityTemplate = `SELECT * FROM search_\x64ocuments sd`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves sql.raw analyzes the cooked value of a static template
const unsafeEscapedRawTemplateEntity = sql.raw(escapedRawEntityTemplate);

declare const dynamicRawSql: string;
const drizzleRawAlias = sql.raw;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a standalone dynamic sql.raw root fails closed
const unsafeDynamicRawRoot = sql.raw(dynamicRawSql);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a const alias cannot hide a standalone dynamic sql.raw root
const unsafeAliasedDynamicRawRoot = drizzleRawAlias(dynamicRawSql);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves dynamic raw text cannot hide a private relation inside a composed read
const unsafeComposedDynamicRawEntity = sql`
  SELECT * ${sql.raw(dynamicRawSql)}
`;

let opaqueRelationWithAttachedAlias = sql.raw("FROM search_documents ");
// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an attached alias cannot hide an opaque relation fragment
const unsafeOpaqueRelationWithAttachedAlias = sql`
  SELECT * ${opaqueRelationWithAttachedAlias}sd
`;
opaqueRelationWithAttachedAlias = sql.raw("FROM entities ");
void opaqueRelationWithAttachedAlias;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves dynamic raw expressions cannot inject a private FROM clause into an otherwise public root
const unsafeDynamicRawSelectExpression = sql`
  SELECT ${sql.raw(dynamicRawSql)}
  FROM entities e
`;

declare const dynamicPgArrayType: "text" | "uuid";
const dynamicRawNonRootTypeFragment = sql`
  ARRAY[]::${sql.raw(dynamicPgArrayType)}[]
`;

const staticRawPublicExpression = sql`
  SELECT ${drizzleRawAlias("e.id")}
  FROM entities e
`;

const privateRawRelation = sql.raw("search_documents");

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a static sql.identifier relation is analyzed as exact quoted SQL
const unsafeStaticIdentifierEntity = sql`
  SELECT * FROM ${sql.identifier("search_documents")} sd
`;

const scopedStaticIdentifierEntity = sql`
  SELECT * FROM ${drizzleSqlAlias.identifier("search_documents")} sd
  WHERE true ${entityWorkspaceFilter}
`;

const publicStaticIdentifierEntity = sql`
  SELECT * FROM ${sql.identifier("entities")} e
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves even a currently public imported fragment fails closed because its SQL definition is unavailable here
const unsafeImportedOpaqueRelation = sql`
  SELECT * ${importedOpaqueRelationFragment}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves namespace-imported Drizzle SQL tags are inspected
const unsafeNamespaceImportedEntity = drizzle.sql`
  SELECT * FROM search_documents sd
`;

const unresolvedCompositionParts = [
  sql`SELECT * FROM search_`,
  sql`documents sd`,
];
// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves unresolved root compositions fail closed
const unsafeUnresolvedRootComposition = sql.join(
  unresolvedCompositionParts.slice(),
);

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves COPY TO reads of private projections require authorization
const unsafeCopyEntityProjection = sql`
  COPY search_documents TO STDOUT
`;

const staticPublicRelationControl = sql`SELECT * FROM entities e`;

const importedOpaqueNonRootControl = sql`
  (${importedOpaqueRelationFragment})
`;

declare const dynamicRelationName: string;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a dynamic sql.identifier relation is rejected when its authorization cannot be verified
const unsafeDynamicIdentifierRelation = sql`
  SELECT * FROM ${sql.identifier(dynamicRelationName)} relation
`;

declare const dynamicColumnName: string;
const dynamicIdentifierColumnControl = sql`
  SELECT ${sql.identifier(dynamicColumnName)}
  FROM entities e
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a PostgreSQL Unicode-escaped relation cannot hide the private projection
const unsafeUnicodeEscapedEntity = sql`
  SELECT * FROM U&"search\\005fdocuments" sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a custom UESCAPE character cannot hide the private projection
const unsafeCustomUnicodeEscapedEntity = sql`
  SELECT * FROM U&"search!005fdocuments" UESCAPE '!' AS sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves the lowercase PostgreSQL Unicode-identifier prefix is equivalent
const unsafeLowercaseUnicodeEscapedEntity = sql`
  SELECT * FROM u&"search!005fdocuments"UESCAPE'!' AS sd
`;

const scopedCustomUnicodeEscapedEntity = sql`
  SELECT *
  FROM U&"search!005fdocuments" UESCAPE '!'
    AS U&"s!0064" UESCAPE '!'
  WHERE true ${entityWorkspaceFilter}
`;

const publicUnicodeEscapedEntity = sql`
  SELECT * FROM U&"entit!0069es" UESCAPE '!' e
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves unsupported Unicode relation syntax fails closed
const unsafeUnsupportedUnicodeEscapeEntity = sql`
  SELECT * FROM U&"search!005fdocuments" UESCAPE '!!' sd
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves raw relation fragments preserve SQL lexical continuity
const unsafeRawRelationFragment = sql`
  SELECT * FROM ${privateRawRelation} sd
`;

const privateRawRelationPrefix = sql.raw("search_");

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves verified raw fragments preserve exact SQL text boundaries
const unsafeSplitRawRelationFragment = sql`
  SELECT * FROM ${privateRawRelationPrefix}documents sd
`;

const privateTemplateRelationPrefix = sql`search_`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves verified nested templates preserve exact SQL text boundaries
const unsafeSplitTemplateRelationFragment = sql`
  SELECT * FROM ${privateTemplateRelationPrefix}documents sd
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an explicit schema-qualified operator cannot invert an approved scope
const unsafeExplicitOperatorBeforeScope = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE OPERATOR(pg_catalog.=) (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an explicit operator after an approved scope is not positive conjunct grammar
const unsafeExplicitOperatorAfterScope = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) OPERATOR(pg_catalog.=) FALSE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture rejects custom explicit operators rather than assuming their Boolean semantics
const unsafeCustomExplicitOperatorBeforeScope = sql`
  SELECT * FROM search_documents sd
  WHERE TRUE OPERATOR(public.==) (true ${entityWorkspaceFilter})
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves less-than TRUE cannot invert an approved scope
const unsafeScopeLessThanTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) < TRUE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves greater-than FALSE is rejected as an ordering test around an approved scope
const unsafeScopeGreaterThanFalse = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) > FALSE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves less-than-or-equal FALSE cannot invert an approved scope
const unsafeScopeLessThanOrEqualFalse = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) <= FALSE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves greater-than-or-equal TRUE is rejected as an ordering test around an approved scope
const unsafeScopeGreaterThanOrEqualTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) >= TRUE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves reversed TRUE-greater-than ordering cannot invert an approved scope
const unsafeTrueGreaterThanScope = sql`
  SELECT * FROM search_documents sd
  WHERE TRUE > (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves reversed FALSE-less-than ordering is rejected around an approved scope
const unsafeFalseLessThanScope = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE < (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves reversed FALSE-greater-than-or-equal ordering cannot invert an approved scope
const unsafeFalseGreaterThanOrEqualScope = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE >= (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves reversed TRUE-less-than-or-equal ordering is rejected around an approved scope
const unsafeTrueLessThanOrEqualScope = sql`
  SELECT * FROM search_documents sd
  WHERE TRUE <= (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves BETWEEN cannot test an approved scope as a Boolean value
const unsafeScopeBetweenFalse = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) BETWEEN FALSE AND FALSE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves NOT BETWEEN cannot invert an approved scope as a Boolean value
const unsafeScopeNotBetweenTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) NOT BETWEEN TRUE AND TRUE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an approved scope cannot become a BETWEEN lower bound
const unsafeScopeAsBetweenLowerBound = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE BETWEEN (true ${entityWorkspaceFilter}) AND TRUE
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an approved scope cannot become a BETWEEN upper bound
const unsafeScopeAsBetweenUpperBound = sql`
  SELECT * FROM search_documents sd
  WHERE FALSE BETWEEN TRUE AND (true ${entityWorkspaceFilter})
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a postfix cast cannot turn an approved Boolean scope into an inverse test
const unsafeCastScopeComparedToZero = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter})::int = 0
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a cast scope cannot become the right operand of an inverse operator test
const unsafeZeroComparedToCastScope = sql`
  SELECT * FROM search_documents sd
  WHERE 0 = (true ${entityWorkspaceFilter})::int
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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an outer SELECT scope cannot authorize an unscoped UPDATE CTE read
const unsafeScopeOutsideUpdateCte = sql`
  WITH updated_entities AS (
    UPDATE entities e
    SET title = sd.title
    FROM search_documents sd
    WHERE e.id = sd.entity_id
    RETURNING e.id
  )
  SELECT sd.*
  FROM entities sd
  WHERE true ${entityWorkspaceFilter}
`;

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an outer SELECT scope cannot authorize an unscoped DELETE CTE read
const unsafeScopeOutsideDeleteCte = sql`
  WITH deleted_entities AS (
    DELETE FROM entities e
    USING search_documents sd
    WHERE e.id = sd.entity_id
    RETURNING e.id
  )
  SELECT sd.*
  FROM entities sd
  WHERE true ${entityWorkspaceFilter}
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

const scopedUpdateFromEntity = sql`
  UPDATE entities e
  SET title = sd.title
  FROM search_documents sd
  WHERE e.id = sd.entity_id
    AND true ${entityWorkspaceFilter}
`;

const scopedInterpolatedUpdateFromEntity = sql`
  UPDATE entities e
  SET title = sd.title
  FROM ${searchDocuments} sd
  WHERE e.id = sd.entity_id
    AND true ${entityWorkspaceFilter}
`;

const scopedDeleteUsingEntity = sql`
  DELETE FROM entities e
  USING search_documents sd
  WHERE e.id = sd.entity_id
    AND true ${entityWorkspaceFilter}
`;

const scopedInterpolatedDeleteUsingEntity = sql`
  DELETE FROM entities e
  USING ${searchDocuments} sd
  WHERE e.id = sd.entity_id
    AND true ${entityWorkspaceFilter}
`;

const scopedMergeUsingEntity = sql`
  MERGE INTO entities e
  USING (
    SELECT *
    FROM search_documents sd
    WHERE true ${entityWorkspaceFilter}
  ) sd
  ON e.id = sd.entity_id
  WHEN NOT MATCHED THEN
    INSERT (id) VALUES (sd.entity_id)
`;

const scopedNestedMergeSource = sql`
  WITH merged_entities AS (
    MERGE INTO entities e
    USING (
      SELECT *
      FROM search_documents sd
      WHERE true ${entityWorkspaceFilter}
    ) sd
    ON e.id = sd.entity_id
    WHEN MATCHED THEN
      UPDATE SET title = sd.title
  )
  SELECT * FROM merged_entities
`;

const scopedUpdateCte = sql`
  WITH updated_entities AS (
    UPDATE entities e
    SET title = sd.title
    FROM search_documents sd
    WHERE e.id = sd.entity_id
      AND true ${entityWorkspaceFilter}
    RETURNING e.id
  )
  SELECT * FROM updated_entities
`;

const scopedDeleteCte = sql`
  WITH deleted_entities AS (
    DELETE FROM entities e
    USING search_documents sd
    WHERE e.id = sd.entity_id
      AND true ${entityWorkspaceFilter}
    RETURNING e.id
  )
  SELECT * FROM deleted_entities
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

const scopedComparedToTrue = sql`
  SELECT * FROM search_documents sd
  WHERE (true ${entityWorkspaceFilter}) = TRUE
`;

const scopedWithNumericOrdering = sql`
  SELECT * FROM search_documents sd
  WHERE rank > 0
    AND true ${entityWorkspaceFilter}
`;

const scopedAfterNumericBetween = sql`
  SELECT * FROM search_documents sd
  WHERE rank BETWEEN 0 AND 10
    AND true ${entityWorkspaceFilter}
`;

const scopedBeforeNumericBetween = sql`
  SELECT * FROM search_documents sd
  WHERE true ${entityWorkspaceFilter}
    AND rank BETWEEN 0 AND 10
`;

const scopedAfterOrdinaryCast = sql`
  SELECT * FROM search_documents sd
  WHERE rank::int = 0
    AND true ${entityWorkspaceFilter}
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

const scopedPrivateFrom = () =>
  sql`FROM search_documents sd WHERE true ${entityWorkspaceFilter}`;
const scopedLocalHelperPrivateRead = sql`SELECT * ${scopedPrivateFrom()}`;

// oxlint-disable-next-line arrow-body-style -- block body exercises block-return helper analysis
const scopedPrivateFromBlock = () => {
  return sql`FROM search_documents sd`;
};
const scopedBlockHelperPrivateRead = sql`
  SELECT * ${scopedPrivateFromBlock()}
  WHERE true ${entityWorkspaceFilter}
`;

const scopedFromTable = (table: unknown, scope: unknown) =>
  sql`FROM ${table} sd WHERE true ${scope}`;
const scopedParameterizedHelperRead = sql`
  SELECT *
  ${scopedFromTable(searchDocuments, entityWorkspaceFilter)}
`;

const publicParameterizedHelperRead = sql`
  SELECT * ${fromTable(sql`entities`)}
`;

const scopedFromEitherTable = (
  table: unknown,
  scope: unknown,
  fallback: unknown,
) =>
  enabled ? sql`FROM ${table} sd WHERE true ${scope}` : sql`FROM ${fallback}`;
const scopedBranchedParameterizedHelperRead = sql`
  SELECT *
  ${scopedFromEitherTable(
    searchDocuments,
    entityWorkspaceFilter,
    sql`entities e`,
  )}
`;

const shadowedParameterHelper = (table: unknown) => {
  void table;
  // oxlint-disable-next-line no-shadow -- fixture proves parameter substitution uses binding identity rather than names
  const selectPublic = (table: unknown) => sql`FROM ${table}`;
  return selectPublic(sql`entities e`);
};
const shadowedParameterControl = sql`
  SELECT * ${shadowedParameterHelper(searchDocuments)}
`;

const scopedMemberFragments = {
  from: sql`FROM search_documents sd`,
  where: sql`WHERE true ${entityWorkspaceFilter}`,
};
const scopedMemberFragmentRead = sql`
  SELECT * ${scopedMemberFragments.from} ${scopedMemberFragments.where}
`;

const scopedTupleFragments = [
  sql`FROM search_documents sd`,
  sql`WHERE true ${entityWorkspaceFilter}`,
] as const;
const scopedTupleFragmentRead = sql`
  SELECT * ${scopedTupleFragments[0]} ${scopedTupleFragments[1]}
`;

const scopedMemberFromKey = "from";
const scopedMemberWhereKey = "where";
const scopedComputedMemberFragmentRead = sql`
  SELECT *
  ${scopedMemberFragments[scopedMemberFromKey]}
  ${scopedMemberFragments[scopedMemberWhereKey]}
`;

const scopedTupleFromIndex = 0;
const scopedTupleWhereIndex = 1;
const scopedComputedTupleFragmentRead = sql`
  SELECT *
  ${scopedTupleFragments[scopedTupleFromIndex]}
  ${scopedTupleFragments[scopedTupleWhereIndex]}
`;

// Exact static selection must not inspect an unselected private sibling.
const selectedPublicMemberFragment = sql`
  SELECT * ${memberFragments.publicFrom}
`;
const selectedPublicTupleFragment = sql`SELECT * ${tupleFragments[1]}`;

declare const dynamicPublicFragmentKey: "first" | "second";
const dynamicPublicFragments = {
  first: sql`FROM entities e`,
  second: sql`FROM workspaces w`,
};
const dynamicPublicMemberFragment = sql`
  SELECT * ${dynamicPublicFragments[dynamicPublicFragmentKey]}
`;

declare const dynamicScopedFragmentKey: "privateFrom" | "publicFrom";
const dynamicScopedFragments = {
  privateFrom: sql`
    FROM search_documents sd
    WHERE true ${entityWorkspaceFilter}
  `,
  publicFrom: sql`FROM entities e`,
};
const scopedDynamicMemberFragment = sql`
  SELECT * ${dynamicScopedFragments[dynamicScopedFragmentKey]}
`;

declare const dynamicScopedTupleIndex: 0 | 1;
const dynamicScopedTupleFragments = [
  sql`
    FROM search_documents sd
    WHERE true ${entityWorkspaceFilter}
  `,
  sql`FROM entities e`,
] as const;
const scopedDynamicTupleFragment = sql`
  SELECT * ${dynamicScopedTupleFragments[dynamicScopedTupleIndex]}
`;

const scopedSplitRawRelationFragment = sql`
  SELECT * FROM ${privateRawRelationPrefix}documents sd
  WHERE true ${entityWorkspaceFilter}
`;

const scopedSplitTemplateRelationFragment = sql`
  SELECT * FROM ${privateTemplateRelationPrefix}documents sd
  WHERE true ${entityWorkspaceFilter}
`;

// Opaque parameter expressions must remain a boundary between SQL text chunks.
const opaqueParameterBoundary = sql`
  SELECT * FROM ${organizationId}search_documents sd
`;

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

const scopedRootJoinedPrivateRead = sql.join([
  sql`SELECT * FROM search_documents sd WHERE true `,
  entityWorkspaceFilter,
]);

const scopedOrdinaryDoubledQuote = sql`
  SELECT 'masked '' FROM search_documents sd' AS note
  FROM search_documents sd
  WHERE true ${entityWorkspaceFilter}
`;

const scopedEscapeStringRead = sql`
  SELECT E'masked \\' FROM search_documents sd' AS note
  FROM search_documents sd
  WHERE true ${entityWorkspaceFilter}
`;

const scopedSplitEscapeStringRead = sql.join([
  sql`SELECT E`,
  sql`'masked \\' FROM search_documents sd' AS note
      FROM search_documents sd
      WHERE true `,
  entityWorkspaceFilter,
]);

const scopedAppendedPrivateRead = sql`SELECT * FROM `
  .append(sql`search_`)
  .append(sql`documents sd WHERE true `)
  .append(entityWorkspaceFilter);

const publicAppendedRead = sql`SELECT * FROM `.append(sql`entities e`);

const scopedEscapedKeyword = sql`
  SELECT * FROM search_documents sd
  WHERE tr\x75e ${entityWorkspaceFilter}
`;

const scopedEscapedCommentMarkerString = sql`
  SELECT '\x2d\x2d' AS marker, sd.*
  FROM search_documents sd
  WHERE true ${entityWorkspaceFilter}
`;

const scopedInterpolatedRootJoinedPrivateRead = sql`
  ${sql.join([
    sql`SELECT * FROM search_documents sd WHERE true `,
    entityWorkspaceFilter,
  ])}
`;

const scopedNestedRootJoinedPrivateRead = sql.join([
  sql`SELECT * `,
  sql.join([sql`FROM search_documents sd WHERE true `, entityWorkspaceFilter]),
]);

const publicRootJoinedRead = sql.join([
  sql`SELECT * FROM entities e`,
  sql` WHERE e.id IS NOT NULL`,
]);

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

const writeOnlyUpdateEntityProjection = sql`
  UPDATE search_documents sd
  SET title = sd.title
  WHERE sd.entity_id = ${organizationId}
`;

const writeOnlyInterpolatedUpdateEntityProjection = sql`
  UPDATE ${searchDocuments}
  SET title = title
  WHERE entity_id = ${organizationId}
`;

const writeOnlyDeleteEntityProjection = sql`
  DELETE FROM search_documents
  WHERE entity_id = ${organizationId}
`;

const writeOnlyInterpolatedDeleteEntityProjection = sql`
  DELETE FROM ${searchDocuments}
  WHERE entity_id = ${organizationId}
`;

const writeOnlyMergeEntityProjection = sql`
  MERGE INTO search_documents sd
  USING entities e
  ON false
  WHEN NOT MATCHED THEN
    INSERT (entity_id) VALUES (e.id)
`;

// Public case law is intentionally organization-independent.
const publicCaseLaw = sql`SELECT * FROM case_law_search_documents clsd`;

void [
  unsafeEntity,
  unsafeBuilderEntity,
  unsafeUppercaseEntity,
  unsafeQualifiedEntity,
  unsafeQuotedEntity,
  unsafeCommaFormEntity,
  unsafeCommaFormInterpolatedEntity,
  unsafeInterpolatedEntity,
  unsafeAliasedInterpolatedEntity,
  unsafeUpdateFromEntity,
  unsafeInterpolatedUpdateFromEntity,
  unsafeDeleteUsingEntity,
  unsafeInterpolatedDeleteUsingEntity,
  unsafeMergeUsingEntity,
  unsafeMergeOnScopeEntity,
  unsafeNestedMergeSource,
  unsafeChatCount,
  unsafeConditionalScope,
  unsafeNestedHelper,
  unsafeShadowedHelper,
  unsafeLineCommentScope,
  unsafeEscapedLineCommentScope,
  unsafeUnavailableCookedSql,
  unsafeUnavailableCookedSqlAlias,
  unsafeBlockCommentScope,
  unsafeNestedBlockCommentScope,
  unsafeDollarQuotedScope,
  unsafeOrdinaryBackslashQuote,
  unsafeEscapeStringRead,
  unsafeTableRead,
  unsafeOnlyEntity,
  unsafeQualifiedOnlyEntity,
  unsafeQuotedOnlyEntity,
  unsafeOnlyInterpolatedEntity,
  unsafeCommaOnlyInterpolatedEntity,
  unsafeComposedPrivateRead,
  unsafeLocalHelperPrivateRead,
  unsafeAliasedLocalHelperPrivateRead,
  unsafeBlockHelperPrivateRead,
  unsafeParameterizedHelperRead,
  unsafeDeclaredHelperRead,
  unsafeBranchedParameterizedHelperRead,
  unsafeMemberHelperRead,
  unsafeComputedDefinitionMemberHelperRead,
  unsafeMissingArgumentMemberHelperRead,
  unsafeDynamicMemberHelperRead,
  unsafeMemberFragmentRead,
  unsafeTupleFragmentRead,
  unsafeComputedMemberFragmentRead,
  unsafeEscapedTemplateMemberFragmentRead,
  unsafeComputedTupleFragmentRead,
  unsafeDynamicMemberFragmentRead,
  unsafeDynamicTupleFragmentRead,
  unsafeJoinedPrivateFragment,
  unsafeSplitJoinedPrivateFragment,
  unsafeJoinedMultiBranch,
  unsafeRootJoinedPrivateRead,
  unsafeRootFromListPrivateRead,
  unsafeAppendedPrivateRead,
  separatedAppendPrivateRead,
  multiAppendScopedPrivateRead,
  conditionalScopeAppendPrivateRead,
  unsafeOpaqueReceiverPrivateAppend,
  unsafeOpaqueReceiverImportedAppend,
  unsafeOpaqueRootJoinedPrivateRead,
  unsafeRawEntity,
  unsafeRawTemplateEntity,
  unsafeEscapedRawTemplateEntity,
  unsafeDynamicRawRoot,
  unsafeAliasedDynamicRawRoot,
  unsafeComposedDynamicRawEntity,
  unsafeOpaqueRelationWithAttachedAlias,
  unsafeDynamicRawSelectExpression,
  unsafeStaticIdentifierEntity,
  unsafeImportedOpaqueRelation,
  unsafeNamespaceImportedEntity,
  unsafeUnresolvedRootComposition,
  unsafeCopyEntityProjection,
  unsafeDynamicIdentifierRelation,
  unsafeUnicodeEscapedEntity,
  unsafeCustomUnicodeEscapedEntity,
  unsafeLowercaseUnicodeEscapedEntity,
  unsafeUnsupportedUnicodeEscapeEntity,
  unsafeRawRelationFragment,
  unsafeSplitRawRelationFragment,
  unsafeSplitTemplateRelationFragment,
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
  unsafeExplicitOperatorBeforeScope,
  unsafeExplicitOperatorAfterScope,
  unsafeCustomExplicitOperatorBeforeScope,
  unsafeScopeTestedAsFalse,
  unsafeScopeComparedToFalse,
  unsafeScopeDistinctFromTrue,
  unsafeScopeInFalseMembership,
  unsafeScopeNotInTrueMembership,
  unsafeScopeLessThanTrue,
  unsafeScopeGreaterThanFalse,
  unsafeScopeLessThanOrEqualFalse,
  unsafeScopeGreaterThanOrEqualTrue,
  unsafeTrueGreaterThanScope,
  unsafeFalseLessThanScope,
  unsafeFalseGreaterThanOrEqualScope,
  unsafeTrueLessThanOrEqualScope,
  unsafeScopeBetweenFalse,
  unsafeScopeNotBetweenTrue,
  unsafeScopeAsBetweenLowerBound,
  unsafeScopeAsBetweenUpperBound,
  unsafeCastScopeComparedToZero,
  unsafeZeroComparedToCastScope,
  unsafeScopeInNestedQuery,
  unsafeScopeInSiblingQuery,
  unsafeScopeOutsideUpdateCte,
  unsafeScopeOutsideDeleteCte,
  scopedEntity,
  scopedSingleWorkspace,
  scopedInterpolatedEntity,
  scopedAliasedInterpolatedEntity,
  scopedUpdateFromEntity,
  scopedInterpolatedUpdateFromEntity,
  scopedDeleteUsingEntity,
  scopedInterpolatedDeleteUsingEntity,
  scopedMergeUsingEntity,
  scopedNestedMergeSource,
  scopedUpdateCte,
  scopedDeleteCte,
  scopedExplicitAlias,
  scopedAfterLineComment,
  scopedAfterDollarQuote,
  scopedParenthesizedFilter,
  scopedAfterFunctionArgument,
  scopedAfterNestedQuery,
  scopedTestedAsTrue,
  scopedInTrueMembership,
  scopedNotInFalseMembership,
  scopedComparedToTrue,
  scopedWithNumericOrdering,
  scopedAfterNumericBetween,
  scopedBeforeNumericBetween,
  scopedAfterOrdinaryCast,
  scopedNestedPrivateRead,
  scopedComposedRead,
  scopedLocalHelperPrivateRead,
  scopedAliasedLocalHelperRead,
  scopedBlockHelperPrivateRead,
  scopedParameterizedHelperRead,
  publicParameterizedHelperRead,
  scopedBranchedParameterizedHelperRead,
  scopedMemberHelperRead,
  scopedComputedDefinitionMemberHelperRead,
  scopedDynamicMemberHelperRead,
  publicMissingArgumentMemberHelperRead,
  shadowedParameterControl,
  scopedMemberFragmentRead,
  scopedTupleFragmentRead,
  scopedComputedMemberFragmentRead,
  scopedComputedTupleFragmentRead,
  selectedPublicMemberFragment,
  selectedPublicTupleFragment,
  dynamicPublicMemberFragment,
  scopedDynamicMemberFragment,
  scopedDynamicTupleFragment,
  scopedSplitRawRelationFragment,
  scopedSplitTemplateRelationFragment,
  opaqueParameterBoundary,
  scopedJoinedPrivateFragment,
  scopedParenthesizedJoinedEntity,
  scopedParenthesizedJoinedInterpolatedEntity,
  scopedJoinedMultiBranch,
  scopedRawJoinedMultiBranch,
  scopedRootJoinedPrivateRead,
  scopedRootFromListPrivateRead,
  scopedStaticIdentifierEntity,
  publicStaticIdentifierEntity,
  dynamicIdentifierColumnControl,
  dynamicRawNonRootTypeFragment,
  staticRawPublicExpression,
  scopedCustomUnicodeEscapedEntity,
  publicUnicodeEscapedEntity,
  scopedOrdinaryDoubledQuote,
  scopedEscapeStringRead,
  scopedSplitEscapeStringRead,
  scopedSingleAppendPrivateRead,
  scopedAppendedPrivateRead,
  publicAppendedRead,
  scopedEscapedKeyword,
  scopedEscapedCommentMarkerString,
  scopedInterpolatedRootJoinedPrivateRead,
  scopedNestedRootJoinedPrivateRead,
  publicRootJoinedRead,
  scopedOpaquePrivateFragment,
  scopedConditionalPrivateFragment,
  scopedMultiBranch,
  scopedMatter,
  scopedContact,
  scopedChat,
  writeOnlyEntityProjection,
  writeOnlyInterpolatedEntityProjection,
  writeOnlyUpdateEntityProjection,
  writeOnlyInterpolatedUpdateEntityProjection,
  writeOnlyDeleteEntityProjection,
  writeOnlyInterpolatedDeleteEntityProjection,
  writeOnlyMergeEntityProjection,
  unrelatedAppendControl,
  scopedOpaqueReceiverPrivateAppend,
  publicOpaqueReceiverAppend,
  staticPublicRelationControl,
  importedOpaqueNonRootControl,
  nonSqlUnavailableCooked,
  nonSqlPrivateText,
  nonSqlNestedPrivateText,
  publicCaseLaw,
];
