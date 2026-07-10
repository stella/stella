// Require every read of a tenant-owned table to carry an application-level
// `where`, so a forgotten filter cannot return rows across matters/orgs.
//
// conventions-scale mandates filtering by tenant ID in the query. Postgres
// RLS (apps/api/src/db/rls.ts, `createScopedDb` / `createSafeDb`) is a
// defense-in-depth backstop that scopes every scoped-transaction row to the
// caller's organization and the caller's workspace *memberships* — not to
// the single workspace/matter the current handler is acting on. A query
// with no application-level `where` can still return rows from every
// workspace the caller happens to belong to, which is the wrong result
// even though it is not a cross-tenant leak.
//
// TENANT_TABLES is a snapshot of the tables in apps/api/src/db/schema/*.ts
// whose column set includes a `workspaceId:` and/or `organizationId:` key.
// Regenerate by scanning `p.pgTable(` blocks for those keys (array-typed
// columns like `workspaceIds`/`organizationIds` on account-deletion-style
// global-by-userId tables do not count — only the singular FK). Update this
// list whenever schema adds a new tenant-owned table; a table missing here
// silently falls outside this rule. A future improvement could derive this
// list automatically from the Drizzle schema at lint-config build time
// instead of hand-maintaining it, but that is not built here.
//
// This rule flags only the highest-signal case: a call site with NO
// `where` at all. It does not — and structurally cannot from syntax alone —
// prove that an existing `where` actually filters on the tenant column.
// Like `no-unscoped-user-query`, that verification is left to the reviewer.
//
// Flags:
//   db.query.entities.findMany()
//   db.query.entities.findFirst({ orderBy: x })        // no `where` key
//   db.select({ id: entities.id }).from(entities).orderBy(x) // no `.where(` in chain
//
// Allows:
//   db.query.entities.findFirst({ where: eq(entities.id, id) })
//   db.query.entities.findMany({ where: someCondition }) // any `where` key present
//   db.query.entities.findMany(opts)                     // opaque options: skip
//   db.select({ id: entities.id }).from(entities).where(eq(entities.workspaceId, ws))
//   db.select({ id: fields.id }).from(fields).innerJoin(entities, and(...)) // join ON
//     // condition counts the same as `.where(...)` -- see JOIN_METHODS below
//   db.select().from(nonTenantTable)                     // table not in TENANT_TABLES
//
// Escape hatch (root-scoped admin, migration, seed, or global-corpus code
// that intentionally reads across tenants):
//   // oxlint-disable-next-line require-tenant-scope/require-tenant-scope
//   // SAFETY: root-scoped admin job; intentionally iterates every org.

import { getCalleeName, getPropertyName, isIdentifier } from "./utils.ts";

// prettier-ignore
const TENANT_TABLES = new Set([
  "agentSkillResources", "agentSkills",
  "anonymizationAllowlistEntries", "anonymizationBlacklistEntries",
  "auditLogs",
  "billingCodes",
  "caseLawMatterLinks",
  "cellMetadata",
  "chatMessages", "chatThreads",
  "clauseCategories", "clauseVariants", "clauseVersions", "clauses",
  "contactRelationships", "contactSearchDocuments", "contacts",
  "desktopEditHandoffs", "desktopEditSessions",
  "documentCounters", "documentTypes",
  "entities", "entityLinks", "entityVersionAiSummaries", "entityVersions",
  "expenses", "extractedContent",
  "fields", "fileChatThreads",
  "folioCollabSessionTokens", "folioCollabSessions",
  "infoSoudTrackedCases", "invoices",
  "justifications",
  "matterCounters",
  "mcpConnectors", "mcpOAuthClients", "mcpOAuthState", "mcpUserConnections",
  "organizationSettings",
  "pendingUploads", "playbookDefinitionVersions", "playbookDefinitions",
  "properties", "propertyDependencies",
  "rateEntries", "rateTables", "reportExports",
  "searchDocuments",
  "taskAssignees",
  "templateCategories", "templateChatThreads", "templateClauses",
  "templateFills", "templateRecipes", "templateVersions", "templates",
  "timeEntries",
  "usageAllocations", "usageEntitlements", "usageEvents",
  "workspaceContacts", "workspaceMembers", "workspaceSearchDocuments",
  "workspaceViewTemplates", "workspaceViews", "workspaces",
]);

const RELATIONAL_QUERY_RE =
  /(?:^|\.)query\.(?<table>[A-Za-z0-9_]+)\.(?<method>findMany|findFirst)$/;

// A join's second argument is a mandatory ON condition, the same syntactic
// role as `.where(...)`; codebase convention folds tenant-scoping into a
// join predicate (e.g. `.innerJoin(entities, and(eq(fields.entityVersionId,
// entities.currentVersionId), inArray(entities.id, alreadyScopedIds)))`)
// at least as often as a trailing `.where(...)`. Treat any join in the
// chain the same as `.where(...)`: it is not proof the predicate references
// the tenant column, only the same absence-only signal `.where(...)` gets.
const JOIN_METHODS = new Set([
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
]);

