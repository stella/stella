// The public API of `@stll/ui`, read from its source without type checking.
//
// Two parts, committed as scripts/ui-api-snapshot.json:
//
//   exports   every subpath `packages/ui/package.json` exports, with the value
//             names it exports (types are left out: they follow the values).
//   props     for every exported component, each prop whose type is a closed
//             set of string literals (`variant`, `size`, `shape`, `density`,
//             ...), as `Component.prop` -> the names it accepts. A set is read
//             through local and imported type aliases, interfaces,
//             intersections, `keyof typeof` a class map, and
//             `VariantProps<typeof cvaBinding>` (whole or indexed).
//
// `.oxlint-plugins/__tests__/ui-api-snapshot.test.ts` fails when the tree and
// the committed snapshot disagree, and when a prop name in `props` is missing
// from DESIGN.md's "One Name per Concept" names list. Both are deliberate edits:
// a new export, variant or size is a design decision, recorded in DESIGN.md
// first and then here.
//
// Usage:
//   bun scripts/ui-api-snapshot.ts           print the differences
//   bun scripts/ui-api-snapshot.ts --write   rewrite the snapshot from the tree

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { compareCodeUnit } from "@stll/collation";

import {
  type ParsedSource,
  parseSource,
} from "../packages/scripts/src/syntax-tree";
import { isRecord } from "./oxlint-config-scopes.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const UI_ROOT = path.join(REPOSITORY_ROOT, "packages/ui");
export const UI_API_SNAPSHOT_PATH = "scripts/ui-api-snapshot.json";
export const UI_API_SNAPSHOT_WRITE = "bun scripts/ui-api-snapshot.ts --write";

type UiApiSnapshot = {
  readonly exports: Record<string, string[]>;
  readonly props: Record<string, string[]>;
};

/** An ESTree node read by field name, without assuming its shape. */
type AnyNode = { readonly type: string; readonly [field: string]: unknown };

const isNode = (value: unknown): value is AnyNode =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

const nodeAt = (value: unknown, key: string): AnyNode | null => {
  if (!isNode(value)) {
    return null;
  }
  const child = value[key];
  return isNode(child) ? child : null;
};

const nodesAt = (value: unknown, key: string): AnyNode[] => {
  if (!isNode(value)) {
    return [];
  }
  const children = value[key];
  return Array.isArray(children) ? children.filter(isNode) : [];
};

const stringField = (node: AnyNode, field: string): string | null => {
  const value = node[field];
  return typeof value === "string" ? value : null;
};

const identifierName = (value: unknown): string | null =>
  isNode(value) && value.type === "Identifier"
    ? stringField(value, "name")
    : null;

const keyName = (key: unknown): string | null => {
  if (!isNode(key)) {
    return null;
  }
  if (key.type === "Identifier") {
    return stringField(key, "name");
  }
  return key.type === "Literal" ? stringField(key, "value") : null;
};

type ImportBinding = { readonly file: string; readonly imported: string };

type UiModule = {
  readonly file: string;
  readonly parsed: ParsedSource;
  /** Top-level declarations by name: values and types. */
  readonly declarations: ReadonlyMap<string, AnyNode>;
  readonly imports: ReadonlyMap<string, ImportBinding>;
};

const resolveRelative = (from: string, specifier: string): string | null => {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) => /\.tsx?$/u.test(candidate) && existsSync(candidate),
    ) ?? null
  );
};

