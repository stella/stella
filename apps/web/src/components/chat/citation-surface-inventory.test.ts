import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sourcePaths = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE_ROOT }),
]
  .filter(
    (file) =>
      !/\.(?:test|spec|gen)\./u.test(file) && !file.includes("__fixtures__"),
  )
  .map((file) => path.join(SOURCE_ROOT, file));

type Imported = { module: string; name: string };
type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;
type Unit = {
  source: ts.SourceFile;
  imports: Map<string, Imported>;
  values: Map<string, ts.Node[]>;
  openings: Opening[];
  anchors: ts.PropertyAssignment[];
};
type Inventory = ReturnType<typeof createInventory>;

const visit = (node: ts.Node, inspect: (node: ts.Node) => void) => {
  if (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return;
  }
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
};
const nameOf = (node: ts.PropertyName) =>
  ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
const ownerOf = (node: ts.Node) => {
  const owner = ts.findAncestor(
    node,
    (candidate) =>
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      /^[A-Z]/u.test(candidate.name.text),
  );
  return owner && ts.isVariableDeclaration(owner) ? owner : undefined;
};
const createInventory = (
  overrides: ReadonlyMap<string, string> = new Map(),
  previous?: { units: ReadonlyMap<string, Unit> },
) => {
  const units = new Map<string, Unit>();
  for (const file of sourcePaths) {
    const existing = previous?.units.get(file);
    if (existing && !overrides.has(file)) {
      units.set(file, existing);
      continue;
    }
    const source = ts.createSourceFile(
      file,
      overrides.get(file) ?? readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const unit: Unit = {
      source,
      imports: new Map(),
      values: new Map(),
      openings: [],
      anchors: [],
    };
    visit(source, (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const item of bindings.elements) {
            unit.imports.set(item.name.text, {
              module: node.moduleSpecifier.text,
              name: (item.propertyName ?? item.name).text,
            });
          }
        }
      }
      if (
        (ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer) ||
        (ts.isFunctionDeclaration(node) && node.name && node.body)
      ) {
        const key = node.name.getText();
        const values = unit.values.get(key) ?? [];
        values.push(node);
        unit.values.set(key, values);
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        unit.openings.push(node);
      }
      if (ts.isPropertyAssignment(node) && nameOf(node.name) === "a") {
        unit.anchors.push(node);
      }
    });
    units.set(file, unit);
  }
  return {
    units,
    references: new Map<ts.Node, ts.Node[]>(),
    incoming: new Map<ts.Node, Map<string, ts.Node[]>>(),
    indexed: false,
  };
};
const unitOf = (inventory: Inventory, node: ts.Node) =>
  inventory.units.get(node.getSourceFile().fileName);
