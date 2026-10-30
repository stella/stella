// One table and one detector for "this import belongs to one owner module".
//
// Each row names the module(s), the exports it restricts (or the whole
// module), the owner files where the import is allowed, and the message
// pointing at the owner. The plugin files named after each rule
// (`no-nanoid.ts`, `no-raw-use-effect.ts`, ...) are thin entry points that
// keep the rule ids stable; the policy lives here.
//
// A restricted export is recognised however it is reached: a named import
// (aliased or not), a namespace or default import read as `ns.X`, `ns["X"]`
// or `<ns.X />`, `const { X } = ns`, `require("m").X`, `(await import("m")).X`,
// `const { X } = await import("m")`, and re-exports (`export { X } from "m"`,
// `export * from "m"`).

import type {
  Context,
  ESTree,
  Ranged,
  Scope,
  Variable,
  VisitorWithHooks,
} from "@oxlint/plugins";

import { type IconEntry, readIconEntries } from "./icon-ownership.ts";
import {
  type AstNode,
  canonicalModuleId,
  dynamicModuleSourceForEnforcement,
  getImportedName,
  getPropertyName,
  invokedCallee,
  isAstNode,
  isFileIn,
  isIdentifier,
  isIdentifierReference,
  isSingleAssignment,
  isStringLiteral,
  memberPropertyName,
  type ModuleMatcher,
  moduleMatches,
  NAMESPACE_IMPORT,
  patternKeyFor,
  repoRelativeFilename,
  type ResolvedImport,
  stableInitializer,
  staticStringValue,
  unwrapExpression,
} from "./utils.ts";

// --- Table ------------------------------------------------------------------

// Whether an `import type` / `export type` of the module still counts.
const TYPE_ONLY_IMPORTS = {
  allowed: "allowed",
  restricted: "restricted",
} as const;
type TypeOnlyImports =
  (typeof TYPE_ONLY_IMPORTS)[keyof typeof TYPE_ONLY_IMPORTS];

// Whether `import("m")` counts: a lazy boundary is the sanctioned shape for
// some modules, so only their static imports are restricted. `readableOnly`
// restricts dynamic imports too and also reports one whose specifier the
// rule cannot read (a parameter, a call result, a computed string): where a
// scope must be provably free of a module, an unreadable load cannot be
// admitted on trust.
const DYNAMIC_IMPORTS = {
  allowed: "allowed",
  restricted: "restricted",
  readableOnly: "readable-only",
} as const;
type DynamicImports = (typeof DYNAMIC_IMPORTS)[keyof typeof DYNAMIC_IMPORTS];

// Where a restricted export is reported: at the binding that brings it into
// scope, or at each call of it (so a suppression names one call site).
const EXPORT_HIT = { binding: "binding", call: "call" } as const;
type ExportHit = (typeof EXPORT_HIT)[keyof typeof EXPORT_HIT];

type Restriction =
  | {
      type: "module";
      typeOnlyImports: TypeOnlyImports;
      dynamicImports: DynamicImports;
    }
  | { type: "exports"; names: ReadonlySet<string>; hit: ExportHit };

type RestrictedImportEntry = {
  messageId: string;
  message: string;
  modules: readonly ModuleMatcher[];
  restriction: Restriction;
  // Repository paths (or path suffixes) where the import is allowed.
  owners: readonly string[];
};

// A bare package and every subpath of it (`nanoid`, `nanoid/non-secure`).
const packageWithSubpaths =
  (name: string) =>
  (moduleId: string): boolean =>
    moduleId === name || moduleId.startsWith(`${name}/`);

// lucide exports every glyph as `X`, `XIcon` and `LucideX`.
const lucideGlyphNames = (glyphs: readonly string[]): ReadonlySet<string> =>
  new Set(glyphs.flatMap((glyph) => [glyph, `${glyph}Icon`, `Lucide${glyph}`]));

// Test support (`asTestRaw` and the other unchecked casts) must not be
// reachable from production modules.
const isTestSupportModule = (moduleId: string): boolean =>
  moduleId.startsWith("apps/api/src/tests/");