// An options arg satisfies the rule only when it is an object literal
// carrying a `where` key. A non-object (variable / spread) arg is opaque
// and skipped; a missing arg or an object literal without `where` is
// flagged. Mirrors require-query-limit's `findManyLimitState`.
type WhereState = "missing" | "present" | "opaque";

const relationalWhereState = (callExpression): WhereState => {
  const args = callExpression.arguments;
  if (!Array.isArray(args) || args.length === 0) {
    return "missing";
  }
  const options = args[0];
  if (options.type !== "ObjectExpression") {
    return "opaque";
  }
  for (const property of options.properties) {
    if (property.type === "SpreadElement") {
      return "opaque";
    }
    if (property.type !== "Property") {
      continue;
    }
    if (getPropertyName(property.key) === "where") {
      return "present";
    }
  }
  return "missing";
};

// Collect every method name invoked across the whole fluent chain that
// `node` (a method-call CallExpression) participates in, walking down
// through `callee.object` (earlier links) and up through `parent` (later
// links) so the position of `node` in the chain does not matter. Copied
// from require-query-limit.ts's `collectChainMethodNames`.
const collectChainMethodNames = (node): Set<string> => {
  const names = new Set<string>();

  let current = node;
  while (
    current?.type === "CallExpression" &&
    current.callee?.type === "MemberExpression"
  ) {
    const name = getPropertyName(current.callee.property);
    if (name !== null) {
      names.add(name);
    }
    current = current.callee.object;
  }

  let child = node;
  let parent = node.parent;
  while (parent) {
    if (
      parent.type !== "MemberExpression" ||
      parent.computed ||
      parent.object !== child
    ) {
      break;
    }
    const grandparent = parent.parent;
    if (
      grandparent?.type !== "CallExpression" ||
      grandparent.callee !== parent
    ) {
      break;
    }
    const name = getPropertyName(parent.property);
    if (name !== null) {
      names.add(name);
    }
    child = grandparent;
    parent = grandparent.parent;
  }

  return names;
};

export default {
  meta: { name: "require-tenant-scope" },
  rules: {
    "require-tenant-scope": {
      meta: {
        type: "problem",
        messages: {
          relationalNoWhere:
            "Drizzle `{{method}}` on tenant-owned table '{{table}}' has no " +
            "`where`, so it can return rows across every workspace the " +
            "caller belongs to. Add a `where` that filters by the request's " +
            "workspace/organization ID, or disable with a `// SAFETY:` note " +
            "when the read is intentionally root-scoped.",
          selectNoWhere:
            "A Drizzle select on tenant-owned table '{{table}}' has no " +
            "`.where(...)` anywhere in the chain, so it can return rows " +
            "across every workspace the caller belongs to. Add " +
            "`.where(...)` filtering by the request's workspace/" +
            "organization ID, or disable with a `// SAFETY:` note when the " +
            "read is intentionally root-scoped.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const dotted = getCalleeName(node.callee);
            const relationalMatch =
              dotted === null ? null : RELATIONAL_QUERY_RE.exec(dotted);
            if (relationalMatch) {
              const { table, method } = relationalMatch.groups;
              if (
                TENANT_TABLES.has(table) &&
                relationalWhereState(node) === "missing"
              ) {
                context.report({
                  node,
                  messageId: "relationalNoWhere",
                  data: { table, method },
                });
              }
              return;
            }

            // `.from(<tenantTable>)` — only meaningful as part of a
            // `select(...).from(...)` chain; guard on the immediate
            // `.select(` predecessor to avoid matching unrelated `.from()`
            // calls (`Array.from`, `Buffer.from`, `dayjs().from`, ...).
            if (
              node.callee?.type !== "MemberExpression" ||
              node.callee.computed ||
              getPropertyName(node.callee.property) !== "from"
            ) {
              return;
            }

            const chainRoot = node.callee.object;
            if (
              chainRoot?.type !== "CallExpression" ||
              chainRoot.callee?.type !== "MemberExpression" ||
              chainRoot.callee.computed ||
              getPropertyName(chainRoot.callee.property) !== "select"
            ) {
              return;
            }

            const tenantTableArg = node.arguments.find(
              (arg) => isIdentifier(arg) && TENANT_TABLES.has(arg.name),
            );
            if (!tenantTableArg) {
              return;
            }

            const chain = collectChainMethodNames(node);
            if (
              chain.has("where") ||
              [...chain].some((name) => JOIN_METHODS.has(name))
            ) {
              return;
            }

            context.report({
              node: node.callee.property,
              messageId: "selectNoWhere",
              data: { table: tenantTableArg.name },
            });
          },
        };
      },
    },
  },
};
