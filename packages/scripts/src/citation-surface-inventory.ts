import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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

function visit(node: ts.Node, inspect: (node: ts.Node) => void) {
  if (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  ) {
    return;
  }
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}
function nameOf(node: ts.PropertyName) {
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
    : undefined;
}
function ownerOf(node: ts.Node) {
  const owner = ts.findAncestor(
    node,
    (candidate) =>
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      /^[A-Z]/u.test(candidate.name.text),
  );
  return owner && ts.isVariableDeclaration(owner) ? owner : undefined;
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
  const sourcePaths = [
    ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: sourceRoot }),
  ]
    .filter(
      (file) =>
        !/\.(?:test|spec|gen)\./u.test(file) && !file.includes("__fixtures__"),
    )
    .map((file) => path.join(sourceRoot, file));

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
    sourceRoot,
    units,
    references: new Map<ts.Node, ts.Node[]>(),
    incoming: new Map<ts.Node, Map<string, ts.Node[]>>(),
    indexed: false,
  };
}
function unitOf(inventory: Inventory, node: ts.Node) {
  return inventory.units.get(node.getSourceFile().fileName);
}
function resolveModule(inventory: Inventory, from: ts.Node, module: string) {
  let base: string;
  if (module.startsWith("@/")) {
    base = path.join(inventory.sourceRoot, module.slice(2));
  } else if (module.startsWith(".")) {
    base = path.resolve(path.dirname(from.getSourceFile().fileName), module);
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
): ts.Node | undefined {
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
}
function valueOf(
  inventory: Inventory,
  identifier: ts.Identifier,
): ts.Node | undefined {
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
}
function isReference(node: ts.Identifier) {
  return (
    !(
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node
    ) &&
    !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
    !ts.isImportSpecifier(node.parent)
  );
}
function referencesOf(inventory: Inventory, node: ts.Node) {
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
}
function reaches(
  inventory: Inventory,
  node: ts.Node,
  terminal: (imported: Imported) => boolean,
  seen = new Set<ts.Node>(),
): boolean {
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
function location(inventory: Inventory, node: ts.Node) {
  return `${path.relative(inventory.sourceRoot, node.getSourceFile().fileName)}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}
function componentChildren(inventory: Inventory, root: ts.Node) {
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
}
function indexIncoming(inventory: Inventory) {
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
}
function provenance(
  inventory: Inventory,
  root: ts.Node,
  seen = new Set<ts.Node>(),
): boolean {
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
}
function markdownValues(inventory: Inventory) {
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
}
function checkInventory(inventory: Inventory) {
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
        failures.push(
          `Bypassing markdown anchor at ${location(inventory, anchor)}`,
        );
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
            `Missing shared markdown anchor at ${location(inventory, opening)}`,
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
          .filter((anchor) =>
            reaches(inventory, anchor.initializer, sharedAnchor),
          )
          .map((anchor) => ({
            filePath: anchor.getSourceFile().fileName,
            sourceText: anchor.getSourceFile().text,
            start: anchor.initializer.getStart(),
            end: anchor.initializer.getEnd(),
          })),
      };
    },
  };
};
