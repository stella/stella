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

import {
  type AstNode,
  canonicalModuleId,
  dynamicModuleSource,
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
// some modules, so only their static imports are restricted.
const DYNAMIC_IMPORTS = {
  allowed: "allowed",
  restricted: "restricted",
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

const LUCIDE = packageWithSubpaths("lucide-react");
const TANSTACK_DEVTOOLS_ROOT =
  "apps/web/src/components/tanstack-devtools-root.tsx";
const TABLE_DEVTOOLS =
  "apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/table-devtools.tsx";

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

const RESTRICTED_IMPORT_RULES = {
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
  // `<MatterIcon>` always resolves a matter colour (or paints the deliberate
  // neutral variant), so the raw layers glyph is drawn only there.
  "no-direct-matter-glyph": [
    {
      messageId: "directMatterGlyph",
      message:
        "Do not import '{{name}}' from 'lucide-react' here. Render " +
        "<MatterIcon> from '@/components/matter-icon' instead so the " +
        "matter colour is always applied (matter={{ id, color }}, or " +
        'variant="none" / variant="all" for non-matter affordances). ' +
        "The raw glyph is only allowed in matter-icon.tsx.",
      modules: [LUCIDE],
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Layers", "Layers2"]),
        hit: EXPORT_HIT.binding,
      },
      owners: ["apps/web/src/components/matter-icon.tsx"],
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
      modules: [LUCIDE],
      restriction: {
        type: "exports",
        names: lucideGlyphNames(["Folder", "FolderOpen", "ListTodo"]),
        hit: EXPORT_HIT.binding,
      },
      owners: ["apps/web/src/components/workspaces/entity-kind-icon.tsx"],
    },
  ],
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
  const loaded = dynamicModuleSource(expression);
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
          restriction.dynamicImports === DYNAMIC_IMPORTS.restricted)
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
      if (isStringLiteral(node.source)) {
        reportModuleLoad(node, node.source.value, MODULE_LOADING.dynamic);
      }
    },
    CallExpression(node) {
      const required = dynamicModuleSource(node);
      if (required !== null && isIdentifier(node.callee, "require")) {
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
