import { chatThreadScopeSql } from "@/api/lib/search/chat-thread-scope-sql";
import {
  contactWorkspaceAccessSql,
  workspaceAccessSql,
} from "@/api/lib/search/contact-workspace-access-sql";

declare const sql: (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;
declare const organizationId: string;

const entityWorkspaceFilter = workspaceAccessSql({});
const singleWorkspaceFilter = workspaceAccessSql({});

// oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves an unscoped private projection read is rejected
const unsafeEntity = sql`SELECT * FROM search_documents sd WHERE sd.organization_id = ${organizationId}`;

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
    ${() => workspaceAccessSql}
`;

const unsafeShadowedHelper = (() => {
  const workspaceAccessSql = (_scope: unknown) => "";
  // oxlint-disable-next-line require-search-scope/require-search-scope -- fixture proves a same-named local cannot impersonate the approved import
  return sql`SELECT * FROM search_documents sd WHERE true ${workspaceAccessSql({})}`;
})();

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

const scopedMatter = sql`
  SELECT *
  FROM workspace_search_documents wsd
  WHERE true
    ${workspaceAccessSql({ column: "wsd.workspace_id" })}
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
  unsafeChatCount,
  unsafeConditionalScope,
  unsafeNestedHelper,
  unsafeShadowedHelper,
  scopedEntity,
  scopedSingleWorkspace,
  scopedMatter,
  scopedContact,
  scopedChat,
  publicCaseLaw,
];
