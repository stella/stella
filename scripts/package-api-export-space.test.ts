import { expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript6";

import { hasRuntimeExport } from "./package-api-export-space";

const fixture = (index: string, bridge = 'export { Foo } from "./value";') => {
  const root = path.join(process.cwd(), "__api_export_space_fixture__");
  const files = new Map([
    [path.join(root, "index.ts"), index],
    [path.join(root, "bridge.ts"), bridge],
    [
      path.join(root, "value.ts"),
      "export class Foo {}\nexport default Foo;\nexport interface Shape { value: string; }",
    ],
  ]);
  const options = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  const directoryExists = host.directoryExists;
  host.readFile = (file) => files.get(file) ?? readFile(file);
  host.fileExists = (file) => files.has(file) || fileExists(file);
  host.directoryExists = (directory) =>
    directory === root || directoryExists?.(directory) === true;
  const program = ts.createProgram({
    rootNames: [...files.keys()],
    options,
    host,
  });
  const file = path.join(root, "index.ts");
  return (name: string) => hasRuntimeExport({ program, file, name });
};

test.each([
  ['export { Foo } from "./value";', true],
  ['export type { Foo } from "./value";', false],
  ['export { type Foo } from "./value";', false],
  ['export * from "./value";', true],
  ['export type * from "./value";', false],
  ['import { Foo } from "./value"; export { Foo };', true],
  ['import type { Foo } from "./value"; export { Foo };', false],
  ['import { type Foo } from "./value"; export { Foo };', false],
  ['import Foo from "./value"; export { Foo };', true],
  ['import type Foo from "./value"; export { Foo };', false],
] as const)(
  "runtime exports respect type-only edges: %s",
  (source, expected) => {
    expect(fixture(source)("Foo")).toBe(expected);
  },
);

test.each([
  ['export { Foo } from "./value";', true],
  ['export type { Foo } from "./value";', false],
  ['export type * from "./value";', false],
  ['import type { Foo } from "./value"; export { Foo };', false],
] as const)(
  "reexport chains retain their type-only boundary: %s",
  (bridge, expected) => {
    expect(fixture('export * from "./bridge";', bridge)("Foo")).toBe(expected);
  },
);

test.each([
  ['export * as ns from "./value";', true],
  ['export type * as ns from "./value";', false],
  ['import * as ns from "./value"; export { ns };', true],
  ['import type * as ns from "./value"; export { ns };', false],
] as const)(
  "namespace exports retain their runtime space: %s",
  (source, expected) => {
    expect(fixture(source)("ns")).toBe(expected);
  },
);

test("direct declarations distinguish values and types", () => {
  const exported = fixture(
    "export class Foo {}\nexport interface Shape {}\nexport type Input = string;\nexport const count = 1;",
  );
  expect(exported("Foo")).toBe(true);
  expect(exported("count")).toBe(true);
  expect(exported("Shape")).toBe(false);
  expect(exported("Input")).toBe(false);
});

test("cyclic export stars terminate while retaining reachable values", () => {
  const exported = fixture(
    'export * from "./bridge";',
    'export * from "./index"; export { Foo } from "./value";',
  );
  expect(exported("Foo")).toBe(true);
  expect(exported("missing")).toBe(false);
});