const declarationsOf = (statement: AnyNode): [string, AnyNode][] => {
  const declaration = statement["declaration"];
  const inner =
    (statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportDefaultDeclaration") &&
    isNode(declaration)
      ? declaration
      : statement;
  switch (inner.type) {
    case "FunctionDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration": {
      const name = identifierName(inner["id"]);
      return name === null ? [] : [[name, inner]];
    }
    case "VariableDeclaration":
      return nodesAt(inner, "declarations").flatMap(
        (declarator): [string, AnyNode][] => {
          const name = identifierName(declarator["id"]);
          return name === null ? [] : [[name, declarator]];
        },
      );
    default:
      return [];
  }
};

const moduleCache = new Map<string, UiModule>();

const loadModule = (file: string): UiModule => {
  const cached = moduleCache.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const parsed = parseSource(file, readFileSync(file, "utf-8"));
  const declarations = new Map<string, AnyNode>();
  const imports = new Map<string, ImportBinding>();
  for (const statement of parsed.program.body) {
    if (!isNode(statement)) {
      continue;
    }
    for (const [name, node] of declarationsOf(statement)) {
      declarations.set(name, node);
    }
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const source = nodeAt(statement, "source");
    const specifier = source === null ? null : stringField(source, "value");
    const target = specifier === null ? null : resolveRelative(file, specifier);
    if (target === null) {
      continue;
    }
    for (const binding of nodesAt(statement, "specifiers")) {
      const local = identifierName(binding["local"]);
      const imported =
        binding.type === "ImportSpecifier"
          ? keyName(binding["imported"])
          : null;
      if (local !== null && imported !== null) {
        imports.set(local, { file: target, imported });
      }
    }
  }
  const loaded = { file, parsed, declarations, imports };
  moduleCache.set(file, loaded);
  return loaded;
};

/** The local name a module exports under `name`, re-exports followed. */
const exportedLocalName = (module: UiModule, name: string): string | null => {
  for (const entry of module.parsed.module.staticExports.flatMap(
    ({ entries }) => entries,
  )) {
    if (entry.exportName.name !== name) {
      continue;
    }
    if (entry.moduleRequest === null) {
      return entry.localName.name ?? name;
    }
  }
  return module.declarations.has(name) ? name : null;
};

/** The declaration `name` refers to in `module`, following imports. */
const lookup = (
  module: UiModule,
  name: string,
  depth = 0,
): { module: UiModule; node: AnyNode } | null => {
  const local = module.declarations.get(name);
  if (local !== undefined) {
    return { module, node: local };
  }
  const binding = module.imports.get(name);
  if (binding === undefined || depth > 8) {
    return null;
  }
  const target = loadModule(binding.file);
  const exported = exportedLocalName(target, binding.imported);
  return exported === null ? null : lookup(target, exported, depth + 1);
};

const unwrapExpression = (node: AnyNode | null): AnyNode | null => {
  let current = node;
  while (
    current !== null &&
    (current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "ParenthesizedExpression")
  ) {
    current = nodeAt(current, "expression");
  }
  return current;
};

const objectKeys = (node: AnyNode | null): string[] | null => {
  const object = unwrapExpression(node);
  if (object === null || object.type !== "ObjectExpression") {
    return null;
  }
  const keys = nodesAt(object, "properties").map((property) =>
    property.type === "Property" && property["computed"] !== true
      ? keyName(property["key"])
      : null,
  );
  return keys.every((key) => key !== null) ? keys : null;
};

/** `cva(base, { variants: { group: { key: ... } } })` -> group -> keys. */
const cvaGroups = (
  module: UiModule,
  binding: string,
): Map<string, string[]> | null => {
  const found = lookup(module, binding);
  const call = unwrapExpression(nodeAt(found?.node, "init"));
  if (
    call === null ||
    call.type !== "CallExpression" ||
    identifierName(call["callee"]) !== "cva"
  ) {
    return null;
  }
  const options = unwrapExpression(nodesAt(call, "arguments")[1] ?? null);
  const variants = nodesAt(options, "properties").find(
    (property) => keyName(property["key"]) === "variants",
  );
  const groups = new Map<string, string[]>();
  for (const group of nodesAt(nodeAt(variants, "value"), "properties")) {
    const name = keyName(group["key"]);
    const keys = objectKeys(nodeAt(group, "value"));
    if (name !== null && keys !== null) {
      groups.set(name, keys);
    }
  }
  return groups;
};

const typeQueryName = (node: AnyNode | null): string | null =>
  node !== null && node.type === "TSTypeQuery"
    ? identifierName(node["exprName"])
    : null;

const typeArguments = (node: AnyNode): AnyNode[] =>
  nodesAt(nodeAt(node, "typeArguments"), "params");

const literalIndex = (node: AnyNode | null): string | null => {
  const literal = nodeAt(node, "literal");
  return node?.type === "TSLiteralType" && literal !== null
    ? stringField(literal, "value")
    : null;
};

const NULLISH_TYPES = new Set([
  "TSUndefinedKeyword",
  "TSNullKeyword",
  "TSNeverKeyword",
]);

/**
 * The string literals a type admits when it is a closed set of them, or null
 * when it admits anything else (a `string`, a boolean, a node).
 */
const literalSet = (
  module: UiModule,
  type: AnyNode | null,
  depth = 0,
): string[] | null => {
  if (type === null || depth > 12) {
    return null;
  }
  switch (type.type) {
    case "TSLiteralType": {
      const value = literalIndex(type);
      return value === null ? null : [value];
    }
    case "TSUnionType": {
      const members = nodesAt(type, "types").filter(
        (member) => !NULLISH_TYPES.has(member.type),
      );
      const sets = members.map((member) =>
        literalSet(module, member, depth + 1),
      );
      return sets.every((set) => set !== null) && sets.length > 0
        ? sets.flat()
        : null;
    }
    case "TSParenthesizedType":
      return literalSet(module, nodeAt(type, "typeAnnotation"), depth + 1);
    case "TSTypeOperator": {
      if (type["operator"] !== "keyof") {
        return null;
      }
      const queried = typeQueryName(nodeAt(type, "typeAnnotation"));
      const found = queried === null ? null : lookup(module, queried);
      return found === null ? null : objectKeys(nodeAt(found.node, "init"));
    }
    case "TSIndexedAccessType": {
      // VariantProps<typeof x>["group"]
      const object = nodeAt(type, "objectType");
      const index = literalIndex(nodeAt(type, "indexType"));
      if (
        object?.type !== "TSTypeReference" ||
        identifierName(object["typeName"]) !== "VariantProps" ||
        index === null
      ) {
        return null;
      }
      const binding = typeQueryName(typeArguments(object)[0] ?? null);
      const groups = binding === null ? null : cvaGroups(module, binding);
      return groups?.get(index) ?? null;
    }
    case "TSTypeReference": {
      const name = identifierName(type["typeName"]);
      if (name === null) {
        return null;
      }
      if (name === "NonNullable" || name === "Exclude") {
        const [inner, removed] = typeArguments(type);
        const set = literalSet(module, inner ?? null, depth + 1);
        if (name === "NonNullable" || set === null) {
          return set;
        }
        const drop = new Set(literalSet(module, removed ?? null, depth + 1));
        return set.filter((value) => !drop.has(value));
      }
      const found = lookup(module, name);
      if (found === null || found.node.type !== "TSTypeAliasDeclaration") {
        return null;
      }
      return literalSet(
        found.module,
        nodeAt(found.node, "typeAnnotation"),
        depth + 1,
      );
    }
    default:
      return null;
  }
};

const addProp = (
  props: Map<string, Set<string>>,
  prop: string,
  values: Iterable<string>,
): void => {
  const set = props.get(prop) ?? new Set<string>();
  for (const value of values) {
    set.add(value);
  }
  props.set(prop, set);
};

/** The closed-set props a type literal or interface body declares itself. */
const memberProps = (
  module: UiModule,
  members: readonly AnyNode[],
  props: Map<string, Set<string>>,
): void => {
  for (const member of members) {
    if (member.type !== "TSPropertySignature" || member["computed"] === true) {
      continue;
    }
    const prop = keyName(member["key"]);
    const values = literalSet(
      module,
      nodeAt(nodeAt(member, "typeAnnotation"), "typeAnnotation"),
    );
    // `data-*` and `aria-*` are attributes the caller passes through, not
    // names the design system chooses.
    if (prop !== null && values !== null && !/^(?:aria|data)-/u.test(prop)) {
      addProp(props, prop, values);
    }
  }
};

/** Props with a closed literal set, read from a props type. */
const literalProps = (
  module: UiModule,
  type: AnyNode | null,
  props: Map<string, Set<string>>,
  depth = 0,
): void => {
  if (type === null || depth > 12) {
    return;
  }
  const add = (prop: string, values: Iterable<string>) =>
    addProp(props, prop, values);
  switch (type.type) {
    case "TSTypeAnnotation":
    case "TSParenthesizedType":
      literalProps(module, nodeAt(type, "typeAnnotation"), props, depth + 1);
      return;
    case "TSIntersectionType":
    case "TSUnionType":
      for (const member of nodesAt(type, "types")) {
        literalProps(module, member, props, depth + 1);
      }
      return;
    case "TSTypeLiteral":
      memberProps(module, nodesAt(type, "members"), props);
      return;
    case "TSInterfaceBody":
      memberProps(module, nodesAt(type, "body"), props);
      return;
    // `interface A extends B<C>` names B the way a reference does.
    case "TSInterfaceHeritage":
    case "TSTypeReference": {
      const name = identifierName(
        type.type === "TSTypeReference" ? type["typeName"] : type["expression"],
      );
      if (name === null) {
        return;
      }
      if (name === "VariantProps") {
        const binding = typeQueryName(typeArguments(type)[0] ?? null);
        const groups = binding === null ? null : cvaGroups(module, binding);
        for (const [group, keys] of groups ?? []) {
          add(group, keys);
        }
        return;
      }
      if (name === "Omit" || name === "Partial" || name === "Readonly") {
        const [inner, omitted] = typeArguments(type);
        const nested = new Map<string, Set<string>>();
        literalProps(module, inner ?? null, nested, depth + 1);
        const drop = new Set(
          name === "Omit" ? literalSet(module, omitted ?? null) : [],
        );
        for (const [prop, values] of nested) {
          if (!drop.has(prop)) {
            add(prop, values);
          }
        }
        return;
      }
      const found = lookup(module, name);
      if (found === null) {
        return;
      }
      if (found.node.type === "TSTypeAliasDeclaration") {
        literalProps(
          found.module,
          nodeAt(found.node, "typeAnnotation"),
          props,
          depth + 1,
        );
      } else if (found.node.type === "TSInterfaceDeclaration") {
        literalProps(
          found.module,
          nodeAt(found.node, "body"),
          props,
          depth + 1,
        );
        for (const heritage of nodesAt(found.node, "extends")) {
          literalProps(found.module, heritage, props, depth + 1);
        }
      }
      return;
    }
    default:
      return;
  }
};

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** The function a component declaration renders through, or null. */
const componentFunction = (node: AnyNode): AnyNode | null => {
  if (FUNCTION_TYPES.has(node.type)) {
    return node;
  }
  let init = unwrapExpression(nodeAt(node, "init"));
  // memo(...), forwardRef(...), React.memo(...)
  while (init !== null && init.type === "CallExpression") {
    init = unwrapExpression(nodesAt(init, "arguments")[0] ?? null);
  }
  return init !== null && FUNCTION_TYPES.has(init.type) ? init : null;
};

const isComponentName = (name: string): boolean => /^[A-Z]/u.test(name);

const sortedUnique = (values: Iterable<string>): string[] =>
  [...new Set(values)].toSorted(compareCodeUnit);

/** Value names a module exports, `export *` followed. */
const valueExports = (file: string, seen = new Set<string>()): string[] => {
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const module = loadModule(file);
  return module.parsed.module.staticExports
    .flatMap(({ entries }) => entries)
    .flatMap((entry) => {
      if (entry.isType) {
        return [];
      }
      if (entry.exportName.kind === "Default") {
        return ["default"];
      }
      if (entry.exportName.kind === "Name" && entry.exportName.name !== null) {
        const local = entry.localName.name;
        const declaration =
          local === null ? undefined : module.declarations.get(local);
        return declaration?.type === "TSTypeAliasDeclaration" ||
          declaration?.type === "TSInterfaceDeclaration"
          ? []
          : [entry.exportName.name];
      }
      const request = entry.moduleRequest?.value;
      const target =
        request === undefined ? null : resolveRelative(file, request);
      return target === null ? [] : valueExports(target, seen);
    });
};

const exportTarget = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const condition of ["import", "default", "types"]) {
    const target = exportTarget(value[condition]);
    if (target !== null) {
      return target;
    }
  }
  return null;
};

