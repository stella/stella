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
// relative, and `.ts` spellings of one module), whether it is imported or
// re-exported: a facade that re-exports the owner's dependency would hand the
// capability to every consumer without naming it. A row that also lists
// `names` matches only a declaration that binds one of them, or a namespace
// import, a star re-export, and a dynamic import, which reach every export; the
// specifier's other exports stay open, so one package entry point can carry
// an owned capability next to unrelated ones. A `global-member` row matches
// the full member chain `<object>.<path...>` on the global, including the
// optional-chained form and the `window.` / `globalThis.` / `self.` prefixes,
// so a sibling member of the same object (`navigator.clipboard.readText` next
// to `navigator.clipboard.writeText`) is untouched. A value reached through an
// alias, a re-export of a local binding, or a computed member access is out of
// scope.

import { eslintCompatPlugin } from "@oxlint/plugins";

import type { AstNode } from "./utils.ts";
import {
  filenameForContext,
  getImportedName,
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
  // `null` confines the whole specifier.
  names: readonly string[] | null;
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
      const names = Reflect.get(enforcement, "names");
      importEntries.push({
        id,
        owner,
        paths,
        specifiers: stringsFrom(Reflect.get(enforcement, "specifiers")),
        names: names === undefined ? null : stringsFrom(names),
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

// The name a specifier takes from the module: `imported` on an import,
// `local` on a re-export (`export { local as exported } from "..."`).
const sourceBindingName = (specifier: AstNode): string | null => {
  if (specifier.type === "ExportSpecifier") {
    return isIdentifier(specifier.local)
      ? specifier.local.name
      : isStringLiteral(specifier.local)
        ? specifier.local.value
        : null;
  }
  return getImportedName(specifier);
};

// A declaration binds an owned name when it takes it by name from the module,
// or takes the namespace, through which every export is reachable. A default
// import is not one of the listed bindings.
const bindsOwnedName = (
  specifiers: unknown,
  names: readonly string[],
): boolean =>
  Array.isArray(specifiers) &&
  specifiers.some((specifier) => {
    if (!isAstNode(specifier)) {
      return false;
    }
    if (specifier.type === "ImportNamespaceSpecifier") {
      return true;
    }
    const name = sourceBindingName(specifier);
    return name !== null && names.includes(name);
  });

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
  // Iterate the values, not the indices: an indexed read is `string |
  // undefined` under the plugins project's strict index access and plain
  // `string` under the lint's program, so either the guard or the compiler
  // has to be wrong about it.
  for (const segment of memberPath.toReversed()) {
    if (!isMemberStep(current, segment)) {
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

        // `specifiers` is `null` when the declaration reaches every export
        // (a star re-export or a dynamic import), which matches any row.
        const reportOwnedBinding = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
          source: unknown,
          specifiers: unknown,
        ) => {
          for (const entry of activeImports) {
            if (!isOwnedSpecifier(entry.specifiers, source)) {
              continue;
            }
            if (
              entry.names !== null &&
              specifiers !== null &&
              !bindsOwnedName(specifiers, entry.names)
            ) {
              continue;
            }
            context.report({
              node,
              messageId: "unownedUse",
              data: { id: entry.id, owner: entry.owner },
            });
          }
        };

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
            reportOwnedBinding(node, node.source.value, node.specifiers);
          },
          // `export { x } from "..."`; a re-export of a local binding has no
          // source and is out of scope.
          ExportNamedDeclaration(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            reportOwnedBinding(node, node.source.value, node.specifiers);
          },
          // `export * from "..."` reaches every export, like a namespace import.
          ExportAllDeclaration(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            reportOwnedBinding(node, node.source.value, null);
          },
          ImportExpression(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            reportOwnedBinding(node, node.source.value, null);
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
