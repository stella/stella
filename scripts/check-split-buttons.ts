#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type JSXAttributeName,
  type JSXChild,
  type JSXElementName,
  type JSXOpeningElement,
  type Node,
  parseSource,
  walk,
} from "../packages/scripts/src/syntax-tree";

const ROOT = path.resolve(import.meta.dir, "..");
const OWNER = "packages/ui/src/components/split-button.tsx";
const TRIGGER = /(?:Menu|Popover)Trigger$/u;
const CHEVRON = /^(?:ChevronDown(?:Icon)?|CaretDown(?:Icon)?)$/u;
// Wrappers a chevron trigger may sit in while still belonging to the
// surrounding control group; any other component owns a separate group.
const TRIGGER_WRAPPER = /^(?:\w*(?:Menu|Popover)(?:Root)?|Tooltip)$/u;

export type SplitButtonFinding = {
  file: string;
  line: number;
  message: string;
};

const opening = (node: Node): JSXOpeningElement | undefined =>
  node.type === "JSXElement" ? node.openingElement : undefined;

const jsxName = (name: JSXElementName | JSXAttributeName): string => {
  if (name.type === "JSXNamespacedName") {
    return `${name.namespace.name}:${name.name.name}`;
  }
  if (name.type === "JSXMemberExpression") {
    return `${jsxName(name.object)}.${name.property.name}`;
  }
  return name.name;
};

const tagName = (node: Node): string | undefined => {
  const element = opening(node);
  return element === undefined ? undefined : jsxName(element.name);
};

/** The node's direct children in source order. */
const childrenOf = (node: Node): Node[] => {
  const children: Node[] = [];
  walk(node, (child) => {
    if (child === node) {
      return undefined;
    }
    children.push(child);
    return "skip-children";
  });
  return children;
};

const FUNCTION_LIKE = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
  "MethodDefinition",
  "TSAbstractMethodDefinition",
  "TSFunctionType",
  "TSConstructorType",
  "TSCallSignatureDeclaration",
  "TSConstructSignatureDeclaration",
  "TSMethodSignature",
  "TSIndexSignature",
]);

const isFunctionLike = (node: Node): boolean =>
  FUNCTION_LIKE.has(node.type) ||
  (node.type === "Property" && (node.method || node.kind !== "init"));

const hasAttribute = (node: Node, name: string): boolean =>
  opening(node)?.attributes.some(
    (attribute) =>
      attribute.type === "JSXAttribute" && jsxName(attribute.name) === name,
  ) ?? false;

const containsPrimaryAction = (
  node: Node,
  localActions: ReadonlySet<string>,
): boolean => {
  const tag = tagName(node);
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
  return childrenOf(node).some((child) =>
    containsPrimaryAction(child, localActions),
  );
};

/** A JSX child that is neither blank text nor an empty `{}`. */
const isMeaningfulChild = (child: Node): boolean =>
  !(child.type === "JSXText" && child.value.trim().length === 0) &&
  !(
    child.type === "JSXExpressionContainer" &&
    child.expression.type === "JSXEmptyExpression"
  );

/** A child that can hold a control: not plain text. */
const isJsxChild = (node: Node): node is JSXChild =>
  node.type === "JSXElement" ||
  node.type === "JSXExpressionContainer" ||
  node.type === "JSXSpreadChild" ||
  node.type === "JSXFragment";

