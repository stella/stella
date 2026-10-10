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
// that resolves to a listed module: relative, `@/` alias, and extension
// spellings compare by canonical module id, and a subpath of a listed bare
// package (`@tanstack/ai/<subpath>`) is the same package. It matches whether
// the source is imported or re-exported: a facade that re-exports the owner's dependency would hand the
// capability to every consumer without naming it. A row that also lists
// `names` matches only a declaration that binds one of them, or a namespace
// import, a star re-export, and a dynamic import, which reach every export; the
// specifier's other exports stay open, so one package entry point can carry
// an owned capability next to unrelated ones. A dynamic import counts as the
// names it is destructured into (`const { a } = await import("m")`) or read
// through (`(await import("m")).a`); held in any other shape, the module
// object reaches every export. A `global-member` row matches
// the full member chain `<object>.<path...>` on the global, including the
// optional-chained form and the `window.` / `globalThis.` / `self.` prefixes,
// so a sibling member of the same object (`navigator.clipboard.readText` next
// to `navigator.clipboard.writeText`) is untouched. A `member-call` row matches
// a call of the named method on any receiver, including the optional-chained
// form, in files under one of its `within` prefixes; the method name alone is
// too common to confine repository-wide. A `function-call` row matches a direct
// call of the named identifier in its scoped paths, including optional calls
// and value-preserving TypeScript wrappers. This kind compares identifier names,
// not bindings: renaming the function or its callback binding is unrecognized.
// A `literal-pattern` row matches its
// regular expression against cooked string and template text; constructing
// the value across separate expressions is outside this syntax boundary.
// A `table-column-read` row follows canonical table imports, namespace and
// stable local aliases, and Drizzle aliases. It confines column access,
// destructuring, column-map extraction, and implicit full-row selections.
// Relational reads must explicitly select other columns or exclude the owned
// columns. Dynamic keys and opaque relational projections count conservatively.
// Cross-module local re-exports, mutable aliases and custom query wrappers are
// outside this syntax boundary.

import { eslintCompatPlugin, type Context } from "@oxlint/plugins";

import {
  type AstNode,
  canonicalModuleId,
  type FilenameContext,
  filenameForContext,
  getImportedName,
  getPropertyName,
  isAstNode,
  isIdentifier,
  isIdentifierReference,
  isMemberAccess,
  isStringLiteral,
  memberPropertyName,
  resolveImport,
  resolveVariable,
  repoRelativeFilename,
  type ScopeContext,
  stableInitializer,
  staticStringValue,
  TRANSPARENT_WRAPPERS,
  unwrapExpression,
} from "./utils.ts";

const GLOBAL_ROOTS = ["window", "globalThis", "self"] as const;
const TABLE_SELECTION_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "innerJoinLateral",
  "leftJoinLateral",
  "crossJoin",
  "crossJoinLateral",
]);

type ImportEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  // Canonical module ids of the listed specifiers.
  modules: readonly string[];
  // `null` confines the whole specifier.
  names: readonly string[] | null;
};

type GlobalMemberEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  object: string;
  // The member path from its outermost property inwards.
  reversedMemberPath: readonly string[];
};

type MemberCallEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  method: string;
  within: readonly string[];
};

type FunctionCallEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  name: string;
  within: readonly string[];
};

type LiteralPatternEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  pattern: RegExp;
};

type TableColumnReadEntry = {
  id: string;
  owner: string;
  paths: readonly string[];
  modules: readonly string[];
  table: string;
  columns: readonly string[];
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
  memberCallEntries: MemberCallEntry[];
  functionCallEntries: FunctionCallEntry[];
  literalPatternEntries: LiteralPatternEntry[];
  tableColumnReadEntries: TableColumnReadEntry[];
};