// Parser code and the AST it builds, which a retention projection must not
// reach: the parser directories, the adapters that call them, and the
// legal-ast package.
const PARSER_OR_AST_ROOTS = [
  "apps/api/src/handlers/case-law/ingestion/parsers/",
  "apps/api/src/handlers/case-law/ingestion/adapters/",
  "apps/api/src/lib/legal-search/parsers/",
  "packages/legal-ast/",
] as const;
const LEGAL_AST = packageWithSubpaths("@stll/legal-ast");
const isParserOrAstModule = (moduleId: string): boolean =>
  LEGAL_AST(moduleId) ||
  PARSER_OR_AST_ROOTS.some((root) => moduleId.startsWith(root));

const RETENTION_ORACLE_MODULE =
  "apps/api/src/lib/legal-search/parsers/validate-ast";
const RETENTION_ORACLE_MODULE_FILE = `${RETENTION_ORACLE_MODULE}.ts`;
const RETENTION_CHECK_MODULE_FILE =
  "apps/api/src/handlers/case-law/ingestion/retention/retention-check.ts";

const LUCIDE = packageWithSubpaths("lucide-react");
// Every icon reaches the app through one module, so a glyph restricted to an
// owner component is restricted there too.
const ICON_MODULE = "packages/ui/src/icons.ts";
const ICON_SOURCES = [
  LUCIDE,
  "@stll/ui/icons",
  ICON_MODULE.replace(/\.ts$/u, ""),
] as const;
const TANSTACK_DEVTOOLS_ROOT =
  "apps/web/src/components/tanstack-devtools-root.tsx";
const TABLE_DEVTOOLS =
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx";
const TANSTACK_START_SERVER = "@tanstack/react-start/server";

const STATIC_DEVTOOLS_PACKAGE_MESSAGE =
  "Keep TanStack devtools package imports inside the approved lazy-loaded devtools modules.";

const staticDevtoolsPackage = (
  packages: readonly string[],
  owners: readonly string[],
): RestrictedImportEntry => ({
  messageId: "staticDevtoolsPackage",
  message: STATIC_DEVTOOLS_PACKAGE_MESSAGE,
  modules: packages,
  restriction: {
    type: "module",
    typeOnlyImports: TYPE_ONLY_IMPORTS.allowed,
    dynamicImports: DYNAMIC_IMPORTS.allowed,
  },
  owners,
});

// One row per icon-module entry that declares `ownedBy:`: the entry is
// importable only in its owner component (and the icon module). The message
// names the component, and the other entries drawing the same glyph for
// call sites that mean something else.
const ownedIconRestrictions = (
  entries: readonly IconEntry[],
): RestrictedImportEntry[] =>
  entries.flatMap((entry) => {
    if (entry.owner === null) {
      return [];
    }
    const alternatives = entries
      .filter((other) => other.owner === null && other.glyph === entry.glyph)
      .map((other) => other.name);
    const { component, path } = entry.owner;
    const otherMeaning =
      alternatives.length > 0
        ? `import ${alternatives.join(" or ")}, or add`
        : "add";
    return [
      {
        messageId: `unownedIcon${entry.name}`,
        message: [
          `Do not import '{{name}}' here: only <${component}> (${path})`,
          "draws it, because the component carries its behaviour.",
          `Render <${component}> instead. For another meaning ${otherMeaning}`,
          `a semantic entry in ${ICON_MODULE}.`,
        ].join(" "),
        modules: ICON_SOURCES,
        restriction: {
          type: "exports",
          names: new Set([entry.name]),
          hit: EXPORT_HIT.binding,
        },
        // The owner, the module that declares the entry, and its test.
        owners: [path, ICON_MODULE, "packages/ui/src/icons.test.ts"],
      },
    ];
  });