export const readUiApiSnapshot = (): UiApiSnapshot => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(UI_ROOT, "package.json"), "utf-8"),
  );
  const packageExports =
    isRecord(manifest) && isRecord(manifest["exports"])
      ? manifest["exports"]
      : panic("packages/ui/package.json has no exports map");

  const exports = new Map<string, string[]>();
  const props = new Map<string, Set<string>>();
  const componentFiles = new Set<string>();
  for (const subpath of Object.keys(packageExports).toSorted(compareCodeUnit)) {
    const target = exportTarget(packageExports[subpath]);
    const file =
      target === null
        ? null
        : path.resolve(UI_ROOT, target.replace(/^\.\//u, ""));
    if (file === null || !/\.tsx?$/u.test(file)) {
      exports.set(subpath, []);
      continue;
    }
    exports.set(subpath, sortedUnique(valueExports(file)));
    if (subpath !== ".") {
      componentFiles.add(file);
    }
  }

  for (const file of [...componentFiles].toSorted(compareCodeUnit)) {
    const module = loadModule(file);
    for (const name of valueExports(file)) {
      if (!isComponentName(name)) {
        continue;
      }
      const local = exportedLocalName(module, name) ?? name;
      const found = lookup(module, local);
      const component = found === null ? null : componentFunction(found.node);
      if (found === null || component === null) {
        continue;
      }
      const parameter = nodesAt(component, "params")[0] ?? null;
      const componentProps = new Map<string, Set<string>>();
      literalProps(
        found.module,
        nodeAt(parameter, "typeAnnotation") ??
          nodeAt(nodeAt(parameter, "left"), "typeAnnotation"),
        componentProps,
      );
      for (const [prop, values] of componentProps) {
        const key = `${name}.${prop}`;
        const set = props.get(key) ?? new Set<string>();
        for (const value of values) {
          set.add(value);
        }
        props.set(key, set);
      }
    }
  }

  return {
    exports: Object.fromEntries(exports),
    props: Object.fromEntries(
      [...props.keys()]
        .toSorted(compareCodeUnit)
        .map((key) => [key, sortedUnique(props.get(key) ?? [])]),
    ),
  };
};

const formatUiApiSnapshot = (snapshot: UiApiSnapshot): string =>
  `${JSON.stringify(snapshot, null, 2)}\n`;

const SnapshotSchema = v.object({
  exports: v.record(v.string(), v.array(v.string())),
  props: v.record(v.string(), v.array(v.string())),
});

export const readCommittedUiApiSnapshot = (): UiApiSnapshot =>
  v.parse(
    SnapshotSchema,
    JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, UI_API_SNAPSHOT_PATH), "utf-8"),
    ),
  );

