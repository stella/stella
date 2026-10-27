import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";
import {
  type ParsedSource,
  parseSource,
  walk,
} from "@stll/scripts/src/syntax-tree";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const primitive = path.join(sourceRoot, "components/selection-toolbar.tsx");
const modules = [...new Bun.Glob("**/*.tsx").scanSync({ cwd: sourceRoot })]
  .filter((file) => !file.endsWith(".test.tsx"))
  .map((file) => ({
    file: path.join(sourceRoot, file),
    text: readFileSync(path.join(sourceRoot, file), "utf-8"),
  }));
const resolveImport = (owner: string, specifier: string) =>
  specifier.startsWith("@/")
    ? path.join(sourceRoot, `${specifier.slice(2)}.tsx`)
    : path.resolve(path.dirname(owner), `${specifier}.tsx`);

type ToolbarMount = {
  file: string;
  component: string;
  props: readonly string[];
};
const mountCache = new Map<string, ToolbarMount[]>();
const trees = new Map<string, ParsedSource>();
const mountsOf = (target: string): ToolbarMount[] => {
  const cached = mountCache.get(target);
  if (cached !== undefined) {
    return cached;
  }
  const mounts: ToolbarMount[] = [];
  for (const { file, text } of modules) {
    if (!text.includes(path.basename(target, ".tsx"))) {
      continue;
    }
    const tree = trees.get(file) ?? parseSource(file, text);
    trees.set(file, tree);
    const importedNames = new Set<string>();
    for (const statement of tree.program.body) {
      if (
        statement.type !== "ImportDeclaration" ||
        resolveImport(file, statement.source.value) !== target
      ) {
        continue;
      }
      for (const entry of statement.specifiers) {
        if (entry.type === "ImportSpecifier") {
          importedNames.add(entry.local.name);
        }
      }
    }
    walk(tree.program, (node, ancestors) => {
      if (
        node.type === "JSXOpeningElement" &&
        node.name.type === "JSXIdentifier" &&
        importedNames.has(node.name.name)
      ) {
        let component = "";
        for (const owner of ancestors.toReversed()) {
          // The mounting function owns the toolbar regardless of its exports.
          if (
            owner.type === "VariableDeclarator" &&
            owner.id.type === "Identifier" &&
            owner.init &&
            (owner.init.type === "ArrowFunctionExpression" ||
              owner.init.type === "FunctionExpression")
          ) {
            component = owner.id.name;
            break;
          }
          if (owner.type === "FunctionDeclaration") {
            component = owner.id?.name ?? "";
            break;
          }
        }
        mounts.push({
          file,
          component,
          props: node.attributes.flatMap((attribute) =>
            attribute.type === "JSXAttribute"
              ? [
                  tree.sourceText.slice(
                    attribute.name.start,
                    attribute.name.end,
                  ),
                ]
              : [],
          ),
        });
      }
    });
  }
  mountCache.set(target, mounts);
  return mounts;
};

const wrappers = mountsOf(primitive);
const discoveredHosts = wrappers.flatMap(({ file }) => mountsOf(file));
const hosts = discoveredHosts.filter(
  (host, index) =>
    discoveredHosts.findIndex(
      (candidate) =>
        candidate.file === host.file && candidate.component === host.component,
    ) === index,
);
test("every discovered selection toolbar mount supplies its own clipping boundary", () => {
  expect(wrappers.length).toBeGreaterThan(0);
  // Branches can mount the primitive more than once in the same owner.
  // Compare owners while still checking every primitive mount below.
  const wrapperOwners = wrappers.filter(
    (wrapper, index) =>
      wrappers.findIndex(
        (candidate) =>
          candidate.file === wrapper.file &&
          candidate.component === wrapper.component,
      ) === index,
  );
  expect(hosts.length).toBeGreaterThan(wrapperOwners.length);
  for (const wrapper of wrappers) {
    expect(wrapper.component).not.toBe("");
    expect(wrapper.props).toContain("anchorRect");
    expect(wrapper.props).toContain("boundaryRect");
    const tree = trees.get(wrapper.file);
    expect(tree).toBeDefined();
    const canonicalNames = new Set<string>();
    for (const statement of tree?.program.body ?? []) {
      if (
        statement.type !== "ImportDeclaration" ||
        statement.source.value !== "@/components/selection-toolbar.logic"
      ) {
        continue;
      }
      for (const entry of statement.specifiers) {
        if (
          entry.type === "ImportSpecifier" &&
          (entry.imported.type === "Identifier"
            ? entry.imported.name
            : entry.imported.value) === "selectionToolbarAnchor"
        ) {
          canonicalNames.add(entry.local.name);
        }
      }
    }
    expect(canonicalNames.size).toBeGreaterThan(0);
    let callsSharedAnchor = false;
    if (tree !== undefined) {
      walk(tree.program, (node) => {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          canonicalNames.has(node.callee.name)
        ) {
          callsSharedAnchor = true;
        }
      });
    }
    expect(callsSharedAnchor).toBe(true);
    expect(
      hosts.some((host) =>
        mountsOf(wrapper.file).some((consumer) => consumer.file === host.file),
      ),
    ).toBe(true);
  }
});

for (const host of hosts) {
  test(`${repoRelativePath(sourceRoot, host.file)}: ${host.component} inherits the shared bounded selection toolbar`, () => {
    expect(host.component).not.toBe("");
    expect(
      wrappers.some((wrapper) =>
        mountsOf(wrapper.file).some(
          (consumer) =>
            consumer.file === host.file &&
            consumer.component === host.component,
        ),
      ),
    ).toBe(true);
  });
}