const RESTRICTED_IMPORT_RULES = {
  // One icon module decides what each glyph means (a skill, an AI action),
  // so a call site cannot pick a lucide glyph that means something else
  // elsewhere. See packages/ui/src/icons.ts for how to add one.
  "no-direct-lucide-import": [
    {
      messageId: "directLucideImport",
      message:
        "Import icons from '@stll/ui/icons' (packages/ui/src/icons.ts); " +
        "add a new icon there with a one-line reason.",
      modules: [LUCIDE],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      // The module, and its drift test, which compares entries against lucide.
      owners: [ICON_MODULE, "packages/ui/src/icons.test.ts"],
    },
  ],
  // Production API modules import nothing under apps/api/src/tests/; the
  // scope (production versus test files) is set by the rule's override in
  // oxlint.config.ts.
  "no-test-support-import": [
    {
      messageId: "noTestSupportImport",
      message:
        "Production modules must not import from apps/api/src/tests/. " +
        "Move test-only code under that directory and import it only from " +
        "tests.",
      modules: [isTestSupportModule],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      owners: [],
    },
  ],
  // nanoid is a removed dependency: IDs come from Bun.randomUUIDv7() and
  // custom alphabets from crypto.getRandomValues().
  "no-nanoid": [
    {
      messageId: "noNanoid",
      message:
        "Do not import nanoid. Use Bun.randomUUIDv7() for IDs or " +
        "crypto.getRandomValues() for custom alphabets.",
      modules: [packageWithSubpaths("nanoid")],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.restricted,
        dynamicImports: DYNAMIC_IMPORTS.restricted,
      },
      owners: [],
    },
  ],
  // Route code has one approved helper; other exports stay at the boundary.
  "confine-server-reads": [
    {
      messageId: "confineServerReads",
      message: "Use the approved server request helper for this access.",
      modules: [TANSTACK_START_SERVER],
      restriction: {
        type: "exports",
        names: new Set([
          "getCookie",
          "getCookies",
          "getRequest",
          "getRequestHeader",
          "getRequestHeaders",
        ]),
        hit: EXPORT_HIT.binding,
      },
      // Reads only the sidebar's own open-state cookie, a layout choice.
      owners: ["apps/web/src/components/sidebar/sidebar-state.ts"],
    },
  ],
  // `<MatterIcon>` always resolves a matter colour (or paints the deliberate
  // neutral variant), so the raw layers glyph is drawn only there.
  "no-direct-matter-glyph": [
    {
      messageId: "directMatterGlyph",
      message:
        "Do not import '{{name}}' from 'lucide-react' here. Render " +
        "<MatterIcon> from '@stll/ui/matter-icon' instead so the " +
        "matter colour is always applied (matter={{ id, color }}, or " +
        'variant="none" / variant="all" for non-matter affordances). ' +
        "The raw glyph is only allowed in matter-icon.tsx.",
      modules: ICON_SOURCES,
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Layers", "Layers2"]),
        hit: EXPORT_HIT.binding,
      },
      owners: ["packages/ui/src/components/matter-icon.tsx", ICON_MODULE],
    },
  ],
  // `<EntityKindIcon>` switches exhaustively over the entity kind. Only the
  // folder and task glyphs are restricted: they name a kind wherever they
  // appear, while file/mail/link glyphs carry ordinary non-entity meanings.
  // The `entity-kind-glyph-adhoc` ratchet metric covers the rest.
  "no-direct-entity-glyph": [
    {
      messageId: "directEntityGlyph",
      message:
        "Do not import '{{name}}' from 'lucide-react' here. Render " +
        '<EntityKindIcon kind="folder" | "task"> from ' +
        "'@/components/workspaces/entity-kind-icon' instead (pass " +
        'folderState="expanded" for an open folder), so every entity ' +
        "glyph comes from one exhaustive kind mapping. Use <EntityIcon> " +
        "when the entity is still resolving.",
      modules: ICON_SOURCES,
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Folder", "FolderOpen", "ListTodo"]),
        hit: EXPORT_HIT.binding,
      },
      owners: [
        "apps/web/src/components/workspaces/entity-kind-icon.tsx",
        ICON_MODULE,
      ],
    },
  ],
  // A glyph whose semantic entry declares `ownedBy:` in the icon module is
  // drawn only by that component (CopyButton confirms a copy in place), so a
  // call site cannot draw it with different behaviour. Read from icons.ts.
  "no-unowned-icon": ownedIconRestrictions(readIconEntries()),
  // Devtools packages can schedule browser work while routes are still
  // mounting, so they load only inside lazy islands, and the islands
  // themselves are reached only through `import()`.
  "no-static-devtools-import": [
    staticDevtoolsPackage(
      [
        "@tanstack/react-devtools",
        "@tanstack/react-query-devtools",
        "@tanstack/react-router-devtools",
      ],
      [TANSTACK_DEVTOOLS_ROOT],
    ),
    staticDevtoolsPackage(
      ["@tanstack/react-table-devtools"],
      [TANSTACK_DEVTOOLS_ROOT, TABLE_DEVTOOLS],
    ),
    {
      messageId: "staticDevtoolsModule",
      message:
        "Keep devtools modules behind a dynamic import so route shells can " +
        "mount before devtools code loads.",
      modules: [
        "apps/web/src/components/tanstack-devtools-root",
        "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools",
      ],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.allowed,
        dynamicImports: DYNAMIC_IMPORTS.allowed,
      },
      owners: [],
    },
  ],
  // Most effects are unnecessary; external-system sync goes through the
  // named wrappers so intent is explicit. See /conventions-use-effect.
  "no-raw-use-effect": [
    {
      messageId: "noRawUseEffect",
      message:
        "Direct useEffect is banned. Most effects are unnecessary: derive " +
        "state in render, do the work in the event handler, fetch with " +
        "TanStack Query, or reset with `key`. For genuine external-system " +
        "sync use useMountEffect or useExternalSyncEffect from " +
        "@/hooks/use-effect. See the convention: /conventions-use-effect.",
      modules: [packageWithSubpaths("react")],
      restriction: {
        type: "exports",
        names: new Set(["useEffect"]),
        hit: EXPORT_HIT.call,
      },
      owners: ["apps/web/src/hooks/use-effect.ts"],
    },
  ],
  // A retention projection reads the publisher's stored raw and nothing a
  // parser produced, so the oracle compares two independent readings. The
  // scope (the projection modules) is set by the rule's override in
  // oxlint.config.ts; types stay importable, since a stored envelope's shape
  // is shared data rather than parsing.
  "retention-source-independence": [
    {
      messageId: "retentionSourceIndependence",
      message:
        "A retention projection must not use parser code or AST builders: it " +
        "reads the stored sourceRaw on its own, so the retention check " +
        "compares against what the publisher served rather than against the " +
        "parser's own reading. Select the text from sourceRaw directly, and " +
        "load modules by a name the rule can read (a literal or a constant).",
      modules: [isParserOrAstModule],
      restriction: {
        type: "module",
        typeOnlyImports: TYPE_ONLY_IMPORTS.allowed,
        dynamicImports: DYNAMIC_IMPORTS.readableOnly,
      },
      owners: [],
    },
  ],
  // The pipeline checks every parsed decision against its source's retention
  // projection and is the only place that logs the retention signal: a parser
  // or adapter logging it would compare against its own intermediate text and
  // report the same decision twice. The pure measurement, `validateAst`, stays
  // importable everywhere, because parsers legitimately use its verdict to
  // choose between two parses.
  "retention-oracle-owner": [
    {
      messageId: "retentionOracleOwner",
      message:
        "Only the pipeline's retention check logs the text-retention signal. " +
        "Declare the source's projection in ingestion/retention/sources and " +
        "the pipeline checks every parsed decision against it; to choose " +
        "between parses, call validateAst and use its verdict without logging.",
      modules: [RETENTION_ORACLE_MODULE],
      restriction: {
        type: "exports",
        names: new Set(["validateAndLog"]),
        hit: EXPORT_HIT.binding,
      },
      owners: [RETENTION_ORACLE_MODULE_FILE, RETENTION_CHECK_MODULE_FILE],
    },
  ],
  "tooltip-provider-owner": [
    {
      messageId: "tooltipProviderOwner",
      message:
        "Do not mount a nested TooltipProvider. Use the provider owned by the app shell instead.",
      modules: ["@stll/ui/tooltip", "packages/ui/src/components/tooltip"],
      restriction: {
        type: "exports",
        names: new Set(["TooltipProvider"]),
        hit: EXPORT_HIT.binding,
      },
      owners: [
        "apps/web/src/app-providers.tsx",
        "apps/desktop/src/mainview/main.tsx",
        "packages/mcp-apps/src/case-law-results/app.tsx",
        "packages/mcp-apps/src/decision-reader/app.tsx",
      ],
    },
  ],
} as const satisfies Record<string, readonly RestrictedImportEntry[]>;

