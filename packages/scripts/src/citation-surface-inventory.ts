import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { sourceFileIndex } from "./source-file-index";
import {
  type IdentifierNode as Identifier,
  type JSXIdentifier,
  type JSXOpeningElement,
  type Node,
  type ParsedSource,
  parseSource,
  type PropertyNode as Property,
  walk,
} from "./syntax-tree";

type Imported = { module: string; name: string };
type Opening = JSXOpeningElement;
type Unit = {
  source: ParsedSource;
  filePath: string;
  ancestors: Map<Node, readonly Node[]>;
  imports: Map<string, Imported>;
  values: Map<string, Node[]>;
  openings: Opening[];
  anchors: Property[];
};
type Inventory = ReturnType<typeof createInventory>;

function visit(node: Node, inspect: (node: Node) => void) {
  walk(node, (child) => {
    if (
      child.type.startsWith("TS") &&
      child.type !== "TSAsExpression" &&
      child.type !== "TSSatisfiesExpression" &&
      child.type !== "TSNonNullExpression" &&
      child.type !== "TSInstantiationExpression"
    ) {
      return "skip-children";
    }
    inspect(child);
    return undefined;
  });
}
/** The name a declared value binds: an initialized variable or a defined function. */
function declaredValueName(node: Node): string | undefined {
  if (
    node.type === "VariableDeclarator" &&
    node.id.type === "Identifier" &&
    node.init
  ) {
    return node.id.name;
  }
  if (node.type === "FunctionDeclaration" && node.id && node.body) {
    return node.id.name;
  }
  return undefined;
}

function nameOf(node: Node) {
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return node.name;
  }
  return node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;
}
/** The nearest enclosing component, declared the same way `declaredValueName` binds it. */
function ownerOf(inventory: Inventory, node: Node) {
  return unitOf(inventory, node)
    ?.ancestors.get(node)
    ?.findLast((candidate) =>
      /^[A-Z]/u.test(declaredValueName(candidate) ?? ""),
    );
}
type CreateInventoryOptions = {
  sourceRoot: string;
  overrides?: ReadonlyMap<string, string>;
  previous?: { units: ReadonlyMap<string, Unit> };
};