const resolveModule = (inventory: Inventory, from: ts.Node, module: string) => {
  let base: string;
  if (module.startsWith("@/")) {
    base = path.join(SOURCE_ROOT, module.slice(2));
  } else if (module.startsWith(".")) {
    base = path.resolve(path.dirname(from.getSourceFile().fileName), module);
  } else {
    return undefined;
  }
  return (
    inventory.units.get(`${base}.tsx`) ?? inventory.units.get(`${base}.ts`)
  );
};
const exportOf = (
  inventory: Inventory,
  unit: Unit,
  name: string,
  seen = new Set<Unit>(),
): ts.Node | undefined => {
  if (seen.has(unit)) {
    return undefined;
  }
  seen.add(unit);
  const local = unit.values.get(name)?.at(0);
  if (local) {
    return local;
  }
  for (const statement of unit.source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveModule(
      inventory,
      statement,
      statement.moduleSpecifier.text,
    );
    if (!target) {
      continue;
    }
    if (!statement.exportClause) {
      const value = exportOf(inventory, target, name, seen);
      if (value) {
        return value;
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      const item = statement.exportClause.elements.find(
        (entry) => entry.name.text === name,
      );
      if (item) {
        return exportOf(
          inventory,
          target,
          (item.propertyName ?? item.name).text,
          seen,
        );
      }
    }
  }
  return undefined;
};
const valueOf = (
  inventory: Inventory,
  identifier: ts.Identifier,
): ts.Node | undefined => {
  const unit = unitOf(inventory, identifier);
  if (!unit) {
    return undefined;
  }
  const imported = unit.imports.get(identifier.text);
  const target =
    imported && resolveModule(inventory, identifier, imported.module);
  if (target) {
    return exportOf(inventory, target, imported.name);
  }
  return unit.values
    .get(identifier.text)
    ?.filter((value) => {
      const scope = ts.findAncestor(value, ts.isFunctionLike);
      return (
        !scope || (scope.pos <= identifier.pos && scope.end >= identifier.end)
      );
    })
    .toSorted((left, right) => left.end - left.pos - (right.end - right.pos))
    .at(0);
};
const isReference = (node: ts.Identifier) =>
  !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
  !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
  !ts.isImportSpecifier(node.parent);
const referencesOf = (inventory: Inventory, node: ts.Node) => {
  const known = inventory.references.get(node);
  if (known) {
    return known;
  }
  const values = new Set<ts.Node>();
  visit(node, (child) => {
    if (!ts.isIdentifier(child) || !isReference(child)) {
      return;
    }
    const value = valueOf(inventory, child);
    if (value && value !== node) {
      values.add(value);
    }
    if (
      ts.isCallExpression(child.parent) &&
      child.parent.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      return;
    }
  });
  // Lazy markdown wrappers are linked to the module's exports, not to arbitrary
  // runtime imports used by the component's hooks or inspector dependencies.
  visit(node, (child) => {
    if (
      !ts.isCallExpression(child) ||
      child.expression.kind !== ts.SyntaxKind.ImportKeyword
    ) {
      return;
    }
    const specifier = child.arguments.at(0);
    const target =
      specifier && ts.isStringLiteral(specifier)
        ? resolveModule(inventory, child, specifier.text)
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
};
const reaches = (
  inventory: Inventory,
  node: ts.Node,
  terminal: (imported: Imported) => boolean,
  seen = new Set<ts.Node>(),
): boolean => {
  if (seen.has(node)) {
    return false;
  }
  seen.add(node);
  const importedValues: Imported[] = [];
  visit(node, (child) => {
    if (!ts.isIdentifier(child) || !isReference(child)) {
      return;
    }
    const imported = unitOf(inventory, child)?.imports.get(child.text);
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
};
const sharedAnchor = ({ module, name }: Imported) =>
  module === "@/components/chat/streamdown-mention-link" &&
  name === "StreamdownMentionLink";
const resolver = ({ module, name }: Imported) =>
  module === "@stll/api-contract/legal-citation-links" &&
  name === "resolveLegalCitationLinks";
const streamdown = ({ module, name }: Imported) =>
  module === "streamdown" && name === "Streamdown";
const location = (node: ts.Node) =>
  `${path.relative(SOURCE_ROOT, node.getSourceFile().fileName)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

const componentChildren = (inventory: Inventory, root: ts.Node) => {
  const nodes = new Set<ts.Node>();
  const inspect = (node: ts.Node) => {
    if (nodes.has(node)) {
      return;
    }
    nodes.add(node);
    visit(node, (child) => {
      if (
        (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) &&
        ts.isIdentifier(child.tagName)
      ) {
        const value = valueOf(inventory, child.tagName);
        if (value) {
          inspect(value);
        }
      }
    });
  };
  inspect(root);
  return nodes;
};
const indexIncoming = (inventory: Inventory) => {
  if (inventory.indexed) {
    return;
  }
  inventory.indexed = true;
  for (const unit of inventory.units.values()) {
    for (const opening of unit.openings) {
      if (!ts.isIdentifier(opening.tagName)) {
        continue;
      }
      const value = valueOf(inventory, opening.tagName);
      if (!value) {
        continue;
      }
      const props =
        inventory.incoming.get(value) ?? new Map<string, ts.Node[]>();
      for (const attribute of opening.attributes.properties) {
        if (
          !ts.isJsxAttribute(attribute) ||
          !attribute.initializer ||
          !ts.isJsxExpression(attribute.initializer) ||
          !attribute.initializer.expression
        ) {
          continue;
        }
        const values = props.get(attribute.name.getText()) ?? [];
        values.push(attribute.initializer.expression);
        props.set(attribute.name.getText(), values);
      }
      inventory.incoming.set(value, props);
    }
  }
};
const provenance = (
  inventory: Inventory,
  root: ts.Node,
  seen = new Set<ts.Node>(),
): boolean => {
  if (seen.has(root)) {
    return false;
  }
  seen.add(root);
  if (reaches(inventory, root, resolver)) {
    return true;
  }
  const owner = ownerOf(root);
  if (!owner) {
    return false;
  }
  const names = new Set<string>();
  visit(root, (node) => {
    if (ts.isIdentifier(node) && isReference(node)) {
      names.add(node.text);
    }
  });
  let found = false;
  visit(owner, (node) => {
    if (
      !ts.isBindingElement(node) ||
      !ts.isIdentifier(node.name) ||
      !names.has(node.name.text) ||
      !ts.isParameter(node.parent.parent)
    ) {
      return;
    }
    const key = node.propertyName ? nameOf(node.propertyName) : node.name.text;
    if (key) {
      found ||= (inventory.incoming.get(owner)?.get(key) ?? []).some((value) =>
        provenance(inventory, value, seen),
      );
    }
  });
  return found;
};
const markdownValues = (inventory: Inventory) => {
  const owners = new Set<ts.Node>();
  const edges = new Map<ts.Node, Set<ts.Node>>();
  for (const unit of inventory.units.values()) {
    for (const values of unit.values.values()) {
      for (const value of values) {
        const children = new Set<ts.Node>();
        visit(value, (node) => {
          if (
            (ts.isJsxOpeningElement(node) ||
              ts.isJsxSelfClosingElement(node)) &&
            ts.isIdentifier(node.tagName)
          ) {
            const imported = unitOf(inventory, node)?.imports.get(
              node.tagName.text,
            );
            if (imported && streamdown(imported)) {
              owners.add(value);
            }
            const child = valueOf(inventory, node.tagName);
            if (child) {
              children.add(child);
            }
          }
          if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword
          ) {
            const specifier = node.arguments.at(0);
            const target =
              specifier && ts.isStringLiteral(specifier)
                ? resolveModule(inventory, node, specifier.text)
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
};
const checkInventory = (inventory: Inventory) => {
  const hosts: Opening[] = [];
  const failures: string[] = [];
  const anchors: ts.PropertyAssignment[] = [];
  const trays = new Set<ts.Node>();
  const wrappers = markdownValues(inventory);
  for (const unit of inventory.units.values()) {
    // Anchor maps are a renderer contract. Derive every object-literal `a`
    // override, including maps returned by hooks and passed through props.
    for (const anchor of unit.anchors) {
      anchors.push(anchor);
      if (!reaches(inventory, anchor.initializer, sharedAnchor)) {
        failures.push(`Bypassing markdown anchor at ${location(anchor)}`);
      }
    }
    for (const opening of unit.openings) {
      if (!ts.isIdentifier(opening.tagName)) {
        continue;
      }
      const imported = unit.imports.get(opening.tagName.text);
      const value = valueOf(inventory, opening.tagName);
      if (imported && streamdown(imported)) {
        hosts.push(opening);
        const components = opening.attributes.properties.find(
          (item) =>
            ts.isJsxAttribute(item) && item.name.getText() === "components",
        );
        if (!components || !reaches(inventory, components, sharedAnchor)) {
          failures.push(
            `Missing shared markdown anchor at ${location(opening)}`,
          );
        }
      } else if (value && wrappers.has(value)) {
        hosts.push(opening);
      }
      if (imported?.module === "@/components/chat/source-chips" && value) {
        for (const child of componentChildren(inventory, value)) {
          trays.add(child);
        }
      }
    }
  }
  indexIncoming(inventory);
  const sinks: ts.Node[] = [];
  for (const tray of trays) {
    visit(tray, (node) => {
      if (
        !ts.isJsxAttribute(node) ||
        node.name.getText() !== "href" ||
        !ts.isJsxAttributes(node.parent) ||
        node.parent.parent.tagName.getText() !== "a"
      ) {
        return;
      }
      sinks.push(node);
      if (!provenance(inventory, node)) {
        failures.push(`Bypassing source-tray anchor at ${location(node)}`);
      }
    });
  }
  const source = inventory.units.get(
    path.join(SOURCE_ROOT, "components/chat/streamdown-mention-link.tsx"),
  );
  const anchor = source && exportOf(inventory, source, "StreamdownMentionLink");
  if (!anchor || !reaches(inventory, anchor, resolver)) {
    failures.push("Shared markdown anchor does not reach the legal resolver");
  }
  return { hosts, anchors, sinks, failures };
};

describe("chat citation surface ownership", () => {
  test("all discovered markdown overrides and source sinks use the shared legal resolver", () => {
    const result = checkInventory(createInventory());
    expect(result.hosts.length).toBeGreaterThan(0);
    expect(result.anchors.length).toBeGreaterThan(0);
    expect(result.sinks.length).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
  test("a plain anchor override cannot silently bypass citation navigation", () => {
    const inventory = createInventory();
    const anchor = checkInventory(inventory).anchors.find((item) =>
      reaches(inventory, item.initializer, sharedAnchor),
    );
    expect(anchor).toBeDefined();
    if (!anchor) {
      return;
    }
    const source = anchor.getSourceFile();
    const mutated = `${source.text.slice(0, anchor.initializer.getStart())}(props) => <a {...props} />${source.text.slice(anchor.initializer.getEnd())}`;
    const result = checkInventory(
      createInventory(new Map([[source.fileName, mutated]]), inventory),
    );
    expect(
      result.failures.some((failure) =>
        failure.startsWith("Bypassing markdown anchor"),
      ),
    ).toBe(true);
  });
});
