import { expect, test } from "bun:test";

import { normalizeCompatibilityDeclarations } from "./package-api-compatibility";
import { type ApiReport, breakingApiChanges } from "./package-api-report";

const report = (declaration: string) =>
  ({
    package: "@stll/fixture",
    entrypoints: {
      ".": {
        type: "module",
        file: "./src/index.d.ts",
        exports: [{ name: "Client", kind: "type", space: "type" }],
      },
    },
    declarations: {
      "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
    },
  }) as const satisfies ApiReport;

test.each([
  "export interface Client { convert(input: INPUT): string; }",
  "export declare class Client { convert(input: INPUT): string; }",
  "export declare class Client { static convert(input: INPUT): string; }",
  "export type Client = { convert(input: INPUT): string; };",
  "export interface Client { convert?(input: INPUT): string; }",
  "export interface Client { convert<T extends INPUT>(input: T): string; }",
])("method input narrowing is rejected: %s", (declaration) => {
  const broad = report(declaration.replaceAll("INPUT", "string | number"));
  const narrow = report(declaration.replaceAll("INPUT", "string"));
  expect(
    breakingApiChanges({
      before: broad,
      after: narrow,
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("overloaded methods retain every call signature", () => {
  const before = report(
    "export interface Client { convert(input: string): string; convert(input: number): number; }",
  );
  const after = report(
    "export interface Client { convert(input: string): string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("normalization is stable and preserves unchanged overloaded contracts", () => {
  const declaration =
    "export declare class Client { static convert<T extends string>(input: T): T; static convert(input: number): number; optional?(input: string): string; }";
  const normalized = normalizeCompatibilityDeclarations(declaration);
  expect(normalizeCompatibilityDeclarations(normalized)).toBe(normalized);
  expect(
    breakingApiChanges({
      before: report(declaration),
      after: report(normalized),
      packageDir: process.cwd(),
    }),
  ).toEqual([]);
});

test.each([
  "private state: string; private refresh(): void;",
  "#state;",
  "protected state: string; protected refresh(): void;",
  "protected get state(): string; protected set state(value: string);",
])(
  "unrelated additions preserve a class with nonpublic state: %s",
  (members) => {
    const declaration = `export declare class Client { ${members} public read(): string; }`;
    const before = report(declaration);
    const after = report(`${declaration}\nexport declare const added: number;`);
    expect(before.declarations).not.toEqual(after.declarations);
    expect(
      breakingApiChanges({ before, after, packageDir: process.cwd() }),
    ).toEqual([]);
  },
);

test("moving a public class member to protected is visible", () => {
  const before = report("export declare class Client { read(): string; }");
  const after = report(
    "export declare class Client { protected read(): string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining("incompatible"),
    }),
  );
});

test("private constructors retain their construction restriction", () => {
  const normalized = normalizeCompatibilityDeclarations(
    "export declare class Client { private constructor(); private state: string; }",
  );
  expect(normalized).toContain("private constructor()");
  expect(normalized).not.toContain("state");
});

test.each([
  [
    "export interface Client { value?: string; read(): string; }",
    "export interface Client { read(): string; }",
    "removed member value",
  ],
  [
    "export type Client = { value?: string };",
    "export type Client = {};",
    "removed member value",
  ],
  [
    "export interface Client { value: number; }",
    "export interface Client { readonly value: number; }",
    "member value became readonly",
  ],
  [
    "export declare class Client { value: number; }",
    "export declare class Client { get value(): number; }",
    "member value became readonly",
  ],
])("assignable member narrowing is visible: %s", (old, next, message) => {
  expect(
    breakingApiChanges({
      before: report(old),
      after: report(next),
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      type: "signature",
      entrypoint: ".",
      message: expect.stringContaining(message),
    }),
  );
});

test("an optional member removed from an exported value's type is visible", () => {
  const value = (declaration: string) =>
    ({
      ...report(""),
      entrypoints: {
        ".": {
          type: "module",
          file: "./src/index.d.ts",
          exports: [{ name: "options", kind: "value", space: "value" }],
        },
      },
      declarations: {
        "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
      },
    }) as const satisfies ApiReport;
  expect(
    breakingApiChanges({
      before: value("export declare const options: { value?: string };"),
      after: value("export declare const options: {};"),
      packageDir: process.cwd(),
    }),
  ).toContainEqual(
    expect.objectContaining({
      message: expect.stringContaining("removed member value"),
    }),
  );
});

test("adding members and widening readonly to writable stay compatible", () => {
  const before = report("export interface Client { readonly value: number; }");
  const after = report(
    "export interface Client { value: number; extra?: string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toEqual([]);
});

test("two aliases of one namespace are compared against each new target", () => {
  const aliases = (declaration: string) =>
    ({
      ...report(""),
      entrypoints: {
        ".": {
          type: "module",
          file: "./src/index.d.ts",
          exports: [
            { name: "One", kind: "namespace", space: "type+value" },
            { name: "Two", kind: "namespace", space: "type+value" },
          ],
        },
      },
      declarations: {
        "./src/index.d.ts": normalizeCompatibilityDeclarations(declaration),
      },
    }) as const satisfies ApiReport;
  const before = aliases(
    "declare namespace Model { type Input = string; const value = 1; }\nexport { Model as One, Model as Two };\n",
  );
  const after = aliases(
    "declare namespace Model { type Input = string; const value = 1; }\ndeclare namespace Other { const value = 1; }\nexport { Model as One, Other as Two };\n",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }),
  ).toContainEqual(
    expect.objectContaining({
      type: "removal",
      message: expect.stringContaining(".#Two.Input: removed export"),
    }),
  );
});