export type RestrictedImportRuleName = keyof typeof RESTRICTED_IMPORT_RULES;

// --- Resolution -------------------------------------------------------------

// A default import is read as the namespace too: `import React from "react"`
// then `React.useEffect` reaches the same export as `import * as React`.
const isNamespaceLike = (binding: ResolvedImport): boolean =>
  binding.imported === NAMESPACE_IMPORT || binding.imported === "default";

const canonical = (context: Context, source: string): string =>
  canonicalModuleId(source, repoRelativeFilename(context));

// The variable `name` binds at `node`, walking the scope chain outwards.
// Takes a name rather than an identifier so JSX names resolve too.
const variableAt = (
  context: Context,
  node: ESTree.Node,
  name: string,
): Variable | null => {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }
  return null;
};

// The text of a module specifier: a string literal, a template without
// expressions, or a binding assigned once from one of those, followed
// through aliases (`const PARSER = "m"; await import(PARSER)`). Null when
// the rule cannot read it.
const specifierText = (
  context: Context,
  node: unknown,
  seen = new Set<unknown>(),
): string | null => {
  const literal = staticStringValue(node);
  if (literal !== null) {
    return literal;
  }
  const expression = unwrapExpression(node);
  if (!isIdentifierReference(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  const variable = variableAt(context, expression, expression.name);
  const initializer = variable === null ? null : stableInitializer(variable);
  return initializer === null
    ? null
    : specifierText(context, initializer, seen);
};

// The module an expression loads: `import(specifier)` with a readable
// specifier, awaited or not, or a `require` the shared resolver recognizes.
const loadedModuleSource = (context: Context, node: unknown): string | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression)) {
    return null;
  }
  if (expression.type === "AwaitExpression") {
    return loadedModuleSource(context, expression.argument);
  }
  if (expression.type === "ImportExpression") {
    return specifierText(context, expression.source);
  }
  return dynamicModuleSourceForEnforcement(expression, context);
};

