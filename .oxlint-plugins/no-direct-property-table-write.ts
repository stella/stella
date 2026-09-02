// Property rows carry derived columns (kinds) that every writer must keep
// consistent. A handler or lib module that inserts/updates `properties`
// directly, off to the side of the canonical owner surfaces, can reconstruct
// those derived columns independently and drift — the same bug class
// `no-direct-audit-log-insert` guards against for `auditLogs`.
//
// The ban is deliberately scoped to `.insert(properties)` /
// `.update(properties)` and aliases imported from the canonical schema
// module: other Drizzle writes are unrelated, and an arbitrary local
// identifier is not assumed to name the properties table — only a local
// bound by a value import of `properties` from `@/api/db/schema` (aliases
// included) counts; a same-named local that never imports it is unrelated,
// and a type-only import cannot be passed to `.insert()`/`.update()` so it
// does not bind either.
//
// Owner surfaces (may write `properties` directly):
//   - apps/api/src/handlers/properties/**
//   - apps/api/src/lib/properties/**
//   - apps/api/src/lib/workflow/materialize-playbook-run.ts
//   - apps/api/src/lib/views/template-properties.ts
//   - apps/api/src/handlers/workspaces/create.ts
//   - apps/api/src/handlers/workspaces/duplicate.ts
//
// Test files are out of scope: `*.test.ts` (including `*.integration.test.ts`
// and `*.db.test.ts`, both of which still end in `.test.ts`), anything under
// `apps/api/src/tests/`, and `rls-helpers.ts` build and assert fixture rows
// directly and are not production writers.
//
// Escape hatch for a known partial writer that only ever sets a
// non-derived column (see `apps/api/src/lib/workflow-queue.ts`):
//   // oxlint-disable-next-line no-direct-property-table-write/no-direct-property-table-write
//   // SAFETY: <reason this write cannot affect a derived column>

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  filenameForContext,
  getImportedName,
  getImportLocalName,
  isAstNode,
  isIdentifier,
  isStringLiteral,
} from "./utils.ts";

const OWNER_DIRECTORY_PREFIXES = [
  "apps/api/src/handlers/properties/",
  "apps/api/src/lib/properties/",
];

const OWNER_FILES = new Set([
  "apps/api/src/lib/workflow/materialize-playbook-run.ts",
  "apps/api/src/lib/views/template-properties.ts",
  "apps/api/src/handlers/workspaces/create.ts",
  "apps/api/src/handlers/workspaces/duplicate.ts",
]);

const FIXTURE_FILE_SUFFIX =
  ".oxlint-plugins/__fixtures__/no-direct-property-table-write.fixture.ts";

const isOwnerFile = (filename: string): boolean =>
  OWNER_DIRECTORY_PREFIXES.some((prefix) => filename.includes(prefix)) ||
  [...OWNER_FILES].some((owner) => filename.endsWith(owner));

// `*.test.ts` also matches `*.integration.test.ts` / `*.db.test.ts`: both
// still end in `.test.ts`, and the glob-style suffix check is intentionally
// permissive rather than enumerating every test-file naming convention.
const isTestFile = (filename: string): boolean =>
  /\.test\.tsx?$/u.test(filename) ||
  filename.includes("apps/api/src/tests/") ||
  filename.includes("apps/api/src/test/") ||
  filename.endsWith("rls-helpers.ts");

export default eslintCompatPlugin({
  meta: { name: "no-direct-property-table-write" },
  rules: {
    "no-direct-property-table-write": {
      meta: {
        type: "problem",
        messages: {
          directWrite:
            "Property rows carry derived columns (kinds); write them " +
            "through apps/api/src/handlers/properties or " +
            "apps/api/src/lib/properties so every writer applies the same " +
            "rules.",
        },
      },
      createOnce(context) {
        const propertyBindings = new Set<string>();
        return {
          before() {
            propertyBindings.clear();
            const filename = filenameForContext(context);
            if (filename.endsWith(FIXTURE_FILE_SUFFIX)) {
              return true;
            }
            return (
              filename.includes("apps/api/src/") &&
              !isTestFile(filename) &&
              !isOwnerFile(filename)
            );
          },
          ImportDeclaration(node) {
            if (
              !isStringLiteral(node.source) ||
              node.source.value !== "@/api/db/schema" ||
              !Array.isArray(node.specifiers) ||
              node.importKind === "type"
            ) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (
                (isAstNode(specifier) && specifier.importKind === "type") ||
                getImportedName(specifier) !== "properties"
              ) {
                continue;
              }
              const localName = getImportLocalName(specifier);
              if (localName !== null) {
                propertyBindings.add(localName);
              }
            }
          },
          CallExpression(node) {
            const callee = node.callee;
            const firstArgument = node.arguments.at(0);
            if (
              !isAstNode(callee) ||
              callee.type !== "MemberExpression" ||
              !(
                isIdentifier(callee.property, "insert") ||
                isIdentifier(callee.property, "update")
              ) ||
              !isIdentifier(firstArgument) ||
              !propertyBindings.has(firstArgument.name)
            ) {
              return;
            }
            context.report({ node, messageId: "directWrite" });
          },
        };
      },
    },
  },
});