export const findAdHocSplitButtons = (
  file: string,
  content: string,
): SplitButtonFinding[] => {
  if (file === OWNER || !/(?:ChevronDown|CaretDown)/u.test(content)) {
    return [];
  }
  const source = parseSource(file, content);
  const chevrons = new Set<string>();
  const triggers = new Set<string>();
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier") {
        continue;
      }
      const imported =
        specifier.imported.type === "Identifier"
          ? specifier.imported.name
          : specifier.imported.value;
      if (CHEVRON.test(imported)) {
        chevrons.add(specifier.local.name);
      }
      if (TRIGGER.test(imported)) {
        triggers.add(specifier.local.name);
      }
    }
  }
  const containsChevron = (node: Node): boolean => {
    const tag = tagName(node);
    if (tag && (CHEVRON.test(tag) || chevrons.has(tag))) {
      return true;
    }
    return childrenOf(node).some(containsChevron);
  };
  const localActions = new Set<string>();
  const containsAction = (child: Node): boolean => {
    if (child.type === "ReturnStatement") {
      return (
        child.argument !== null &&
        containsPrimaryAction(child.argument, localActions)
      );
    }
    if (isFunctionLike(child)) {
      return false;
    }
    if (opening(child)) {
      return containsPrimaryAction(child, localActions);
    }
    return childrenOf(child).some(containsAction);
  };
  walk(source.program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init?.type === "ArrowFunctionExpression" &&
      containsAction(node.init.body)
    ) {
      localActions.add(node.id.name);
    }
  });
  const hasVisibleLabel = (node: Node): boolean => {
    if (node.type === "JSXText") {
      return node.value.trim().length > 0;
    }
    if (node.type === "JSXExpressionContainer") {
      return (
        node.expression.type !== "JSXEmptyExpression" &&
        hasVisibleLabel(node.expression)
      );
    }
    if (
      node.type === "JSXSpreadChild" ||
      node.type === "ParenthesizedExpression"
    ) {
      return hasVisibleLabel(node.expression);
    }
    if (node.type === "ConditionalExpression") {
      return (
        hasVisibleLabel(node.consequent) || hasVisibleLabel(node.alternate)
      );
    }
    if (node.type === "LogicalExpression" && node.operator === "&&") {
      return hasVisibleLabel(node.right);
    }
    if (node.type === "JSXFragment") {
      return node.children.some(hasVisibleLabel);
    }
    if (node.type !== "JSXElement") {
      return !(
        node.type === "Literal" &&
        (node.value === false || (node.value === null && node.raw === "null"))
      );
    }
    const element = node.openingElement;
    const name = jsxName(element.name);
    if (CHEVRON.test(name) || chevrons.has(name)) {
      return false;
    }
    if (name.endsWith("Icon")) {
      return true;
    }
    if (node.children.some(hasVisibleLabel)) {
      return true;
    }
    // Base UI commonly places the icon inside the render button.
    return element.attributes.some(
      (attribute) =>
        attribute.type === "JSXAttribute" &&
        jsxName(attribute.name) === "render" &&
        attribute.value?.type === "JSXExpressionContainer" &&
        attribute.value.expression.type !== "JSXEmptyExpression" &&
        hasVisibleLabel(attribute.value.expression),
    );
  };
  const findings: SplitButtonFinding[] = [];
  walk(source.program, (node, ancestors) => {
    const tag = tagName(node);
    if (
      !tag ||
      !(TRIGGER.test(tag) || triggers.has(tag)) ||
      !containsChevron(node) ||
      hasVisibleLabel(node)
    ) {
      return;
    }
    let branch = node;
    // Menu/Popover roots, render props and conditionals may sit between the
    // trigger and the layout's child list. Stop at the first adjacent action.
    // The outermost ancestor is the program itself.
    for (let index = ancestors.length - 1; index > 0; index -= 1) {
      const parent = ancestors[index];
      if (parent === undefined) {
        break;
      }
      // A self-closing element has no child list.
      if (
        (parent.type === "JSXElement" && parent.closingElement !== null) ||
        parent.type === "JSXFragment"
      ) {
        const siblings = parent.children.filter(isMeaningfulChild);
        const position = isJsxChild(branch) ? siblings.indexOf(branch) : -1;
        const previous = siblings.at(position - 1);
        if (
          position > 0 &&
          previous &&
          containsPrimaryAction(previous, localActions)
        ) {
          findings.push({
            file,
            line: source.locate(node.start).line,
            message:
              "adjacent primary action and chevron trigger must use SplitButton",
          });
          break;
        }
        const parentTag = tagName(parent);
        if (parentTag && !TRIGGER_WRAPPER.test(parentTag)) {
          break;
        }
      }
      branch = parent;
    }
  });
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
  const source = parseSource(file, content);
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
  const definitions = new Map<string, Node>();
  walk(source.program, (node) => {
    if (node.type === "ImportSpecifier") {
      const imported =
        node.imported.type === "Identifier"
          ? node.imported.name
          : node.imported.value;
      if (imported === "SplitButton") {
        splitButtons.add(node.local.name);
      }
      if (controls.has(imported)) {
        controls.add(node.local.name);
      }
      if (menuItemNames.has(imported)) {
        menuItemAliases.add(node.local.name);
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.init !== null
    ) {
      definitions.set(node.id.name, node.init);
    }
    if (
      node.type === "FunctionDeclaration" &&
      node.id !== null &&
      node.body !== null
    ) {
      definitions.set(node.id.name, node.body);
    }
  });
  const findings: SplitButtonFinding[] = [];
  const inspect = (node: Node, seen: Set<Node>): void => {
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    const tag = tagName(node);
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
        line: source.locate(node.start).line,
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
    // JSX tag and attribute names resolve like any identifier.
    if (node.type === "Identifier" || node.type === "JSXIdentifier") {
      const definition = definitions.get(node.name);
      if (definition) {
        inspect(definition, seen);
      }
    }
    for (const child of childrenOf(node)) {
      inspect(child, seen);
    }
  };
  walk(source.program, (node) => {
    const element = opening(node);
    if (element === undefined || !splitButtons.has(jsxName(element.name))) {
      return;
    }
    const attributeValue = (name: string) => {
      for (const attribute of element.attributes) {
        if (
          attribute.type === "JSXAttribute" &&
          jsxName(attribute.name) === name
        ) {
          return attribute.value ?? undefined;
        }
      }
      return undefined;
    };
    const surface = attributeValue("surface");
    const surfaceValue =
      surface?.type === "JSXExpressionContainer" ? surface.expression : surface;
    const isPopover =
      surfaceValue?.type === "Literal" && surfaceValue.value === "popover";
    const menu = attributeValue("menu");
    if (
      !isPopover &&
      menu?.type === "JSXExpressionContainer" &&
      menu.expression.type !== "JSXEmptyExpression"
    ) {
      inspect(menu.expression, new Set());
    }
  });
  return findings;
};

export const censusSplitButtons = (): SplitButtonFinding[] => {
  const excludedDirectories = new Set([
    "node_modules",
    "coverage",
    "playwright-report",
    "test-results",
    "dist-ssr",
    "out",
    "build",
    "dist",
  ]);
  const files = [
    ...new Bun.Glob("{apps,packages}/**/*.{tsx,jsx}").scanSync({
      cwd: ROOT,
      onlyFiles: true,
      dot: false,
      followSymlinks: false,
    }),
  ]
    .filter((file) =>
      file.split("/").every((part) => !excludedDirectories.has(part)),
    )
    .toSorted();
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