const exportOfVariable = (
  context: Context,
  variable: Variable,
  seen: Set<unknown>,
): ResolvedImport | null => {
  const definition = variable.defs.at(0);
  if (variable.defs.length !== 1 || definition === undefined) {
    return null;
  }
  const node: unknown = definition.node;
  if (definition.type === "ImportBinding") {
    const declaration: unknown = definition.parent;
    if (
      !isAstNode(node) ||
      node.importKind === "type" ||
      !isAstNode(declaration) ||
      declaration.importKind === "type" ||
      !isStringLiteral(declaration.source)
    ) {
      return null;
    }
    const moduleId = canonical(context, declaration.source.value);
    if (node.type === "ImportNamespaceSpecifier") {
      return { moduleId, imported: NAMESPACE_IMPORT };
    }
    if (node.type === "ImportDefaultSpecifier") {
      return { moduleId, imported: "default" };
    }
    const imported = getImportedName(node);
    return imported === null ? null : { moduleId, imported };
  }
  if (
    definition.type !== "Variable" ||
    !isAstNode(node) ||
    node.type !== "VariableDeclarator" ||
    !isSingleAssignment(variable)
  ) {
    return null;
  }
  const init = exportOfExpression(context, node.init, seen);
  if (init === null || isIdentifier(node.id)) {
    return init;
  }
  if (!isAstNode(node.id) || node.id.type !== "ObjectPattern") {
    return null;
  }
  const key = patternKeyFor(node.id, definition.name);
  return isNamespaceLike(init) && key !== null
    ? { moduleId: init.moduleId, imported: key }
    : null;
};

// The module export an expression evaluates to: an imported binding, a
// member of a namespace (static, dynamic or required), or an alias of
// either. Null for locals, parameters and call results.
const exportOfExpression = (
  context: Context,
  node: unknown,
  seen = new Set<unknown>(),
): ResolvedImport | null => {
  const expression = unwrapExpression(node);
  if (!isAstNode(expression) || seen.has(expression)) {
    return null;
  }
  seen.add(expression);
  const loaded = loadedModuleSource(context, expression);
  if (loaded !== null) {
    return { moduleId: canonical(context, loaded), imported: NAMESPACE_IMPORT };
  }
  if (isIdentifierReference(expression)) {
    const variable = variableAt(context, expression, expression.name);
    return variable === null ? null : exportOfVariable(context, variable, seen);
  }
  if (expression.type !== "MemberExpression") {
    return null;
  }
  const base = exportOfExpression(context, expression.object, seen);
  const property = memberPropertyName(expression);
  return base !== null && property !== null && isNamespaceLike(base)
    ? { moduleId: base.moduleId, imported: property }
    : null;
};