/** One line per name added or removed, `+`/`-` prefixed. */
export const snapshotChanges = (
  committed: UiApiSnapshot,
  current: UiApiSnapshot,
): string[] => {
  const changes: string[] = [];
  for (const section of ["exports", "props"] as const) {
    const keys = sortedUnique([
      ...Object.keys(committed[section]),
      ...Object.keys(current[section]),
    ]);
    for (const key of keys) {
      const before = committed[section][key];
      const after = current[section][key];
      if (before === undefined) {
        changes.push(`+ ${section} ${key}: ${(after ?? []).join(", ")}`);
        continue;
      }
      if (after === undefined) {
        changes.push(`- ${section} ${key}`);
        continue;
      }
      for (const value of after.filter((name) => !before.includes(name))) {
        changes.push(`+ ${section} ${key}: ${value}`);
      }
      for (const value of before.filter((name) => !after.includes(name))) {
        changes.push(`- ${section} ${key}: ${value}`);
      }
    }
  }
  return changes;
};

// --- DESIGN.md -------------------------------------------------------------

export const DESIGN_PATH = "DESIGN.md";
const SECTION_HEADING = "### One Name per Concept";

/** One line of the names list: the components sharing one prop and set. */
type DesignNameRow = {
  readonly components: readonly string[];
  readonly prop: string;
  readonly names: readonly string[];
};

