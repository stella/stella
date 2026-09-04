// Confine each owned capability to the module that owns it.
//
// One data-driven rule replaces the per-capability rules this repository used
// to grow one at a time. Two properties force that shape:
//
//   - `no-restricted-imports` cannot carry these bans. An oxlint override
//     REPLACES a rule's whole configuration instead of merging it, so a
//     per-scope entry silently deletes every restriction a broader scope
//     already installed for the same files.
//   - The owner list is also the documentation. `scripts/ownership.ts` renders
//     `docs/module-ownership.md` from the same table this rule reads, so a
//     capability cannot be enforced in one place and described in another.
//
// Detection boundary: syntax only. An `import` row matches an import source
// equal to a listed specifier or ending in its final segment (the `@/`, deep
// relative, and `.ts` spellings of one module). A `global-member` row matches
// the full member chain `<object>.<path...>` on the global, including the
// optional-chained form and the `window.` / `globalThis.` / `self.` prefixes,
// so a sibling member of the same object (`navigator.clipboard.readText` next
// to `navigator.clipboard.writeText`) is untouched. A value reached through an
// alias, a re-export, or a computed member access is out of scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  filenameForContext,
  isAstNode,
  isIdentifier,
  isMemberAccess,
  isStringLiteral,
} from "./utils.ts";

const GLOBAL_ROOTS = ["window", "globalThis", "self"] as const;

type ImportEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  specifiers: readonly string[];
};

type GlobalMemberEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  object: string;
  memberPath: readonly string[];
};

const stringsFrom = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const allowedPathsFrom = (entry: object, enforcement: object): string[] => {
  const owner = stringsFrom(Reflect.get(entry, "owner"));
  const allowed = Reflect.get(enforcement, "allowed");
  const allowedPaths = Array.isArray(allowed)
    ? allowed
        .map((item) =>
          typeof item === "object" && item !== null
            ? Reflect.get(item, "path")
            : undefined,
        )
        .filter((item): item is string => typeof item === "string")
    : [];
  return [...owner, ...allowedPaths];
};

type ConfiguredEntries = {
  importEntries: ImportEntry[];
  globalMemberEntries: GlobalMemberEntry[];
};

const configuredEntries = (context: {
  options?: readonly unknown[];
}): ConfiguredEntries => {
  const importEntries: ImportEntry[] = [];
  const globalMemberEntries: GlobalMemberEntry[] = [];
  const options = context.options?.[0];
  if (typeof options !== "object" || options === null) {
    return { importEntries, globalMemberEntries };
  }
  const entries = Reflect.get(options, "entries");
  if (!Array.isArray(entries)) {
    return { importEntries, globalMemberEntries };
  }

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const id = Reflect.get(entry, "id");
    const enforcement = Reflect.get(entry, "enforcement");
    if (typeof id !== "string") {
      continue;
    }
    if (typeof enforcement !== "object" || enforcement === null) {
      continue;
    }
    const owner = stringsFrom(Reflect.get(entry, "owner")).join(", ");
    const paths = allowedPathsFrom(entry, enforcement);
    const kind = Reflect.get(enforcement, "kind");

    if (kind === "import") {
      importEntries.push({
        id,
        owner,
        paths,
        specifiers: stringsFrom(Reflect.get(enforcement, "specifiers")),
      });
      continue;
    }
    if (kind === "global-member") {
      const object = Reflect.get(enforcement, "object");
      const memberPath = stringsFrom(Reflect.get(enforcement, "path"));
      if (typeof object !== "string" || memberPath.length === 0) {
        continue;
      }
      globalMemberEntries.push({ id, owner, paths, object, memberPath });
    }
  }

  return { importEntries, globalMemberEntries };
};

// A listed path is either a file (matched as a filename suffix, so the same
// entry works from any working directory) or a directory prefix ending in "/".
const coversFile = (allowedPath: string, filename: string): boolean =>
  allowedPath.endsWith("/")
    ? filename.includes(allowedPath)
    : filename.endsWith(allowedPath);

// The alias, deep-relative, and extension spellings of one module resolve to
// the same file, so a specifier also matches on its last two segments.
const specifierSuffix = (specifier: string): string =>
  `/${specifier.split("/").slice(-2).join("/")}`;

const isOwnedSpecifier = (
  specifiers: readonly string[],
  source: unknown,
): boolean => {
  if (typeof source !== "string") {
    return false;
  }
  return specifiers.some((specifier) => {
    const suffix = specifierSuffix(specifier);
    return (
      source === specifier ||
      source.endsWith(suffix) ||
      source.endsWith(`${suffix}.ts`)
    );
  });
};

const isGlobalObject = (node: unknown, object: string): boolean =>
  isIdentifier(node, object) ||
  GLOBAL_ROOTS.some((root) => isMemberAccess(node, root, object));

// One step of a member chain: `<something>.<segment>`, spelled with a dot.
const isMemberStep = (
  node: unknown,
  segment: string,
): node is AstNode & { object: unknown } =>
  isAstNode(node) &&
  node.type === "MemberExpression" &&
  node.computed === false &&
  isIdentifier(node.property, segment);

// Walk the member chain from its outermost property inwards: the node under
// test must spell every listed segment, in order, over the global object.
// Optional chaining changes only the `optional` flag, so the same walk covers
// `navigator?.clipboard?.writeText`.
const isOwnedMemberPath = (
  node: unknown,
  object: string,
  memberPath: readonly string[],
): boolean => {
  let current: unknown = node;
  for (let index = memberPath.length - 1; index >= 0; index -= 1) {
    if (!isMemberStep(current, memberPath[index])) {
      return false;
    }
    current = current.object;
  }
  return isGlobalObject(current, object);
};

export default eslintCompatPlugin({
  meta: { name: "confine-owner" },
  rules: {
    "confine-owner": {
      meta: {
        type: "problem",
        messages: {
          unownedUse:
            "`{{id}}` is owned by {{owner}}. Go through the owner, or add this file to that entry's `allowed` list with a reason in scripts/ownership.ts.",
        },
        schema: [
          {
            type: "object",
            properties: { entries: { type: "array" } },
            additionalProperties: false,
          },
        ],
      },
      createOnce(context) {
        // Options are fixed for the rule instance; only the filename gate is
        // per-file, so the table is parsed once rather than per linted file.
        let configured: ConfiguredEntries | null = null;
        let activeImports: readonly ImportEntry[] = [];
        let activeGlobalMembers: readonly GlobalMemberEntry[] = [];

        return {
          before() {
            const filename = filenameForContext(context);
            configured ??= configuredEntries(context);
            const { importEntries, globalMemberEntries } = configured;
            const applies = (entry: { paths: readonly string[] }) =>
              !entry.paths.some((allowedPath) =>
                coversFile(allowedPath, filename),
              );

            activeImports = importEntries.filter(applies);
            activeGlobalMembers = globalMemberEntries.filter(applies);
            return activeImports.length > 0 || activeGlobalMembers.length > 0;
          },
          ImportDeclaration(node) {
            for (const entry of activeImports) {
              if (isOwnedSpecifier(entry.specifiers, node.source.value)) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
          },
          ImportExpression(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            for (const entry of activeImports) {
              if (isOwnedSpecifier(entry.specifiers, node.source.value)) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
          },
          MemberExpression(node) {
            if (node.computed) {
              return;
            }
            for (const entry of activeGlobalMembers) {
              if (isOwnedMemberPath(node, entry.object, entry.memberPath)) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
          },
        };
      },
    },
  },
});
