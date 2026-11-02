import { load } from "cheerio";
import { isText } from "domhandler";
import path from "node:path";

import { type Node, parseSource, walk } from "@stll/scripts/src/syntax-tree";

// Runtime SDK imports and the call primitive stay at these explicit boundaries.
const SDK_OWNERS: ReadonlySet<string> = new Set([
  "shared/bridge.ts",
  "document-upload/runtime.ts",
  "file-comparison/runtime.ts",
]);

const VISIBLE_ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];

export const inspectAppHtmlSources = (
  sources: Readonly<Record<string, string>>,
): string[] => {
  const issues: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const html = load(text);
    html("script, style").remove();
    const report = (value: string) => {
      const normalized = value.replace(/\s+/gu, " ").trim();
      if (normalized === "stella" || !/\p{L}/u.test(normalized)) {
        return;
      }
      issues.push(
        `App HTML copy requires the shared catalog: ${file}: ${normalized}`,
      );
    };
    html("*").each((_, element) => {
      for (const child of html(element).contents()) {
        if (isText(child)) {
          report(child.data);
        }
      }
      for (const attribute of VISIBLE_ATTRIBUTES) {
        const value = html(element).attr(attribute);
        if (value !== undefined) {
          report(value);
        }
      }
    });
  }
  return issues;
};

const stringLiteralText = (node: Node | null | undefined) =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const importSpecifier = (node: Node) => {
  if (
    node.type === "ImportDeclaration" ||
    node.type === "ExportNamedDeclaration" ||
    node.type === "ExportAllDeclaration" ||
    node.type === "TSImportType" ||
    node.type === "ImportExpression"
  ) {
    return stringLiteralText(node.source);
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require"
  ) {
    return stringLiteralText(node.arguments.at(0));
  }
  return undefined;
};

// `{ callServerTool }`, `{ callServerTool: call }`, `{ ...callServerTool }`
// and `[callServerTool]` bindings. Destructuring assignments assign to
// expressions and bind nothing.
const bindsCallServerTool = (node: Node, ancestors: readonly Node[]) => {
  const parent = ancestors.at(-1);
  let bound: Node | undefined;
  if (parent?.type === "ObjectPattern") {
    if (node.type === "Property") {
      bound = node.computed ? undefined : node.key;
    } else if (node.type === "RestElement") {
      bound = node.argument;
    }
  } else if (parent?.type === "ArrayPattern") {
    if (node.type === "AssignmentPattern") {
      bound = node.left;
    } else if (node.type === "RestElement") {
      bound = node.argument;
    } else {
      bound = node;
    }
  }
  if (bound?.type !== "Identifier" || bound.name !== "callServerTool") {
    return false;
  }
  const owner = ancestors.findLast(
    (ancestor) =>
      ancestor.type !== "ObjectPattern" &&
      ancestor.type !== "ArrayPattern" &&
      ancestor.type !== "Property" &&
      ancestor.type !== "AssignmentPattern" &&
      ancestor.type !== "RestElement",
  );
  return (
    owner?.type !== "AssignmentExpression" &&
    owner?.type !== "ForOfStatement" &&
    owner?.type !== "ForInStatement"
  );
};

const importsServerModule = (node: Node, file: string) => {
  const target = importSpecifier(node);
  if (target === undefined) {
    return false;
  }
  if (
    target.startsWith("@/api/") ||
    target === "@stll/api" ||
    target.startsWith("@stll/api/")
  ) {
    return true;
  }
  if (!target.startsWith(".")) {
    return false;
  }
  const resolved = path.posix.normalize(
    path.posix.join("packages/mcp-apps/src", path.posix.dirname(file), target),
  );
  return resolved === "apps/api" || resolved.startsWith("apps/api/");
};

const appMemberName = (node: Node, ancestors: readonly Node[]) => {
  if (node.type === "MemberExpression") {
    if (!node.computed && node.property.type === "Identifier") {
      return node.property.name;
    }
    return stringLiteralText(node.property);
  }
  if (node.type === "Property" && ancestors.at(-1)?.type === "ObjectPattern") {
    if (!node.computed && node.key.type === "Identifier") {
      return node.key.name;
    }
    return stringLiteralText(node.key);
  }
  return undefined;
};

type AppSizingOptions = {
  node: Node;
  ancestors: readonly Node[];
  file: string;
};
const inspectAppSizing = ({ node, ancestors, file }: AppSizingOptions) => {
  const issues: string[] = [];
  const member = appMemberName(node, ancestors);
  if (
    file !== "shared/size.ts" &&
    (member === "sendSizeChanged" ||
      member === "setupSizeChangedNotifications" ||
      stringLiteralText(node) === "ui/notifications/size-changed" ||
      (node.type === "TemplateLiteral" &&
        node.expressions.length === 0 &&
        node.quasis.at(0)?.value.cooked === "ui/notifications/size-changed"))
  ) {
    issues.push(`App size reporting requires the shared viewport: ${file}`);
  }
  if (
    !SDK_OWNERS.has(file) ||
    node.type !== "NewExpression" ||
    node.callee.type !== "Identifier" ||
    node.callee.name !== "App"
  ) {
    return issues;
  }
  const options = node.arguments.at(2);
  const disablesAutoResize =
    options?.type === "ObjectExpression" &&
    options.properties.every((property) => property.type !== "SpreadElement") &&
    options.properties.filter(
      (property) =>
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "autoResize",
    ).length === 1 &&
    options.properties.some(
      (property) =>
        !property.computed &&
        property.key.type === "Identifier" &&
        property.key.name === "autoResize" &&
        property.value.type === "Literal" &&
        property.value.value === false,
    );
  if (!disablesAutoResize) {
    issues.push(`App automatic resizing bypasses the shared viewport: ${file}`);
  }
  return issues;
};

export const inspectAppSources = (
  sources: Readonly<Record<string, string>>,
): string[] => {
  const issues: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (
      /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) ||
      file.endsWith(".d.ts") ||
      /(?:^|\/)tests\//u.test(file) ||
      /(?:^|\/)setup(?:[-.][^/]*)?\.[cm]?[jt]sx?$/u.test(file)
    ) {
      continue;
    }
    walk(parseSource(file, text).program, (node, ancestors) => {
      if (importsServerModule(node, file)) {
        issues.push(`Server modules must stay outside browser apps: ${file}`);
      }
      issues.push(...inspectAppSizing({ node, ancestors, file }));
      if (SDK_OWNERS.has(file)) {
        return;
      }
      const isSdkModule =
        importSpecifier(node)?.startsWith("@modelcontextprotocol/") === true;
      if (
        isSdkModule &&
        (node.type === "ImportExpression" ||
          node.type === "CallExpression" ||
          (node.type === "ImportDeclaration" && node.importKind !== "type") ||
          ((node.type === "ExportNamedDeclaration" ||
            node.type === "ExportAllDeclaration") &&
            node.exportKind !== "type"))
      ) {
        issues.push(`App SDK import requires the shared bridge: ${file}`);
      }
      if (
        (node.type === "MemberExpression" &&
          (node.computed
            ? stringLiteralText(node.property) === "callServerTool"
            : node.property.type === "Identifier" &&
              node.property.name === "callServerTool")) ||
        bindsCallServerTool(node, ancestors)
      ) {
        issues.push(`App calls require the shared bridge: ${file}`);
      }
    });
  }
  return issues;
};