const backticked = (cell: string): string[] =>
  [...cell.matchAll(/`(?<token>[^`]+)`/gu)].flatMap(
    (match) => match.groups?.["token"] ?? [],
  );

/** The "One Name per Concept" section, up to the next heading. */
const designSection = (markdown: string): string => {
  const start = markdown.indexOf(SECTION_HEADING);
  if (start === -1) {
    return panic(`${DESIGN_PATH} has no "${SECTION_HEADING}" section`);
  }
  const rest = markdown.slice(start + SECTION_HEADING.length);
  const end = rest.search(/^#{1,3} /mu);
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * The section's names list: one line per prop, the components and the prop
 * backticked before the colon, the names it accepts after it.
 *
 *   - `DialogFooter`, `SheetFooter` `variant`: `bare`, `default`
 */
export const designNameRows = (markdown: string): DesignNameRow[] =>
  designSection(markdown)
    .split("\n")
    .flatMap((line) => {
      const item = /^- (?<subject>`[^:]+`): (?<names>.*)$/u.exec(line.trim());
      const subject = backticked(item?.groups?.["subject"] ?? "");
      const prop = subject.at(-1);
      if (item === null || subject.length < 2 || prop === undefined) {
        return [];
      }
      return [
        {
          components: subject.slice(0, -1),
          prop,
          names: backticked(item.groups?.["names"] ?? ""),
        },
      ];
    });

/** The line DESIGN.md should carry for one `Component.prop` entry. */
const designRowFor = (key: string, names: readonly string[]): string => {
  const [component = "", prop = ""] = key.split(".");
  return `- \`${component}\` \`${prop}\`: ${names.map((name) => `\`${name}\``).join(", ")}`;
};

/**
 * Where the names list and the snapshot's props disagree: a prop with no line,
 * a line whose names differ, or a line naming a prop no component has.
 */
export const designMismatches = (
  markdown: string,
  snapshot: UiApiSnapshot,
): string[] => {
  const rows = designNameRows(markdown);
  const errors: string[] = [];
  for (const [key, names] of Object.entries(snapshot.props)) {
    const [component = "", prop = ""] = key.split(".");
    const matching = rows.filter(
      (row) => row.prop === prop && row.components.includes(component),
    );
    if (matching.length !== 1) {
      errors.push(
        matching.length === 0
          ? `${key} has no line in DESIGN.md. Add: ${designRowFor(key, names)}`
          : `${key} has ${matching.length} lines in DESIGN.md; keep one`,
      );
      continue;
    }
    const documented = sortedUnique(matching[0]?.names ?? []);
    if (documented.join("\0") !== names.join("\0")) {
      errors.push(
        `${key} accepts ${names.join(", ")}; DESIGN.md lists ${documented.join(", ")}`,
      );
    }
  }
  for (const row of rows) {
    for (const component of row.components) {
      const key = `${component}.${row.prop}`;
      if (!Object.hasOwn(snapshot.props, key)) {
        errors.push(`DESIGN.md lists ${key}, which no component accepts`);
      }
    }
  }
  return errors;
};

if (import.meta.main) {
  const current = readUiApiSnapshot();
  if (process.argv.includes("--write")) {
    const file = path.join(REPOSITORY_ROOT, UI_API_SNAPSHOT_PATH);
    writeFileSync(file, formatUiApiSnapshot(current));
    // Committed in the formatter's layout, so a rewrite leaves no format diff.
    Bun.spawnSync([process.execPath, "fmt", file], { cwd: REPOSITORY_ROOT });
    console.log(`Wrote ${UI_API_SNAPSHOT_PATH}.`);
  } else {
    const changes = snapshotChanges(readCommittedUiApiSnapshot(), current);
    console.log(
      changes.length === 0
        ? `${UI_API_SNAPSHOT_PATH} matches packages/ui.`
        : changes.join("\n"),
    );
  }
}
