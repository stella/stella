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

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves every UNION branch needs its own verified scope
const unsafeMultiBranch = sql`
  SELECT * FROM search_documents sd
  WHERE true ${entityWorkspaceFilter} ${singleWorkspaceFilter}
  UNION ALL
  SELECT * FROM search_documents sd WHERE true
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

const scopedAfterLineComment = sql`
  SELECT * FROM search_documents sd
  -- explanatory comment
  WHERE true ${entityWorkspaceFilter}
`;

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
  unsafeMultiBranch,
  scopedEntity,
  scopedSingleWorkspace,
  scopedInterpolatedEntity,
  scopedAfterLineComment,
  scopedMultiBranch,
  scopedMatter,
  scopedContact,
  scopedChat,
  publicCaseLaw,
];
