// Keep the public case-law reader loadable with database and search settings
// alone. The full API environment (`@/api/env`) and the document-processing
// environment it composes validate tenant content settings, such as the
// content encryption key, when they first evaluate; a process that only reads
// the public corpus has none of them and cannot load a module that imports
// either.
//
// The boundary is the value-import closure of the public reader entrypoints:
// the case-law decision search handler, the public corpus policy, and every
// `lib/legal-search/public-read-*` and `public-search-*` module. A file joins the boundary by being imported from
// it, so a new dependency is checked without being listed. Inside it, a value
// import, re-export or dynamic import of either environment module is
// reported; a type-only import is erased and stays allowed. Settings the
// reader needs come from a narrow env module such as `@/api/env-public-corpus`,
// or through a reader the API environment binds at boot (the action size
// limits in `lib/rate-limit/action-size-settings.ts`).
//
// Out of scope: `require` calls and specifiers the closure cannot read. The
// end-to-end guard is apps/api/src/env-public-corpus.test.ts, which loads the
// reader in a strict runtime without a content key.

import { eslintCompatPlugin } from "@oxlint/plugins";
import type { Context, Ranged } from "@oxlint/plugins";
import { readdirSync } from "node:fs";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import { guardEnforcesLine } from "../scripts/guard-rollouts.ts";
import { valueImportClosure } from "./case-law-replay-imports.ts";
import {
  canonicalModuleId,
  filenameForContext,
  staticStringValue,
} from "./utils.ts";

const RULE_NAME = "no-api-env-in-public-reader";
const ROOT = path.resolve(import.meta.dirname, "..");
const LEGAL_SEARCH = "apps/api/src/lib/legal-search";
const FIXTURE =
  ".oxlint-plugins/__fixtures__/no-api-env-in-public-reader.fixture.ts";

// Environment modules that validate tenant content settings at load.
const FORBIDDEN_MODULES = new Set([
  "apps/api/src/env",
  "apps/api/src/env-document-processing-worker",
]);

const publicReaderEntrypoints = (): string[] => [
  "apps/api/src/handlers/case-law/decisions/search.ts",
  "apps/api/src/public-corpus-policy.ts",
  ...readdirSync(path.join(ROOT, LEGAL_SEARCH))
    .filter(
      (file) =>
        /^public-(?:read|search)-.+\.ts$/u.test(file) &&
        !file.endsWith(".test.ts"),
    )
    .toSorted()
    .map((file) => `${LEGAL_SEARCH}/${file}`),
];

let boundary: ReadonlySet<string> | undefined;
/**
 * `filename` repository-relative. A file linted from a scratch root (the rule
 * tests) is read from its first `apps/api/` or `packages/` segment; null when
 * it has neither, as no closure file does.
 */
const closureRelativePath = (filename: string): string | null => {
  if (isPathInside(ROOT, filename)) {
    return repoRelativePath(ROOT, filename);
  }
  const segment = /\/(?:apps\/api|packages)\//u.exec(filename);
  return segment === null ? null : filename.slice(segment.index + 1);
};

/** The boundary module `filename` is, repository-relative, or null. */
const publicReaderModule = (filename: string): string | null => {
  if (filename.endsWith(FIXTURE)) {
    return FIXTURE;
  }
  const relative = closureRelativePath(filename);
  if (relative === null) {
    return null;
  }
  boundary ??= valueImportClosure({
    root: ROOT,
    entrypoints: publicReaderEntrypoints(),
    label: "Public reader",
    leaves: new Set(
      [...FORBIDDEN_MODULES].map((forbidden) => `${forbidden}.ts`),
    ),
  });
  return boundary.has(relative) ? relative : null;
};

type ImportSite = Ranged & {
  type: string;
  importKind?: unknown;
  exportKind?: unknown;
};

const isTypeOnly = (node: ImportSite): boolean =>
  node.importKind === "type" || node.exportKind === "type";

export default eslintCompatPlugin({
  meta: { name: RULE_NAME },
  rules: {
    [RULE_NAME]: {
      meta: {
        type: "problem",
        messages: {
          apiEnvironment:
            "The public case-law reader must load without tenant content settings. Read its settings from a narrow env module (for example @/api/env-public-corpus) instead of {{module}}.",
        },
      },
      createOnce(context: Context) {
        let readerModule: string | null = null;
        const check = (node: ImportSite, source: unknown) => {
          if (readerModule === null || isTypeOnly(node)) {
            return;
          }
          const specifier = staticStringValue(source);
          if (
            specifier === null ||
            !FORBIDDEN_MODULES.has(canonicalModuleId(specifier, readerModule))
          ) {
            return;
          }
          // First-week rollout: only lines this change touched
          // (scripts/guard-rollouts/no-api-env-in-public-reader.json).
          if (
            guardEnforcesLine({
              guard: RULE_NAME,
              file: filenameForContext(context),
              line: context.sourceCode.getLocFromIndex(node.range[0]).line,
            })
          ) {
            context.report({
              node,
              messageId: "apiEnvironment",
              data: { module: specifier },
            });
          }
        };
        return {
          before() {
            readerModule = publicReaderModule(filenameForContext(context));
            return readerModule !== null;
          },
          ImportDeclaration(node) {
            check(node, node.source);
          },
          ExportNamedDeclaration(node) {
            if (node.source !== null) {
              check(node, node.source);
            }
          },
          ExportAllDeclaration(node) {
            check(node, node.source);
          },
          ImportExpression(node) {
            check(node, node.source);
          },
        };
      },
    },
  },
});
