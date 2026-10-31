import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript6";

import { MCP_APPS } from "@stll/mcp-apps/manifest";

import { inspectAppSources } from "./app-source-guard";

const appRoot = path.resolve(
  import.meta.dirname,
  "../../../../packages/mcp-apps/src",
);

test("every registered app uses the shared bounded viewport", async () => {
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(appRoot)].filter(
    (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
  );
  const sources = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        await Bun.file(path.join(appRoot, file)).text(),
      ]),
    ),
  );
  expect(inspectAppSources(sources)).toEqual([]);
  for (const { directory } of MCP_APPS) {
    const entrypoints = files.filter(
      (file) =>
        /^app\.tsx?$/u.test(path.basename(file)) &&
        path.dirname(file) === directory,
    );
    expect(entrypoints).toHaveLength(1);
    const entrypoint = entrypoints.at(0);
    if (entrypoint === undefined) {
      throw new TypeError(`Missing registered app entrypoint: ${directory}`);
    }
    const reachable = new Set<string>();
    const visit = (file: string) => {
      if (reachable.has(file)) {
        return;
      }
      reachable.add(file);
      const text = sources[file];
      if (text === undefined) {
        throw new TypeError(`Missing app module: ${file}`);
      }
      const module = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of module.statements) {
        if (
          !ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement)
        ) {
          continue;
        }
        const specifier = statement.moduleSpecifier;
        if (
          specifier === undefined ||
          !ts.isStringLiteral(specifier) ||
          !specifier.text.startsWith(".")
        ) {
          continue;
        }
        const imported = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier.text),
        );
        const target = [`${imported}.ts`, `${imported}.tsx`].find(
          (candidate) => sources[candidate] !== undefined,
        );
        if (target !== undefined) {
          visit(target);
        }
      }
    };
    visit(entrypoint);
    expect(reachable.has("shared/size.ts")).toBe(true);
  }
});

test("app size reporting cannot bypass the shared viewport", () => {
  const unsafe = [
    "app.sendSizeChanged({ height: document.body.scrollHeight });",
    'app["sendSizeChanged"]({ height: document.body.scrollHeight });',
    "const { sendSizeChanged } = app;",
    "const { sendSizeChanged: send } = app;",
    'const { ["sendSizeChanged"]: send } = app;',
    "app.setupSizeChangedNotifications();",
    'parent.postMessage({ method: "ui/notifications/size-changed", params: { height: 9000 } }, "*");',
    'parent.postMessage({ method: `ui/notifications/size-changed`, params: { height: 9000 } }, "*");',
  ];
  for (const { directory } of MCP_APPS) {
    const file = `${directory}/app.ts`;
    for (const source of unsafe) {
      expect(inspectAppSources({ [file]: source })).toContain(
        `App size reporting requires the shared viewport: ${file}`,
      );
    }
  }
  expect(inspectAppSources({ "shared/size.ts": unsafe.join("\n") })).toEqual(
    [],
  );
});

test("SDK owners explicitly disable automatic document height reporting", () => {
  for (const file of [
    "shared/bridge.ts",
    "document-upload/runtime.ts",
    "file-comparison/runtime.ts",
  ]) {
    for (const source of [
      "new App(info);",
      "new App(info, {});",
      "new App(info, {}, { autoResize: true });",
      "new App(info, {}, { autoResize: false, ...override });",
      "new App(info, {}, { autoResize: false, autoResize: true });",
    ]) {
      expect(inspectAppSources({ [file]: source })).toContain(
        `App automatic resizing bypasses the shared viewport: ${file}`,
      );
    }
    expect(
      inspectAppSources({
        [file]: "new App(info, {}, { autoResize: false });",
      }),
    ).toEqual([]);
  }
});
