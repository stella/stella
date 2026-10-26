import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type CallExpression,
  type IdentifierReference,
  parseSource,
  type StaticMemberExpression,
  walk,
} from "@stll/scripts/src/syntax-tree.ts";

const E2E_ROOT = path.resolve(import.meta.dirname, "..");
const READINESS_LIFECYCLES = new Set(["commit", "domcontentloaded"]);
// Every `page.*` call that starts a navigation, mapped to the argument index
// carrying its options: `goto` takes (url, options); reload and the history
// navigations take (options) alone. History navigations count because they
// default to the `load` lifecycle exactly like `goto` does.
const NAVIGATION_OPTIONS_INDEX = new Map([
  ["goBack", 0],
  ["goForward", 0],
  ["goto", 1],
  ["reload", 0],
]);

test("route navigation waits for an explicit lifecycle before UI readiness", async () => {
  const violations = (
    await Promise.all((await specFiles(E2E_ROOT)).map(navigationViolations))
  ).flat();

  expect(violations).toEqual([]);
});

const specFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return await specFiles(entryPath);
        }
        if (
          entry.name.endsWith(".spec.ts") ||
          entry.name.endsWith(".spec.tsx")
        ) {
          return [entryPath];
        }
        return [];
      }),
    )
  ).flat();
};

const navigationViolations = async (filePath: string): Promise<string[]> => {
  const sourceText = await readFile(filePath, "utf-8");
  const source = parseSource(filePath, sourceText);
  const violations: string[] = [];

  walk(source.program, (node) => {
    if (node.type === "CallExpression" && isPageNavigation(node)) {
      const lifecycle = navigationLifecycle(node, sourceText);
      if (!READINESS_LIFECYCLES.has(lifecycle ?? "")) {
        const { line } = source.locate(node.start);
        violations.push(
          `${repoRelativePath(E2E_ROOT, filePath)}:${line} uses ${
            node.callee.property.name
          } without waitUntil: "commit" or "domcontentloaded"`,
        );
      }
    }
  });
  return violations;
};

type PageNavigationCall = CallExpression & {
  callee: StaticMemberExpression & { object: IdentifierReference };
};

const isPageNavigation = (call: CallExpression): call is PageNavigationCall =>
  call.callee.type === "MemberExpression" &&
  !call.callee.computed &&
  call.callee.property.type === "Identifier" &&
  call.callee.object.type === "Identifier" &&
  call.callee.object.name === "page" &&
  NAVIGATION_OPTIONS_INDEX.has(call.callee.property.name);

const navigationLifecycle = (
  call: PageNavigationCall,
  sourceText: string,
): string | null => {
  const options = call.arguments.at(
    NAVIGATION_OPTIONS_INDEX.get(call.callee.property.name) ?? 0,
  );
  if (options?.type !== "ObjectExpression") {
    return null;
  }
  // The first `waitUntil: value` entry; shorthand, methods, accessors and
  // computed keys never name it.
  const waitUntil = options.properties.find(
    (property) =>
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.shorthand &&
      !property.computed &&
      sourceText.slice(property.key.start, property.key.end) === "waitUntil",
  );
  if (waitUntil?.type !== "Property") {
    return null;
  }
  return waitUntil.value.type === "Literal" &&
    typeof waitUntil.value.value === "string"
    ? waitUntil.value.value
    : null;
};
