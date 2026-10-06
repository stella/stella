#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "packages/ui/src/components/split-button.tsx";
const TRIGGER = /(?:Menu|Popover)Trigger$/u;
const CHEVRON = /^(?:ChevronDown(?:Icon)?|CaretDown(?:Icon)?)$/u;

export type SplitButtonFinding = {
  file: string;
  line: number;
  message: string;
};

const opening = (node: ts.Node) => {
  if (ts.isJsxElement(node)) {
    return node.openingElement;
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return node;
  }
  return undefined;
};

const hasAttribute = (node: ts.Node, name: string): boolean =>
  opening(node)?.attributes.properties.some(
    (attribute) =>
      ts.isJsxAttribute(attribute) && attribute.name.getText() === name,
  ) ?? false;

const containsPrimaryAction = (
  node: ts.Node,
  localActions: ReadonlySet<string>,
): boolean => {
  const tag = opening(node)?.tagName.getText();
  if (tag && TRIGGER.test(tag)) {
    return false;
  }
  if (tag && localActions.has(tag)) {
    return true;
  }
  if (tag === "button") {
    return true;
  }
  if (tag?.endsWith("Button")) {
    return hasAttribute(node, "onClick") || hasAttribute(node, "type");
  }
  // A sibling layout container owns a separate control group. Wrappers such
  // as Tooltip and JSX conditionals still belong to the adjacent action.
  if (tag && tag !== "Tooltip") {
    return false;
  }
  return node
    .getChildren()
    .some((child) => containsPrimaryAction(child, localActions));
};

