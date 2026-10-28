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
    }).join("\n"),
  ).toContain("incompatible");
});

test("overloaded methods retain every call signature", () => {
  const before = report(
    "export interface Client { convert(input: string): string; convert(input: number): number; }",
  );
  const after = report(
    "export interface Client { convert(input: string): string; }",
  );
  expect(
    breakingApiChanges({ before, after, packageDir: process.cwd() }).join("\n"),
  ).toContain("incompatible");
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
    breakingApiChanges({ before, after, packageDir: process.cwd() }).join("\n"),
  ).toContain("incompatible");
});

test("private constructors retain their construction restriction", () => {
  const normalized = normalizeCompatibilityDeclarations(
    "export declare class Client { private constructor(); private state: string; }",
  );
  expect(normalized).toContain("private constructor()");
  expect(normalized).not.toContain("state");
});
