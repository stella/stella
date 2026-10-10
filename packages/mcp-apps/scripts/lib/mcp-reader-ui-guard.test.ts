import { expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

import readerPackage from "../../../../packages/decision-reader/package.json";
import {
  READER_MESSAGE_KEYS,
  READER_TEMPLATE_KEYS,
} from "../../src/mcp/apps/decision-reader/message-keys";
import {
  inspectMcpReaderUi,
  MCP_READER_UI_APP_DIRECTORIES,
} from "./mcp-reader-ui-guard";

const sharedModule = {
  file: "packages/decision-reader/src/document-ast-text.tsx",
  text: "export const BlockRenderer = () => <p />; export const InlineContent = () => <span />; export const DecisionIdentity = () => <bdi />; export const CourtName = () => <span />;",
};
const astModule = {
  file: "packages/legal-ast/src/document-ast.ts",
  text: 'const schema = { type: v.literal("paragraph") };',
};
const consumer = {
  file: "apps/api/src/mcp/apps/decision-reader/app.tsx",
  text: 'import { BlockRenderer as SharedBlock } from "@stll/decision-reader/document-ast-text"; const App = () => <SharedBlock block={block} />;',
};
const inspectFixture = (
  additionalText: string,
  { includesShared = true, directory = "decision-reader" } = {},
) =>
  inspectMcpReaderUi({
    sharedModules: [sharedModule],
    astModules: [astModule],
    bundleModules: [
      { ...consumer, file: `apps/api/src/mcp/apps/${directory}/app.tsx` },
      ...(includesShared ? [sharedModule] : []),
      {
        file: `apps/api/src/mcp/apps/${directory}/dependency.tsx`,
        text: additionalText,
      },
    ],
  });

test("reachable shared reader component imports pass the ownership guard", () => {
  for (const directory of MCP_READER_UI_APP_DIRECTORIES) {
    expect(inspectFixture("", { directory })).toEqual([]);
  }
});

test("adding a duplicate renderer in a reachable dependency fails the guard", () => {
  expect(inspectFixture("")).toEqual([]);
  for (const text of [
    "const BlockRenderer = () => <p />;",
    "function InlineContent() { return <span />; }",
    "class BlockRenderer {}",
    "const DecisionIdentity = () => <bdi />;",
    "const CourtName = () => <span />;",
  ]) {
    expect(
      inspectFixture(text).some((issue) =>
        issue.includes("duplicates shared reader UI"),
      ),
    ).toBe(true);
  }
});

test("both reader bundles reject duplicates in their reachable dependencies", () => {
  for (const directory of MCP_READER_UI_APP_DIRECTORIES) {
    expect(inspectFixture("", { directory })).toEqual([]);
    expect(
      inspectFixture("const DecisionIdentity = () => <bdi />;", {
        directory,
      }).some((issue) => issue.includes("duplicates shared reader UI")),
    ).toBe(true);
  }
});

test("moving a copied component into another workspace package cannot evade ownership", () => {
  const source = {
    file: "packages/another-reader/src/reader.tsx",
    text: "export const DecisionIdentity = () => <bdi />;",
  };
  expect(
    inspectMcpReaderUi({
      sharedModules: [sharedModule],
      astModules: [astModule],
      bundleModules: [consumer, sharedModule],
    }),
  ).toEqual([]);
  expect(
    inspectMcpReaderUi({
      sharedModules: [sharedModule],
      astModules: [astModule],
      bundleModules: [consumer, sharedModule, source],
    }),
  ).toContain(
    "packages/another-reader/src/reader.tsx: local DecisionIdentity duplicates shared reader UI",
  );
});

test("a package import string cannot replace a reachable renderer", () => {
  expect(inspectFixture("", { includesShared: false })).toContain(
    "Shared document-ast-text renderer is absent from the bundle inputs",
  );
});

test("renaming local legal AST rendering does not bypass ownership", () => {
  for (const text of [
    'const LocalText = ({ block }) => { switch (block.type) { case "paragraph": return <p>{block.text}</p>; } };',
    'const LocalText = ({ block }) => block.type === "paragraph" ? <p>{block.text}</p> : null;',
  ]) {
    expect(
      inspectFixture(text).some((issue) =>
        issue.includes("local legal AST UI"),
      ),
    ).toBe(true);
  }
});

const root = path.resolve(import.meta.dirname, "../../../..");
const generatedRoot = path.join(root, "apps/api/src/mcp/apps/shared/generated");

test("the built reader graph uses the shared package without duplicate UI", async () => {
  const graphs = v.parse(
    v.record(v.string(), v.array(v.string())),
    await Bun.file(path.join(generatedRoot, "reader-inputs.json")).json(),
  );
  const loadModule = async (file: string) => ({
    file,
    text: await Bun.file(path.join(root, file)).text(),
  });
  const readerSourceRoot = "packages/decision-reader/src";
  const sharedFiles = Object.values(readerPackage.exports)
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => path.join(readerSourceRoot, path.basename(file)));
  expect(Object.keys(graphs).toSorted()).toEqual(
    [...MCP_READER_UI_APP_DIRECTORIES].toSorted(),
  );
  const [sharedModules, astModules] = await Promise.all([
    Promise.all(sharedFiles.map(loadModule)),
    Promise.all(
      [
        "packages/legal-ast/src/document-ast.ts",
        "packages/legal-ast/src/inline.ts",
      ].map(loadModule),
    ),
  ]);
  for (const directory of MCP_READER_UI_APP_DIRECTORIES) {
    const inputs = graphs[directory];
    expect(inputs).toBeDefined();
    expect(inputs?.every((file) => /^(?:apps|packages)\//u.test(file))).toBe(
      true,
    );
    if (inputs === undefined) {
      throw new Error(`Missing built reader graph ${directory}`);
    }
    const bundleModules = await Promise.all(
      inputs
        .filter(
          (file) =>
            /\.[cm]?[jt]sx?$/u.test(file) && /^(?:apps|packages)\//u.test(file),
        )
        .map(loadModule),
    );
    expect(
      inspectMcpReaderUi({ sharedModules, astModules, bundleModules }),
    ).toEqual([]);
  }
});

test("reader messages are derived from every web locale without fallback", async () => {
  const generated = v.parse(
    v.record(v.string(), v.record(v.string(), v.string())),
    await Bun.file(path.join(generatedRoot, "reader-messages.json")).json(),
  );
  const localeRoot = path.join(root, "apps/web/src/i18n/langs");
  const files = [
    ...new Bun.Glob("*.json").scanSync({ cwd: localeRoot }),
  ].toSorted();
  expect(Object.keys(generated).toSorted()).toEqual(
    files.map((file) => path.basename(file, ".json")),
  );
  const keys = [
    ...Object.values(READER_MESSAGE_KEYS),
    ...READER_TEMPLATE_KEYS,
  ].toSorted();
  for (const file of files) {
    const locale = path.basename(file, ".json");
    const catalogue: unknown = await Bun.file(
      path.join(localeRoot, file),
    ).json();
    expect(Object.keys(generated[locale] ?? {}).toSorted()).toEqual(keys);
    for (const key of keys) {
      let value = catalogue;
      for (const segment of key.split(".")) {
        expect(typeof value).toBe("object");
        if (typeof value !== "object" || value === null) {
          throw new Error(`Missing locale message ${locale}:${key}`);
        }
        value = Reflect.get(value, segment);
      }
      if (typeof value !== "string") {
        throw new TypeError(`Invalid locale message ${locale}:${key}`);
      }
      expect(generated[locale]?.[key]).toBe(value);
    }
  }
});