export const findAdHocSplitButtons = (
  file: string,
  content: string,
): SplitButtonFinding[] => {
  if (file === OWNER || !/(?:ChevronDown|CaretDown)/u.test(content)) {
    return [];
  }
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const chevrons = new Set<string>();
  const triggers = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) {
      continue;
    }
    for (const specifier of bindings.elements) {
      const imported = (specifier.propertyName ?? specifier.name).text;
      if (CHEVRON.test(imported)) {
        chevrons.add(specifier.name.text);
      }
      if (TRIGGER.test(imported)) {
        triggers.add(specifier.name.text);
      }
    }
  }
  const containsChevron = (node: ts.Node): boolean => {
    const tag = opening(node)?.tagName.getText();
    if (tag && (CHEVRON.test(tag) || chevrons.has(tag))) {
      return true;
    }
    return node.getChildren().some(containsChevron);
  };
  const localActions = new Set<string>();
  const collectActions = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isArrowFunction(node.initializer)
    ) {
      const containsAction = (child: ts.Node): boolean => {
        if (ts.isReturnStatement(child)) {
          return (
            child.expression !== undefined &&
            containsPrimaryAction(child.expression, localActions)
          );
        }
        if (ts.isFunctionLike(child)) {
          return false;
        }
        if (opening(child)) {
          return containsPrimaryAction(child, localActions);
        }
        return ts.forEachChild(child, containsAction) ?? false;
      };
      if (containsAction(node.initializer.body)) {
        localActions.add(node.name.text);
      }
    }
    ts.forEachChild(node, collectActions);
  };
  collectActions(source);
  const hasVisibleLabel = (node: ts.Node): boolean => {
    if (ts.isJsxText(node)) {
      return node.text.trim().length > 0;
    }
    if (ts.isJsxExpression(node)) {
      return node.expression !== undefined && hasVisibleLabel(node.expression);
    }
    if (ts.isParenthesizedExpression(node)) {
      return hasVisibleLabel(node.expression);
    }
    if (ts.isConditionalExpression(node)) {
      return hasVisibleLabel(node.whenTrue) || hasVisibleLabel(node.whenFalse);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return hasVisibleLabel(node.right);
    }
    if (ts.isJsxFragment(node)) {
      return node.children.some(hasVisibleLabel);
    }
    const element = opening(node);
    if (!element) {
      return (
        node.kind !== ts.SyntaxKind.NullKeyword &&
        node.kind !== ts.SyntaxKind.FalseKeyword
      );
    }
    const name = element.tagName.getText();
    if (CHEVRON.test(name) || chevrons.has(name)) {
      return false;
    }
    if (name.endsWith("Icon")) {
      return true;
    }
    if (ts.isJsxElement(node) && node.children.some(hasVisibleLabel)) {
      return true;
    }
    // Base UI commonly places the icon inside the render button.
    return element.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText() === "render" &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression &&
        hasVisibleLabel(attribute.initializer.expression),
    );
  };
  const findings: SplitButtonFinding[] = [];
  const visit = (node: ts.Node): void => {
    const tag = opening(node)?.tagName.getText();
    if (
      tag &&
      (TRIGGER.test(tag) || triggers.has(tag)) &&
      containsChevron(node) &&
      !hasVisibleLabel(node)
    ) {
      let branch = node;
      // Menu/Popover roots, render props and conditionals may sit between the
      // trigger and the layout's child list. Stop at the first adjacent action.
      while (!ts.isSourceFile(branch.parent)) {
        const parent = branch.parent;
        if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
          const siblings = parent.children.filter(
            (child) =>
              !(ts.isJsxText(child) && child.text.trim().length === 0) &&
              !(ts.isJsxExpression(child) && child.expression === undefined),
          );
          const index =
            ts.isJsxElement(branch) ||
            ts.isJsxSelfClosingElement(branch) ||
            ts.isJsxExpression(branch) ||
            ts.isJsxFragment(branch)
              ? siblings.indexOf(branch)
              : -1;
          const previous = siblings.at(index - 1);
          if (
            index > 0 &&
            previous &&
            containsPrimaryAction(previous, localActions)
          ) {
            findings.push({
              file,
              line:
                source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              message:
                "adjacent primary action and chevron trigger must use SplitButton",
            });
            break;
          }
          const parentTag = opening(parent)?.tagName.getText();
          if (parentTag && /^[a-z]/u.test(parentTag)) {
            break;
          }
        }
        branch = parent;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

/** Menu keyboard navigation only owns menuitems; forms need a popover. */
export const findSplitButtonMenuControls = (
  file: string,
  content: string,
): SplitButtonFinding[] => {
  if (file === OWNER || !content.includes("SplitButton")) {
    return [];
  }
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const splitButtons = new Set(["SplitButton"]);
  const menuItemNames = new Set([
    "MenuItem",
    "MenuCheckboxItem",
    "MenuRadioItem",
    "MenuSubTrigger",
    "DropdownMenuItem",
    "DropdownMenuCheckboxItem",
    "DropdownMenuRadioItem",
    "DropdownMenuSubTrigger",
  ]);
  const menuItemAliases = new Set<string>();
  const controls = new Set([
    "input",
    "textarea",
    "button",
    "Input",
    "Textarea",
    "Button",
  ]);
  const definitions = new Map<string, ts.Node>();
  const collect = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const imported = (node.propertyName ?? node.name).text;
      if (imported === "SplitButton") {
        splitButtons.add(node.name.text);
      }
      if (controls.has(imported)) {
        controls.add(node.name.text);
      }
      if (menuItemNames.has(imported)) {
        menuItemAliases.add(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      definitions.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      definitions.set(node.name.text, node.body);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const findings: SplitButtonFinding[] = [];
  const inspect = (node: ts.Node, seen: Set<ts.Node>): void => {
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    const tag = opening(node)?.tagName.getText();
    if (
      tag &&
      !menuItemAliases.has(tag) &&
      (controls.has(tag) ||
        tag.endsWith("Button") ||
        tag.endsWith("Input") ||
        tag.endsWith("Textarea"))
    ) {
      findings.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        message: `${tag} inside a SplitButton menu requires surface="popover"; menu surfaces contain menuitems`,
      });
      return;
    }
    if (tag) {
      const definition = definitions.get(tag);
      if (definition) {
        inspect(definition, seen);
      }
    }
    if (ts.isIdentifier(node)) {
      const definition = definitions.get(node.text);
      if (definition) {
        inspect(definition, seen);
      }
    }
    ts.forEachChild(node, (child) => inspect(child, seen));
  };
  const visit = (node: ts.Node): void => {
    const element = opening(node);
    if (element && splitButtons.has(element.tagName.getText())) {
      const attributes = element.attributes.properties.filter(
        ts.isJsxAttribute,
      );
      const surface = attributes.find(
        (attribute) => attribute.name.getText() === "surface",
      )?.initializer;
      const surfaceValue =
        surface && ts.isJsxExpression(surface) ? surface.expression : surface;
      const isPopover =
        surfaceValue &&
        ts.isStringLiteral(surfaceValue) &&
        surfaceValue.text === "popover";
      const menu = attributes.find(
        (attribute) => attribute.name.getText() === "menu",
      )?.initializer;
      if (!isPopover && menu && ts.isJsxExpression(menu) && menu.expression) {
        inspect(menu.expression, new Set());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
};

export const censusSplitButtons = (): SplitButtonFinding[] => {
  const files = execFileSync(
    "rg",
    ["--files", "apps", "packages", "-g", "*.tsx", "-g", "*.jsx"],
    { cwd: ROOT, encoding: "utf-8" },
  )
    .trim()
    .split("\n");
  return files.flatMap((file) => {
    const content = readFileSync(path.join(ROOT, file), "utf-8");
    return [
      ...findAdHocSplitButtons(file, content),
      ...findSplitButtonMenuControls(file, content),
    ];
  });
};

if (import.meta.main) {
  const findings = censusSplitButtons();
  for (const { file, line, message } of findings) {
    process.stderr.write(`${file}:${line}: ${message}\n`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "Split-button census: no ad-hoc pairs (allowlist empty).\n",
    );
  }
}