const configuredEntries = (context: {
  options?: readonly unknown[];
}): ConfiguredEntries => {
  const importEntries: ImportEntry[] = [];
  const globalMemberEntries: GlobalMemberEntry[] = [];
  const memberCallEntries: MemberCallEntry[] = [];
  const functionCallEntries: FunctionCallEntry[] = [];
  const literalPatternEntries: LiteralPatternEntry[] = [];
  const tableColumnReadEntries: TableColumnReadEntry[] = [];
  const configured = {
    importEntries,
    globalMemberEntries,
    memberCallEntries,
    functionCallEntries,
    literalPatternEntries,
    tableColumnReadEntries,
  };
  const options = context.options?.[0];
  if (typeof options !== "object" || options === null) {
    return configured;
  }
  const entries = Reflect.get(options, "entries");
  if (!Array.isArray(entries)) {
    return configured;
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
    const owners = stringsFrom(Reflect.get(entry, "owner"));
    const owner = owners.join(", ");
    const paths = allowedPathsFrom(entry, enforcement);
    const kind = Reflect.get(enforcement, "kind");

    if (kind === "table-column-read") {
      const table = Reflect.get(enforcement, "table");
      const columns = stringsFrom(Reflect.get(enforcement, "columns"));
      if (typeof table !== "string" || columns.length === 0) {
        continue;
      }
      tableColumnReadEntries.push({
        id,
        owner,
        paths,
        modules: stringsFrom(Reflect.get(enforcement, "specifiers")).map(
          (specifier) => canonicalModuleId(specifier, owners.at(0) ?? ""),
        ),
        table,
        columns,
      });
      continue;
    }

    if (kind === "literal-pattern") {
      const pattern = Reflect.get(enforcement, "pattern");
      if (typeof pattern !== "string") {
        continue;
      }
      literalPatternEntries.push({
        id,
        owner,
        paths,
        pattern: new RegExp(pattern),
      });
      continue;
    }

    if (kind === "import") {
      const names = Reflect.get(enforcement, "names");
      // An `@/` specifier names a module of the owner's app, so it resolves
      // against the owner's path.
      const ownerPath = owners.at(0) ?? "";
      importEntries.push({
        id,
        owner,
        paths,
        modules: stringsFrom(Reflect.get(enforcement, "specifiers")).map(
          (specifier) => canonicalModuleId(specifier, ownerPath),
        ),
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
      globalMemberEntries.push({
        id,
        owner,
        paths,
        object,
        reversedMemberPath: memberPath.toReversed(),
      });
      continue;
    }
    if (kind === "member-call") {
      const method = Reflect.get(enforcement, "method");
      const within = stringsFrom(Reflect.get(enforcement, "within"));
      if (typeof method !== "string" || within.length === 0) {
        continue;
      }
      memberCallEntries.push({ id, owner, paths, method, within });
      continue;
    }
    if (kind === "function-call") {
      const name = Reflect.get(enforcement, "name");
      const within = stringsFrom(Reflect.get(enforcement, "within"));
      if (typeof name !== "string" || within.length === 0) {
        continue;
      }
      functionCallEntries.push({ id, owner, paths, name, within });
    }
  }

  return configured;
};

// A listed path is either a file (matched as a filename suffix, so the same
// entry works from any working directory) or a directory prefix ending in "/".
const coversFile = (allowedPath: string, filename: string): boolean =>
  allowedPath.endsWith("/")
    ? filename.includes(allowedPath)
    : filename.endsWith(allowedPath);

// A canonical id that is still a bare package specifier (not a repository
// path) owns its subpaths too. A listed source file must be spelled as its
// repository path (`packages/<name>/src/<file>`): relative imports resolve to
// that path, and a shorter spelling would read as a bare package no relative
// import can reach.
const isBarePackage = (moduleId: string): boolean =>
  !moduleId.startsWith("apps/") &&
  !moduleId.startsWith("packages/") &&
  !moduleId.startsWith(".");

const isOwnedModule = (
  modules: readonly string[],
  sourceModuleId: string,
): boolean =>
  modules.some(
    (moduleId) =>
      sourceModuleId === moduleId ||
      (isBarePackage(moduleId) && sourceModuleId.startsWith(`${moduleId}/`)),
  );

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

// The export names a dynamic import is destructured into or read through, or
// null when the module object is held in a shape that reaches every export
// (bound whole, passed on, a rest element or a computed key).
const dynamicImportNames = (node: unknown): readonly string[] | null => {
  if (!isAstNode(node)) {
    return null;
  }
  let current = node;
  let parent = isAstNode(current.parent) ? current.parent : null;
  while (
    parent !== null &&
    (parent.type === "AwaitExpression" || TRANSPARENT_WRAPPERS.has(parent.type))
  ) {
    current = parent;
    parent = isAstNode(current.parent) ? current.parent : null;
  }
  if (parent === null) {
    return null;
  }
  if (parent.type === "MemberExpression" && parent.object === current) {
    const name = memberPropertyName(parent);
    return name === null ? null : [name];
  }
  if (
    parent.type !== "VariableDeclarator" ||
    parent.init !== current ||
    !isAstNode(parent.id) ||
    parent.id.type !== "ObjectPattern" ||
    !Array.isArray(parent.id.properties)
  ) {
    return null;
  }
  const names: string[] = [];
  for (const property of parent.id.properties) {
    if (
      !isAstNode(property) ||
      property.type !== "Property" ||
      (property.computed === true && !isStringLiteral(property.key))
    ) {
      return null;
    }
    const name = getPropertyName(property.key);
    if (name === null) {
      return null;
    }
    names.push(name);
  }
  return names;
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
  reversedMemberPath: readonly string[],
): boolean => {
  let current: unknown = node;
  // Iterate the values, not the indices: an indexed read is `string |
  // undefined` under the plugins project's strict index access and plain
  // `string` under the lint's program, so either the guard or the compiler
  // has to be wrong about it.
  for (const segment of reversedMemberPath) {
    if (!isMemberStep(current, segment)) {
      return false;
    }
    current = current.object;
  }
  return isGlobalObject(current, object);
};

type TableReadOptions = {
  context: ScopeContext & FilenameContext;
  entry: TableColumnReadEntry;
  value: unknown;
  seen?: Set<unknown>;
};

const isOwnedTable = ({
  context,
  entry,
  value,
  seen = new Set<unknown>(),
}: TableReadOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return false;
  }
  seen.add(node);
  const imported = resolveImport(context, node);
  if (
    imported?.imported === entry.table &&
    entry.modules.includes(imported.moduleId)
  ) {
    return true;
  }
  if (isIdentifierReference(node)) {
    const variable = resolveVariable(context, node);
    return (
      variable !== null &&
      isOwnedTable({
        context,
        entry,
        value: stableInitializer(variable),
        seen,
      })
    );
  }
  if (node.type !== "CallExpression" || !Array.isArray(node.arguments)) {
    return false;
  }
  const callee = resolveImport(context, node.callee);
  return (
    callee?.imported === "alias" &&
    isOwnedModule(["drizzle-orm"], callee.moduleId) &&
    isOwnedTable({ context, entry, value: node.arguments.at(0), seen })
  );
};

const stableValue = (
  context: ScopeContext,
  value: unknown,
  seen = new Set<unknown>(),
): AstNode | null => {
  const node = unwrapExpression(value);
  if (node === null || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (!isIdentifierReference(node)) {
    return node;
  }
  const variable = resolveVariable(context, node);
  return variable === null
    ? null
    : stableValue(context, stableInitializer(variable), seen);
};

const objectProperty = (node: unknown, name: string): AstNode | null => {
  if (
    !isAstNode(node) ||
    node.type !== "ObjectExpression" ||
    !Array.isArray(node.properties)
  ) {
    return null;
  }
  let result: AstNode | null = null;
  for (const property of node.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      return null;
    }
    const key = property.computed
      ? staticStringValue(property.key)
      : getPropertyName(property.key);
    if (key === null) {
      return null;
    }
    if (key === name) {
      result = isAstNode(property.value) ? property.value : null;
    }
  }
  return result;
};

const relationSelectsOwnedColumns = ({
  context,
  entry,
  value,
}: TableReadOptions): boolean => {
  const options = stableValue(context, value);
  const columns = stableValue(context, objectProperty(options, "columns"));
  if (
    columns?.type !== "ObjectExpression" ||
    !Array.isArray(columns.properties)
  ) {
    return true;
  }
  const decisions = new Map<string, boolean>();
  for (const property of columns.properties) {
    if (!isAstNode(property) || property.type !== "Property") {
      return true;
    }
    const key = property.computed
      ? staticStringValue(property.key)
      : getPropertyName(property.key);
    const decision = stableValue(context, property.value);
    if (
      key === null ||
      decision?.type !== "Literal" ||
      typeof decision.value !== "boolean"
    ) {
      return true;
    }
    decisions.set(key, decision.value);
  }
  if (entry.columns.some((column) => decisions.get(column) === true)) {
    return true;
  }
  return (
    ![...decisions.values()].includes(true) &&
    entry.columns.some((column) => decisions.get(column) !== false)
  );
};

const isOwnedRelation = ({
  context,
  entry,
  value,
}: TableReadOptions): boolean => {
  const node = stableValue(context, value);
  if (
    node?.type !== "MemberExpression" ||
    memberPropertyName(node) !== entry.table
  ) {
    return false;
  }
  const query = unwrapExpression(node.object);
  return (
    query?.type === "MemberExpression" && memberPropertyName(query) === "query"
  );
};

const patternReadsOwnedColumns = (
  pattern: unknown,
  columns: readonly string[],
): boolean => {
  if (
    !isAstNode(pattern) ||
    pattern.type !== "ObjectPattern" ||
    !Array.isArray(pattern.properties)
  ) {
    return false;
  }
  return pattern.properties.some((property) => {
    if (!isAstNode(property) || property.type !== "Property") {
      return true;
    }
    const key = property.computed
      ? staticStringValue(property.key)
      : getPropertyName(property.key);
    return key === null || columns.includes(key);
  });
};

// Find the originating select/insert/update in a fluent query chain.
const chainCall = (
  value: unknown,
  methods: readonly string[],
): AstNode | null => {
  let node = unwrapExpression(value);
  while (node?.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    if (callee?.type !== "MemberExpression") {
      return null;
    }
    const method = memberPropertyName(callee);
    if (method !== null && methods.includes(method)) {
      return node;
    }
    node = unwrapExpression(callee.object);
  }
  return null;
};

const isImplicitOwnedRead = ({
  context,
  entry,
  value,
}: TableReadOptions): boolean => {
  const call = unwrapExpression(value);
  if (call?.type !== "CallExpression" || !Array.isArray(call.arguments)) {
    return false;
  }
  const callee = unwrapExpression(call.callee);
  if (callee?.type !== "MemberExpression") {
    return false;
  }
  const method = memberPropertyName(callee);
  if (method === "findFirst" || method === "findMany") {
    return (
      isOwnedRelation({ context, entry, value: callee.object }) &&
      relationSelectsOwnedColumns({
        context,
        entry,
        value: call.arguments.at(0),
      })
    );
  }
  if (
    method !== null &&
    TABLE_SELECTION_METHODS.has(method) &&
    isOwnedTable({ context, entry, value: call.arguments.at(0) })
  ) {
    const select = chainCall(callee.object, [
      "select",
      "selectDistinct",
      "selectDistinctOn",
    ]);
    if (select === null || !Array.isArray(select.arguments)) {
      return false;
    }
    const selectionMethod = isAstNode(select.callee)
      ? memberPropertyName(select.callee)
      : null;
    return (
      select.arguments.at(selectionMethod === "selectDistinctOn" ? 1 : 0) ===
      undefined
    );
  }
  if (method !== "returning" || call.arguments.length !== 0) {
    return false;
  }
  const mutation = chainCall(callee.object, ["insert", "update", "delete"]);
  return (
    mutation !== null &&
    Array.isArray(mutation.arguments) &&
    isOwnedTable({ context, entry, value: mutation.arguments.at(0) })
  );
};

const isOwnedColumnRead = ({
  context,
  entry,
  value,
}: TableReadOptions): boolean => {
  const node = unwrapExpression(value);
  if (node === null) {
    return false;
  }
  switch (node.type) {
    case "CallExpression": {
      if (!Array.isArray(node.arguments)) {
        return false;
      }
      const callee = resolveImport(context, node.callee);
      const extractsColumns =
        callee?.imported === "getTableColumns" &&
        isOwnedModule(["drizzle-orm"], callee.moduleId) &&
        isOwnedTable({ context, entry, value: node.arguments.at(0) });
      return (
        extractsColumns || isImplicitOwnedRead({ context, entry, value: node })
      );
    }
    case "MemberExpression": {
      const property = memberPropertyName(node);
      return (
        (property === null || entry.columns.includes(property)) &&
        isOwnedTable({ context, entry, value: node.object })
      );
    }
    case "VariableDeclarator":
      return (
        patternReadsOwnedColumns(node.id, entry.columns) &&
        isOwnedTable({ context, entry, value: node.init })
      );
    case "AssignmentExpression":
      return (
        patternReadsOwnedColumns(node.left, entry.columns) &&
        isOwnedTable({ context, entry, value: node.right })
      );
    case "SpreadElement":
      return isOwnedTable({ context, entry, value: node.argument });
    default:
      return false;
  }
};

const createColumnReadReporter =
  (context: Context, entries: () => readonly TableColumnReadEntry[]) =>
  (node: NonNullable<Parameters<typeof context.report>[0]["node"]>) => {
    for (const entry of entries()) {
      if (!isOwnedColumnRead({ context, entry, value: node })) {
        continue;
      }
      context.report({
        node,
        messageId: "unownedUse",
        data: { id: entry.id, owner: entry.owner },
      });
    }
  };

export default eslintCompatPlugin({
  meta: { name: "confine-owner" },
  rules: {
    "confine-owner": {
      meta: {
        type: "problem",
        messages: {
          unownedUse:
            "`{{id}}` is owned by {{owner}}. Go through the owner, or add this file to that entry's `allowed` list with a reason in scripts/ownership/<id>.ts.",
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
        let importerPath = "";
        let activeMemberCalls: readonly MemberCallEntry[] = [];
        let activeFunctionCalls: readonly FunctionCallEntry[] = [];
        let activeLiteralPatterns: readonly LiteralPatternEntry[] = [];
        let activeTableColumnReads: readonly TableColumnReadEntry[] = [];

        // `takesOwnedName` is `null` when the declaration reaches every
        // export (a star re-export, or a dynamic import held whole), which
        // matches any row.
        const reportOwnedBinding = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
          source: unknown,
          takesOwnedName: ((names: readonly string[]) => boolean) | null,
        ) => {
          if (typeof source !== "string") {
            return;
          }
          const sourceModuleId = canonicalModuleId(source, importerPath);
          for (const entry of activeImports) {
            if (!isOwnedModule(entry.modules, sourceModuleId)) {
              continue;
            }
            if (
              entry.names !== null &&
              takesOwnedName !== null &&
              !takesOwnedName(entry.names)
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

        const reportOwnedLiteral = (
          node: NonNullable<Parameters<typeof context.report>[0]["node"]>,
          text: unknown,
        ) => {
          if (typeof text !== "string") {
            return;
          }
          for (const entry of activeLiteralPatterns) {
            if (entry.pattern.test(text)) {
              context.report({
                node,
                messageId: "unownedUse",
                data: { id: entry.id, owner: entry.owner },
              });
            }
          }
        };

        const reportOwnedColumnRead = createColumnReadReporter(
          context,
          () => activeTableColumnReads,
        );

        return {
          before() {
            const filename = filenameForContext(context);
            importerPath = repoRelativeFilename(context);
            configured ??= configuredEntries(context);
            const {
              importEntries,
              globalMemberEntries,
              memberCallEntries,
              functionCallEntries,
              literalPatternEntries,
              tableColumnReadEntries,
            } = configured;
            const applies = (entry: { paths: readonly string[] }) =>
              !entry.paths.some((allowedPath) =>
                coversFile(allowedPath, filename),
              );

            activeImports = importEntries.filter(applies);
            activeGlobalMembers = globalMemberEntries.filter(applies);
            activeLiteralPatterns = literalPatternEntries.filter(applies);
            activeTableColumnReads = tableColumnReadEntries.filter(applies);
            activeMemberCalls = memberCallEntries.filter(
              (entry) =>
                applies(entry) &&
                entry.within.some((prefix) => coversFile(prefix, filename)),
            );
            activeFunctionCalls = functionCallEntries.filter(
              (entry) =>
                applies(entry) &&
                entry.within.some((prefix) => coversFile(prefix, filename)),
            );
            return (
              activeImports.length > 0 ||
              activeGlobalMembers.length > 0 ||
              activeMemberCalls.length > 0 ||
              activeFunctionCalls.length > 0 ||
              activeLiteralPatterns.length > 0 ||
              activeTableColumnReads.length > 0
            );
          },
          ImportDeclaration(node) {
            reportOwnedBinding(node, node.source.value, (names) =>
              bindsOwnedName(node.specifiers, names),
            );
          },
          Literal(node) {
            reportOwnedLiteral(node, node.value);
          },
          TemplateElement(node) {
            reportOwnedLiteral(node, node.value.cooked ?? node.value.raw);
          },
          // `export { x } from "..."`; a re-export of a local binding has no
          // source and is out of scope.
          ExportNamedDeclaration(node) {
            if (!isAstNode(node.source) || !isStringLiteral(node.source)) {
              return;
            }
            reportOwnedBinding(node, node.source.value, (names) =>
              bindsOwnedName(node.specifiers, names),
            );
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
            const taken = dynamicImportNames(node);
            reportOwnedBinding(
              node,
              node.source.value,
              taken === null
                ? null
                : (names) => taken.some((name) => names.includes(name)),
            );
          },
          CallExpression(node) {
            reportOwnedColumnRead(node);
            for (const entry of activeMemberCalls) {
              if (isMemberStep(node.callee, entry.method)) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
            const callee = unwrapExpression(node.callee);
            for (const entry of activeFunctionCalls) {
              if (isIdentifier(callee, entry.name)) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
          },
          MemberExpression(node) {
            reportOwnedColumnRead(node);
            if (node.computed) {
              return;
            }
            for (const entry of activeGlobalMembers) {
              if (
                isOwnedMemberPath(node, entry.object, entry.reversedMemberPath)
              ) {
                context.report({
                  node,
                  messageId: "unownedUse",
                  data: { id: entry.id, owner: entry.owner },
                });
              }
            }
          },
          VariableDeclarator: reportOwnedColumnRead,
          AssignmentExpression: reportOwnedColumnRead,
          SpreadElement: reportOwnedColumnRead,
        };
      },
    },
  },
});