function createInventory({
  sourceRoot,
  overrides = new Map(),
  previous,
}: CreateInventoryOptions) {
  const sources = sourceFileIndex(sourceRoot).filter(
    ({ relativePath }) =>
      !/\.(?:test|spec|gen)\./u.test(relativePath) &&
      !relativePath.includes("__fixtures__"),
  );

  const units = new Map<string, Unit>();
  for (const entry of sources) {
    const existing = previous?.units.get(entry.filePath);
    if (existing && !overrides.has(entry.filePath)) {
      units.set(entry.filePath, existing);
      continue;
    }
    const override = overrides.get(entry.filePath);
    const source =
      override === undefined
        ? entry.sourceFile()
        : parseSource(entry.filePath, override);
    const unit: Unit = {
      source,
      filePath: entry.filePath,
      ancestors: new Map(),
      imports: new Map(),
      values: new Map(),
      openings: [],
      anchors: [],
    };
    walk(source.program, (node, ancestors) => {
      unit.ancestors.set(node, [...ancestors]);
    });
    visit(source.program, (node) => {
      if (node.type === "ImportDeclaration") {
        for (const item of node.specifiers) {
          if (item.type !== "ImportSpecifier") {
            continue;
          }
          unit.imports.set(item.local.name, {
            module: node.source.value,
            name: nameOf(item.imported) ?? "",
          });
        }
      }
      const declaredName = declaredValueName(node);
      if (declaredName !== undefined) {
        const values = unit.values.get(declaredName) ?? [];
        values.push(node);
        unit.values.set(declaredName, values);
      }
      if (node.type === "JSXOpeningElement") {
        unit.openings.push(node);
      }
      if (
        node.type === "Property" &&
        !node.method &&
        !node.computed &&
        node.kind === "init" &&
        !node.shorthand &&
        nameOf(node.key) === "a"
      ) {
        unit.anchors.push(node);
      }
    });
    units.set(entry.filePath, unit);
  }
  return {
    sourceRoot,
    units,
    nodeUnits: new Map(
      [...units.values()].flatMap((unit) =>
        [...unit.ancestors.keys()].map((node) => [node, unit] as const),
      ),
    ),
    references: new Map<Node, Node[]>(),
    incoming: new Map<Node, Map<string, Node[]>>(),
    indexed: false,
  };
}
function unitOf(inventory: Inventory, node: Node) {
  return inventory.nodeUnits.get(node);
}
function resolveModule(inventory: Inventory, from: Node, module: string) {
  let base: string;
  if (module.startsWith("@/")) {
    base = path.join(inventory.sourceRoot, module.slice(2));
  } else if (module.startsWith(".")) {
    base = path.resolve(
      path.dirname(unitOf(inventory, from)?.filePath ?? ""),
      module,
    );
  } else {
    return undefined;
  }
  return (
    inventory.units.get(`${base}.tsx`) ?? inventory.units.get(`${base}.ts`)
  );
}
function exportOf(
  inventory: Inventory,
  unit: Unit,
  name: string,
  seen = new Set<Unit>(),
): Node | undefined {
  if (seen.has(unit)) {
    return undefined;
  }
  seen.add(unit);
  const local = unit.values.get(name)?.at(0);
  if (local) {
    return local;
  }
  for (const statement of unit.source.program.body) {
    if (
      (statement.type !== "ExportNamedDeclaration" &&
        statement.type !== "ExportAllDeclaration") ||
      !statement.source
    ) {
      continue;
    }
    const target = resolveModule(inventory, statement, statement.source.value);
    if (!target) {
      continue;
    }
    if (statement.type === "ExportAllDeclaration") {
      const value = exportOf(inventory, target, name, seen);
      if (value) {
        return value;
      }
    } else {
      const item = statement.specifiers.find(
        (entry) => nameOf(entry.exported) === name,
      );
      if (item) {
        return exportOf(inventory, target, nameOf(item.local) ?? "", seen);
      }
    }
  }
  return undefined;
}
function valueOf(
  inventory: Inventory,
  identifier: Identifier | JSXIdentifier,
): Node | undefined {
  const unit = unitOf(inventory, identifier);
  if (!unit) {
    return undefined;
  }
  const imported = unit.imports.get(identifier.name);
  const target =
    imported && resolveModule(inventory, identifier, imported.module);
  if (target) {
    return exportOf(inventory, target, imported.name);
  }
  return unit.values
    .get(identifier.name)
    ?.filter((value) => {
      // A declaration binds its name in the enclosing function, never inside
      // itself: `function Tray() {}` is visible to its whole module.
      const scope = unit.ancestors
        .get(value)
        ?.findLast(
          (ancestor) =>
            ancestor.type === "FunctionDeclaration" ||
            ancestor.type === "FunctionExpression" ||
            ancestor.type === "ArrowFunctionExpression",
        );
      return (
        !scope ||
        (scope.start <= identifier.start && scope.end >= identifier.end)
      );
    })
    .toSorted(
      (left, right) => left.end - left.start - (right.end - right.start),
    )
    .at(0);
}
function isReference(inventory: Inventory, node: Identifier | JSXIdentifier) {
  const parent = unitOf(inventory, node)?.ancestors.get(node)?.at(-1);
  return (
    !(
      parent?.type === "MemberExpression" &&
      !parent.computed &&
      parent.property === node
    ) &&
    !(
      parent?.type === "Property" &&
      !parent.shorthand &&
      parent.key === node
    ) &&
    parent?.type !== "ImportSpecifier"
  );
}
function referencesOf(inventory: Inventory, node: Node) {
  const known = inventory.references.get(node);
  if (known) {
    return known;
  }
  const values = new Set<Node>();
  visit(node, (child) => {
    if (
      (child.type !== "Identifier" && child.type !== "JSXIdentifier") ||
      !isReference(inventory, child)
    ) {
      return;
    }
    const value = valueOf(inventory, child);
    if (value && value !== node) {
      values.add(value);
    }
  });
  // Lazy markdown wrappers are linked to the module's exports, not to arbitrary
  // runtime imports used by the component's hooks or inspector dependencies.
  visit(node, (child) => {
    if (child.type !== "ImportExpression") {
      return;
    }
    const specifier = child.source;
    const target =
      specifier.type === "Literal" && typeof specifier.value === "string"
        ? resolveModule(inventory, child, specifier.value)
        : undefined;
    if (target) {
      for (const exports of target.values.values()) {
        for (const value of exports) {
          values.add(value);
        }
      }
    }
  });
  const result = [...values];
  inventory.references.set(node, result);
  return result;
}
function reaches(
  inventory: Inventory,
  node: Node,
  terminal: (imported: Imported) => boolean,
  seen = new Set<Node>(),
): boolean {
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  const importedValues: Imported[] = [];
  visit(node, (child) => {
    if (
      (child.type !== "Identifier" && child.type !== "JSXIdentifier") ||
      !isReference(inventory, child)
    ) {
      return;
    }
    const imported = unitOf(inventory, child)?.imports.get(child.name);
    if (imported) {
      importedValues.push(imported);
    }
  });
  return (
    importedValues.some(terminal) ||
    referencesOf(inventory, node).some((value) =>
      reaches(inventory, value, terminal, seen),
    )
  );
}
function sharedAnchor({ module, name }: Imported) {
  return (
    module === "@/components/chat/streamdown-mention-link" &&
    name === "StreamdownMentionLink"
  );
}
function resolver({ module, name }: Imported) {
  return (
    module === "@stll/api-contract/legal-citation-links" &&
    name === "resolveLegalCitationLinks"
  );
}
function streamdown({ module, name }: Imported) {
  return module === "streamdown" && name === "Streamdown";
}
function location(inventory: Inventory, node: Node) {
  const unit = unitOf(inventory, node);
  return unit
    ? `${repoRelativePath(inventory.sourceRoot, unit.filePath)}:${unit.source.locate(node.start).line}`
    : "";
}
function componentChildren(inventory: Inventory, root: Node) {
  const nodes = new Set<Node>();
  const inspect = (node: Node) => {
    if (nodes.has(node)) {
      return;
    }
    nodes.add(node);
    visit(node, (child) => {
      if (
        child.type === "JSXOpeningElement" &&
        child.name.type === "JSXIdentifier"
      ) {
        const value = valueOf(inventory, child.name);
        if (value) {
          inspect(value);
        }
      }
    });
  };
  inspect(root);
  return nodes;
}
function indexIncoming(inventory: Inventory) {
  if (inventory.indexed) {
    return;
  }
  inventory.indexed = true;
  for (const unit of inventory.units.values()) {
    for (const opening of unit.openings) {
      if (opening.name.type !== "JSXIdentifier") {
        continue;
      }
      const value = valueOf(inventory, opening.name);
      if (!value) {
        continue;
      }
      const props = inventory.incoming.get(value) ?? new Map<string, Node[]>();
      for (const attribute of opening.attributes) {
        if (
          attribute.type !== "JSXAttribute" ||
          !attribute.value ||
          attribute.value.type !== "JSXExpressionContainer" ||
          attribute.value.expression.type === "JSXEmptyExpression"
        ) {
          continue;
        }
        const values = props.get(nameOf(attribute.name) ?? "") ?? [];
        values.push(attribute.value.expression);
        props.set(nameOf(attribute.name) ?? "", values);
      }
      inventory.incoming.set(value, props);
    }
  }
}
function provenance(
  inventory: Inventory,
  root: Node,
  seen = new Set<Node>(),
): boolean {
  if (seen.has(root)) {
    return false;
  }
  seen.add(root);
  if (reaches(inventory, root, resolver)) {
    return true;
  }
  const owner = ownerOf(inventory, root);
  if (!owner) {
    return false;
  }
  const names = new Set<string>();
  visit(root, (node) => {
    if (
      (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      isReference(inventory, node)
    ) {
      names.add(node.name);
    }
  });
  let found = false;
  visit(owner, (node) => {
    if (node.type !== "Property") {
      return;
    }
    // `{ name = fallback }` binds `name` through a default.
    const binding =
      node.value.type === "AssignmentPattern" ? node.value.left : node.value;
    if (binding.type !== "Identifier" || !names.has(binding.name)) {
      return;
    }
    const ancestors = unitOf(inventory, node)?.ancestors.get(node);
    const pattern = ancestors?.at(-1);
    // `({ name } = {})` wraps the whole parameter in a default.
    const defaulted = ancestors?.at(-2);
    const parameter =
      defaulted?.type === "AssignmentPattern" ? defaulted : pattern;
    const owningFunction =
      defaulted?.type === "AssignmentPattern" ? ancestors?.at(-3) : defaulted;
    if (
      pattern?.type !== "ObjectPattern" ||
      !(
        owningFunction?.type === "ArrowFunctionExpression" ||
        owningFunction?.type === "FunctionExpression" ||
        owningFunction?.type === "FunctionDeclaration"
      ) ||
      !owningFunction.params.some((param) => param === parameter)
    ) {
      return;
    }
    const key = nameOf(node.key);
    if (key) {
      found ||= (inventory.incoming.get(owner)?.get(key) ?? []).some((value) =>
        provenance(inventory, value, seen),
      );
    }
  });
  return found;
}
function markdownValues(inventory: Inventory) {
  const owners = new Set<Node>();
  const edges = new Map<Node, Set<Node>>();
  for (const unit of inventory.units.values()) {
    for (const values of unit.values.values()) {
      for (const value of values) {
        const children = new Set<Node>();
        visit(value, (node) => {
          if (
            node.type === "JSXOpeningElement" &&
            node.name.type === "JSXIdentifier"
          ) {
            const imported = unitOf(inventory, node)?.imports.get(
              node.name.name,
            );
            if (imported && streamdown(imported)) {
              owners.add(value);
            }
            const child = valueOf(inventory, node.name);
            if (child) {
              children.add(child);
            }
          }
          if (node.type === "ImportExpression") {
            const specifier = node.source;
            const target =
              specifier.type === "Literal" &&
              typeof specifier.value === "string"
                ? resolveModule(inventory, node, specifier.value)
                : undefined;
            if (target) {
              for (const exports of target.values.values()) {
                for (const child of exports) {
                  children.add(child);
                }
              }
            }
          }
        });
        edges.set(value, children);
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [owner, children] of edges) {
      if (
        owners.has(owner) ||
        ![...children].some((child) => owners.has(child))
      ) {
        continue;
      }
      owners.add(owner);
      changed = true;
    }
  }
  return owners;
}
function checkInventory(inventory: Inventory) {
  const hosts: Opening[] = [];
  const failures: string[] = [];
  const anchors: Property[] = [];
  const trays = new Set<Node>();
  const wrappers = markdownValues(inventory);
  for (const unit of inventory.units.values()) {
    // Anchor maps are a renderer contract. Derive every object-literal `a`
    // override, including maps returned by hooks and passed through props.
    for (const anchor of unit.anchors) {
      anchors.push(anchor);
      if (!reaches(inventory, anchor.value, sharedAnchor)) {
        failures.push(
          `Bypassing markdown anchor at ${location(inventory, anchor)}`,
        );
      }
    }
    for (const opening of unit.openings) {
      if (opening.name.type !== "JSXIdentifier") {
        continue;
      }
      const imported = unit.imports.get(opening.name.name);
      const value = valueOf(inventory, opening.name);
      if (imported && streamdown(imported)) {
        hosts.push(opening);
        const components = opening.attributes.find(
          (item) =>
            item.type === "JSXAttribute" && nameOf(item.name) === "components",
        );
        if (!components || !reaches(inventory, components, sharedAnchor)) {
          failures.push(
            `Missing shared markdown anchor at ${location(inventory, opening)}`,
          );
        }
      } else if (value && wrappers.has(value)) {
        hosts.push(opening);
      }
      if (imported?.module === "@/features/chat/source-chips" && value) {
        for (const child of componentChildren(inventory, value)) {
          trays.add(child);
        }
      }
    }
  }
  indexIncoming(inventory);
  const sinks: Node[] = [];
  for (const tray of trays) {
    visit(tray, (node) => {
      const parent = unitOf(inventory, node)?.ancestors.get(node)?.at(-1);
      if (
        node.type !== "JSXAttribute" ||
        nameOf(node.name) !== "href" ||
        parent?.type !== "JSXOpeningElement" ||
        nameOf(parent.name) !== "a"
      ) {
        return;
      }
      sinks.push(node);
      if (!provenance(inventory, node)) {
        failures.push(
          `Bypassing source-tray anchor at ${location(inventory, node)}`,
        );
      }
    });
  }
  const source = inventory.units.get(
    path.join(
      inventory.sourceRoot,
      "components/chat/streamdown-mention-link.tsx",
    ),
  );
  const anchor = source && exportOf(inventory, source, "StreamdownMentionLink");
  if (!anchor || !reaches(inventory, anchor, resolver)) {
    failures.push("Shared markdown anchor does not reach the legal resolver");
  }
  return { hosts, anchors, sinks, failures };
}
/** Source-derived markdown and citation sink analysis owned by the compiler package. */
export const createCitationSurfaceInventory = (sourceRoot: string) => {
  const original = createInventory({ sourceRoot });
  return {
    inspect: (overrides: ReadonlyMap<string, string> = new Map()) => {
      const inventory = createInventory({
        sourceRoot,
        overrides,
        previous: original,
      });
      const result = checkInventory(inventory);
      return {
        hostCount: result.hosts.length,
        anchorCount: result.anchors.length,
        sinkCount: result.sinks.length,
        failures: result.failures,
        sharedAnchorOverrides: result.anchors
          .filter((anchor) => reaches(inventory, anchor.value, sharedAnchor))
          .map((anchor) => ({
            filePath: unitOf(inventory, anchor)?.filePath ?? "",
            sourceText: unitOf(inventory, anchor)?.source.sourceText ?? "",
            start: anchor.value.start,
            end: anchor.value.end,
          })),
      };
    },
  };
};