// `<ns.X />`: the JSX object is a JSXIdentifier, which scope lookup takes by
// name.
const exportOfJsxMember = (
  context: Context,
  node: ESTree.JSXMemberExpression,
): ResolvedImport | null => {
  const { object, property } = node;
  if (object.type !== "JSXIdentifier") {
    return null;
  }
  const variable = variableAt(context, node, object.name);
  const base =
    variable === null ? null : exportOfVariable(context, variable, new Set());
  return base !== null && isNamespaceLike(base)
    ? { moduleId: base.moduleId, imported: property.name }
    : null;
};

// --- Detection --------------------------------------------------------------

// `require("m")` loads eagerly like a static import; `import("m")` is the
// lazy boundary some rows allow.
const MODULE_LOADING = { static: "static", dynamic: "dynamic" } as const;
type ModuleLoading = (typeof MODULE_LOADING)[keyof typeof MODULE_LOADING];

const moduleIn = (entry: RestrictedImportEntry, moduleId: string): boolean =>
  entry.modules.some((matcher) => moduleMatches(matcher, moduleId));

const isTypeOnlyDeclaration = (node: AstNode): boolean => {
  const kind = node.importKind ?? node.exportKind;
  if (kind === "type") {
    return true;
  }
  if (!Array.isArray(node.specifiers) || node.specifiers.length === 0) {
    return false;
  }
  return node.specifiers.every(
    (specifier: unknown) =>
      isAstNode(specifier) &&
      (specifier.importKind === "type" || specifier.exportKind === "type"),
  );
};

const isTypeOnlySpecifier = (specifier: AstNode): boolean =>
  specifier.importKind === "type" || specifier.exportKind === "type";

// The export a specifier of `export { X as Y } from "m"` reads.
const reexportedName = (specifier: AstNode): string | null =>
  getPropertyName(specifier.local);

export const restrictedImportMeta = (ruleName: RestrictedImportRuleName) => ({
  type: "problem" as const,
  messages: Object.fromEntries(
    RESTRICTED_IMPORT_RULES[ruleName].map((entry) => [
      entry.messageId,
      entry.message,
    ]),
  ),
});

export const restrictedImportVisitors = (
  context: Context,
  ruleName: RestrictedImportRuleName,
): VisitorWithHooks => {
  const entries: readonly RestrictedImportEntry[] =
    RESTRICTED_IMPORT_RULES[ruleName];
  let active: RestrictedImportEntry[] = [];

  const report = (
    node: Ranged,
    entry: RestrictedImportEntry,
    name: string,
  ): void => {
    context.report({ node, messageId: entry.messageId, data: { name } });
  };

  // Every entry the resolved export falls under, for the given hit site.
  const reportExport = (
    node: Ranged,
    resolved: ResolvedImport | null,
    hit: ExportHit,
  ): void => {
    if (resolved === null) {
      return;
    }
    for (const entry of active) {
      const { restriction } = entry;
      if (
        restriction.type === "exports" &&
        restriction.hit === hit &&
        restriction.names.has(resolved.imported) &&
        moduleIn(entry, resolved.moduleId)
      ) {
        report(node, entry, resolved.imported);
      }
    }
  };

  // Static import, re-export, `require`, or `import()` of a module entry.
  const reportModuleLoad = (
    node: Ranged,
    source: string,
    loading: ModuleLoading,
  ): void => {
    const moduleId = canonical(context, source);
    for (const entry of active) {
      const { restriction } = entry;
      if (
        restriction.type === "module" &&
        moduleIn(entry, moduleId) &&
        (loading === MODULE_LOADING.static ||
          restriction.dynamicImports !== DYNAMIC_IMPORTS.allowed)
      ) {
        report(node, entry, moduleId);
      }
    }
  };

  const exportEntriesFor = (source: string): RestrictedImportEntry[] => {
    const moduleId = canonical(context, source);
    return active.filter(
      (entry) =>
        entry.restriction.type === "exports" && moduleIn(entry, moduleId),
    );
  };

  const moduleLoadAllowsTypes = (source: string): boolean => {
    const moduleId = canonical(context, source);
    return active.every(
      (entry) =>
        entry.restriction.type !== "module" ||
        !moduleIn(entry, moduleId) ||
        entry.restriction.typeOnlyImports === TYPE_ONLY_IMPORTS.allowed,
    );
  };

  // `import`/`export ... from "m"`: the module entries, then the named
  // exports bound or re-exported by name.
  const checkDeclaration = (
    node: unknown,
    specifierName: (specifier: AstNode) => string | null,
  ): void => {
    if (!isAstNode(node) || !isStringLiteral(node.source)) {
      return;
    }
    const source = node.source.value;
    const typeOnly = isTypeOnlyDeclaration(node);
    if (!typeOnly || !moduleLoadAllowsTypes(source)) {
      reportModuleLoad(node, source, MODULE_LOADING.static);
    }
    if (typeOnly || !Array.isArray(node.specifiers)) {
      return;
    }
    const exportEntries = exportEntriesFor(source);
    for (const specifier of node.specifiers) {
      if (!isAstNode(specifier) || isTypeOnlySpecifier(specifier)) {
        continue;
      }
      const name = specifierName(specifier);
      for (const entry of exportEntries) {
        const { restriction } = entry;
        const bindsHere =
          restriction.type === "exports" &&
          (restriction.hit === EXPORT_HIT.binding ||
            node.type === "ExportNamedDeclaration");
        if (bindsHere && name !== null && restriction.names.has(name)) {
          report(specifier, entry, name);
        }
      }
    }
  };

  return {
    before() {
      active = entries.filter((entry) => !isFileIn(context, entry.owners));
      return active.length > 0;
    },
    ImportDeclaration(node) {
      checkDeclaration(node, getImportedName);
    },
    ExportNamedDeclaration(node) {
      checkDeclaration(node, reexportedName);
    },
    // `export * from "m"` re-exports every restricted name at once.
    ExportAllDeclaration(node) {
      if (!isStringLiteral(node.source) || node.exportKind === "type") {
        return;
      }
      const source = node.source.value;
      reportModuleLoad(node, source, MODULE_LOADING.static);
      for (const entry of exportEntriesFor(source)) {
        report(node, entry, "*");
      }
    },
    ImportExpression(node) {
      const source = specifierText(context, node.source);
      if (source !== null) {
        reportModuleLoad(node, source, MODULE_LOADING.dynamic);
        return;
      }
      for (const entry of active) {
        if (
          entry.restriction.type === "module" &&
          entry.restriction.dynamicImports === DYNAMIC_IMPORTS.readableOnly
        ) {
          report(node, entry, "an unreadable dynamic import");
        }
      }
    },
    CallExpression(node) {
      const required = dynamicModuleSourceForEnforcement(node, context);
      if (required !== null) {
        reportModuleLoad(node, required, MODULE_LOADING.static);
        return;
      }
      reportExport(
        node,
        isAstNode(node)
          ? exportOfExpression(context, invokedCallee(node))
          : null,
        EXPORT_HIT.call,
      );
    },
    // `ns.X`, `ns["X"]`, `require("m").X`, `(await import("m")).X`.
    MemberExpression(node) {
      reportExport(node, exportOfExpression(context, node), EXPORT_HIT.binding);
    },
    JSXMemberExpression(node) {
      reportExport(node, exportOfJsxMember(context, node), EXPORT_HIT.binding);
    },
    // `const { X } = ns`, `const { X } = await import("m")`.
    VariableDeclarator(node) {
      if (!isAstNode(node.id) || node.id.type !== "ObjectPattern") {
        return;
      }
      const base = exportOfExpression(context, node.init);
      if (base === null || !isNamespaceLike(base)) {
        return;
      }
      for (const property of node.id.properties) {
        if (!isAstNode(property) || property.type !== "Property") {
          continue;
        }
        const key =
          property.computed && !isStringLiteral(property.key)
            ? null
            : getPropertyName(property.key);
        if (key !== null) {
          reportExport(
            property,
            { moduleId: base.moduleId, imported: key },
            EXPORT_HIT.binding,
          );
        }
      }
    },
  };
};
